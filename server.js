const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const JSZip     = require('jszip');
const WebSocket = require('ws');

// SQLite (better-sqlite3) — Fase 1 da migração JSON → SQL (ver README,
// seção "Banco de Dados (SQLite)"). Por enquanto só cria o banco/schema;
// nenhuma rota usa isto ainda — segue tudo lendo/escrevendo os JSONs de
// public/db/ exatamente como antes, até cada fase ser migrada de verdade.
const db = require('./db.js');
const logger = require('./lib/logger');
const dispositivoCookie = require('./lib/dispositivo-cookie');

// ─── HORÁRIO DE BRASÍLIA + UTILITÁRIO GENÉRICO — Fase 19 do fatiamento ────
// todayBrasiliaServer/horaMinutoBrasiliaServer/numOuNulo agora vivem em
// lib/tempo.js (última fase do plano, ver README, "Fatiamento de server.js"
// → "Plano de continuidade"). Precisa vir bem no topo — numOuNulo é usado
// logo abaixo pelas próprias rotas ainda não extraídas deste arquivo, e
// todayBrasiliaServer/horaMinutoBrasiliaServer são injetadas em
// notificacoesPush poucas linhas depois.
const { todayBrasiliaServer, horaMinutoBrasiliaServer, numOuNulo } = require('./lib/tempo.js');

const PORT = process.env.PORT || 5000; // env var facilita rodar testes numa porta separada
// HOST: por padrão só escuta em localhost (127.0.0.1) — quando há um
// reverse proxy na frente (Caddy, ver deploy/instalar-https.sh), ninguém
// de fora consegue bater direto em IP-EXTERNO:PORTA, só passando pelo
// HTTPS do proxy; o próprio Caddy, rodando na mesma máquina, continua
// alcançando normal via "localhost:PORTA" no Caddyfile. Pra voltar ao
// comportamento antigo (aceitar conexão de qualquer interface — útil só
// em rede local sem proxy na frente, nunca com IP público exposto), defina
// HOST=0.0.0.0 no ambiente.
const HOST = process.env.HOST || '127.0.0.1';
const ROOT_DIR = __dirname; // raiz do projeto — usado pelo backup geral
const DIR = path.join(__dirname, 'public');
const DB_DIR = path.join(DIR, 'db'); // arquivos-de-dados (JSON usados como "banco")

// ─── security.json mora FORA de public/ — Fase 17 do fatiamento, ver README ──
// PRIVATE_DIR/SECURITY_PATH, a garantia de que private/ existe, e a migração
// automática de public/db/security.json (instalação antiga) agora vivem em
// lib/security-json.js. Precisa vir ANTES de tudo que usa PRIVATE_DIR ou
// SECURITY_PATH logo abaixo (auth.js, USUARIOS_PATH, PERFIS_CUSTOMIZADOS_PATH,
// as factories de perfis customizados/overrides/notificações, e a rota de
// autenticação lá embaixo).
const { PRIVATE_DIR, SECURITY_PATH } = require('./lib/security-json.js')({ fs, path, ROOT_DIR, DB_DIR });
// Cadastro de usuários com login+senha+perfil (ver lib/rotas/usuarios.js,
// lib/perfis.js) — mesmo motivo de segurança: contém senhaHash por
// usuário, e um arquivo dentro de public/db/ seria servido cru pela rota
// estática genérica pra qualquer um que soubesse a URL (foi exatamente o
// problema histórico de security.json — ver README, "Limitações
// conhecidas"). GET /usuarios (lib/rotas/usuarios.js) nunca devolve
// senhaHash, só {id, nomeUsuario, perfil}.
const USUARIOS_PATH = path.join(PRIVATE_DIR, 'usuarios.json');
// Perfis customizados (ver lib/perfis-customizados.js) — cada usuário
// cadastrado pode referenciar um destes por id. Precisa entrar no Backup
// Geral JUNTO com usuarios.json: restaurar um usuarios.json sem também
// restaurar os perfis customizados que ele referencia deixa usuário(s)
// "órfão(s)" (perfil que não existe mais em lugar nenhum), travando
// qualquer tentativa de cadastrar/remover OUTRO usuário depois (ver
// POST /salvar-usuarios, lib/rotas/usuarios.js).
const PERFIS_CUSTOMIZADOS_PATH = path.join(PRIVATE_DIR, 'perfis-customizados.json');

// Autenticação do Administrador (hash de senha + rate limiting de
// tentativas) — extraído pra lib/auth.js (ver esse arquivo pros detalhes
// e comentários originais; aqui só instanciamos e usamos).
const auth = require('./lib/auth.js')(SECURITY_PATH, db);

// Sessão de Administrador (token em cookie HttpOnly) — extraído pra
// lib/sessao.js. Cobre as 2 rotas que não tinham proteção própria nenhuma
// antes desta mudança: GET /db/security.json e POST /salvar-security.
const sessao = require('./lib/sessao.js')(db);

// Sessão de USUÁRIO CADASTRADO (Operador/Analista/Qualidade/Manutenção/
// Administrativo — ver lib/perfis.js) — diferente de `sessao` acima, que é
// só pro Administrador Master (senha única mestra). Ver lib/sessao-usuario.js.
const sessaoUsuario = require('./lib/sessao-usuario.js')(db);

// Mapa central de permissões por perfil (o que cada um vê e o que pode
// EDITAR) — ver lib/perfis.js. Usado tanto por GET /perfis (front monta o
// menu e esconde controles de edição) quanto por validações no servidor
// (rotas de escrita de cada domínio).
const perfis = require('./lib/perfis.js');

// Catálogo de itens permissionáveis (páginas, dashboards, sub-itens,
// "Outros", abas de Configurações — ver lib/itens-permissao.js) e o
// módulo que guarda os perfis CRIADOS pelo Administrador em Configurações
// → Usuários → "+ Criar novo tipo de perfil" (ver
// lib/perfis-customizados.js) — somam-se aos 6 perfis fixos acima, nunca
// os substituem.
const itensPermissao = require('./lib/itens-permissao.js');
const perfisCustomizados = require('./lib/perfis-customizados.js')({ fs, path, PRIVATE_DIR, perfis, itensPermissao });

// Overrides item-a-item pros 6 perfis FIXOS (voltou — ver conversa que
// motivou a mudança: engrenagem ⚙️ ao lado do campo "Perfil" em
// Configurações → Usuários). Sem override pra um perfil = comportamento
// HARDCODED de lib/perfis.js normalmente; com override, o mapa salvo aqui
// manda — ver podeEditarArea() e podeControlarOperacao(), abaixo, que
// consultam isto ANTES de cair no hardcoded.
const perfisFixosOverrides = require('./lib/perfis-fixos-overrides.js')({ fs, path, PRIVATE_DIR, itensPermissao });

// Notificações push (ver lib/notificacoes-push.js) — "toda vez que um
// chamado for aberto, quem tem a permissão 'Notificar Abertura de
// Chamado' marcada no perfil é notificado" (PC e celular, via Web
// Push/PWA). Depende de perfis/perfisCustomizados/perfisFixosOverrides
// (acima) pra resolver, na hora de notificar, quem tem a permissão
// marcada — mesma cascata fixo/override/customizado de podeEditarArea.
const notificacoesPush = require('./lib/notificacoes-push.js')({
  fs, path, PRIVATE_DIR, db, perfis, perfisCustomizados, perfisFixosOverrides, itensPermissao,
  // Injetados também pro job do lembrete diário de manutenção programada
  // (ver executarLembreteManutencaoProgramadaSeNecessario,
  // lib/notificacoes-push.js) — mesmas funções de relógio já usadas pelo
  // backup automático, importadas de lib/tempo.js lá no topo deste arquivo.
  todayBrasiliaServer, horaMinutoBrasiliaServer,
});

// ─── PERMISSÕES DE ÁREA / MANUTENÇÃO — Fase 16 do fatiamento, ver README ──
// podeEditarArea/negarEdicao/temPoderesDeAdmin/sessaoOuAdmin/
// podeExcluirChamado/nomeDeQuemAceita/nomeParaVisualizacao/
// podeEditarAberturaChamado/podeAceitarChamado/podeAceitarPedidoPeca/
// podeRenotificarManutencao/podeConfirmarRecebimentoPeca agora vivem em
// lib/permissoes-area.js. Precisa vir ANTES das factories logo abaixo
// (inclusive a de Dispositivo Autorizado, que já usa podeEditarArea) —
// mesma posição de sempre, logo após sessao/sessaoUsuario/perfis/
// perfisFixosOverrides/perfisCustomizados já definidos.
const {
  podeEditarArea,
  negarEdicao,
  temPoderesDeAdmin,
  sessaoOuAdmin,
  podeUsarItem,
  negarAcesso,
  podeExcluirChamado,
  nomeDeQuemAceita,
  nomeParaVisualizacao,
  podeEditarAberturaChamado,
  podeAceitarChamado,
  podeAceitarPedidoPeca,
  podeRenotificarManutencao,
  podeConfirmarRecebimentoPeca,
} = require('./lib/permissoes-area.js')({ sessao, sessaoUsuario, perfis, perfisFixosOverrides, perfisCustomizados });

// ─── CERTIFICADO DE DISPOSITIVO (mTLS) — ver lib/certificado-dispositivo.js ──
// Camada ADICIONAL de reconhecimento de dispositivo, em paralelo ao cookie
// HttpOnly + fallback por IP que já existiam (não substitui nenhum dos
// dois) — resolve o caso de limpar TODOS os dados do navegador, via
// certificado de cliente TLS instalado uma vez por máquina (Configurações
// → Dispositivos Autorizados → "Gerar certificado"). Precisa vir ANTES de
// dispositivo-autorizado.js, que consome `certificadoDispositivo` abaixo.
const certificadoDispositivo = require('./lib/certificado-dispositivo.js')({ fs, path, DB_DIR, PRIVATE_DIR });

// ─── DISPOSITIVO AUTORIZADO — Fase 12 do fatiamento, ver README ───────────
// lerDispositivosAutorizados/salvarDispositivosAutorizados/
// dispositivoAutorizado/podeControlarOperacao/negarControleDeOperacao agora
// vivem em lib/dispositivo-autorizado.js — extraído por ser o ponto de
// maior concorrência entre PRs do que sobrava aqui (chamado ao mesmo tempo
// por registro-operacao.js, operacao-andamento.js e contador-tracos.js).
// Precisa vir ANTES das factories logo abaixo, que já usam essas funções.
const {
  lerDispositivosAutorizados,
  salvarDispositivosAutorizados,
  dispositivoAutorizado,
  podeControlarOperacao,
  negarControleDeOperacao,
} = require('./lib/dispositivo-autorizado.js')({ fs, path, DB_DIR, sessao, sessaoUsuario, perfis, podeEditarArea, certificadoDispositivo });

// ─── WEBSOCKET BROADCAST — Fase 13 do fatiamento, ver README ─────────────
// _enviarWsParaTodos/broadcastOperacaoAndamento/broadcastOperacaoFinalizada/
// broadcastLeituraAutomatica/broadcastDadosSqlExcluidos agora vivem em
// lib/websocket-broadcast.js. Precisa vir ANTES das factories logo abaixo,
// que já usam essas funções. A conexão WebSocket em si (`wss`) só é criada
// mais adiante (depende do `server` HTTP) — por isso o wiring de
// clientesOperacaoAndamento fica encapsulado no módulo (adicionarCliente/
// removerCliente/getRevisaoAtual), chamado de dentro de wss.on('connection',
// ...) lá embaixo.
const wsBroadcast = require('./lib/websocket-broadcast.js')({ WebSocket });
const {
  broadcastOperacaoAndamento,
  broadcastOperacaoFinalizada,
  broadcastLeituraAutomatica,
  broadcastDadosSqlExcluidos,
} = wsBroadcast;

// ─── OPERAÇÃO EM ANDAMENTO (estado em disco) — Fase 14 do fatiamento ──────
// lerOperacaoAndamento/salvarOperacaoAndamentoNoDisco/lerBercosAndamento/
// salvarBercosAndamentoNoDisco agora vivem em
// lib/operacao-andamento-estado.js — mesmos quatro consumidores do item 12
// (registro-operacao.js, operacao-andamento.js, contador-tracos.js, e o
// snapshot inicial de wss.on('connection', ...) aqui embaixo). Precisa vir
// ANTES das factories logo abaixo, que já usam essas funções.
const {
  lerOperacaoAndamento,
  salvarOperacaoAndamentoNoDisco,
  lerBercosAndamento,
  salvarBercosAndamentoNoDisco,
} = require('./lib/operacao-andamento-estado.js')({ fs, path, DB_DIR });

// ─── FILA DE AVALIAÇÃO (não avaliadas) — Fase 15 do fatiamento ───────────
// lerOperacoesNaoAvaliadas/salvarOperacoesNaoAvaliadasNoDisco/
// adicionarNaFilaNaoAvaliadas/removerDaFilaNaoAvaliadas/
// recalcularFilaNaoAvaliadasApartirDoSql/migrarFilaNaoAvaliadasSeNecessario
// agora vivem em lib/fila-avaliacao.js — compartilhado entre qualidade.js e
// registro-operacao.js (mais sql-admin.js e backup.js). Precisa vir ANTES
// das factories logo abaixo, que já usam essas funções. A chamada de
// migrarFilaNaoAvaliadasSeNecessario() continua lá embaixo, depois das
// migrações do db.js (ver comentário perto dessa chamada) — só a definição
// da função mudou de lugar, não quando ela roda.
const {
  lerOperacoesNaoAvaliadas,
  salvarOperacoesNaoAvaliadasNoDisco,
  adicionarNaFilaNaoAvaliadas,
  removerDaFilaNaoAvaliadas,
  recalcularFilaNaoAvaliadasApartirDoSql,
  migrarFilaNaoAvaliadasSeNecessario,
} = require('./lib/fila-avaliacao.js')({ fs, path, DB_DIR, db, logger });

// ─── FILA DE REGISTRO OFFLINE (PWA) — item 5 do plano, ver README ─────────
// adicionarNaFilaOffline (e o resto de lib/fila-offline.js) — fila
// SEPARADA da de avaliação, acima: guarda os envios de
// POST /operacao-offline/enviar (sem sessão, sem login) até alguém com
// perfil Administrador aprovar (item 6 do plano — ainda não implementado).
const { adicionarNaFilaOffline, buscarPorIdTemp, atualizarNaFilaOffline, removerDaFilaOffline, lerFilaOffline } = require('./lib/fila-offline.js')({ fs, path, DB_DIR });

// Rate limiting por IP da rota acima (README, item 5: "proteção mínima, já
// que a rota não tem sessão") — genérico (lib/rate-limit-ip.js), persistido
// num JSON próprio em PRIVATE_DIR (sobrevive a restart do processo, mesmo
// raciocínio de lib/auth.js pro rate limit de senha, só que sem precisar
// de tabela SQL pra um volume de chamadas tão baixo). 20 envios em 15
// minutos por IP é folgado pro uso legítimo (no máximo um pendente por
// DISPOSITIVO por vez — ver README, item 3 — mas nada impede vários
// dispositivos atrás do mesmo IP/NAT numa fábrica) e ainda barra abuso.
const rateLimitOffline = require('./lib/rate-limit-ip.js')({
  fs, logger, dominioLog: 'operacao-offline',
  caminhoArquivo: path.join(PRIVATE_DIR, 'rate-limit-operacao-offline.json'),
  maxTentativas: 20, janelaMs: 15 * 60 * 1000, bloqueioMs: 15 * 60 * 1000,
});

// ─── MODO DE TESTE + CONTADOR DE TRAÇOS DO DIA (estado) — Fase 18, ver README ──
// dirParaModoTeste/lerContadorTracosHoje/incrementarContadorTracosHoje agora
// vivem em lib/contador-tracos-estado.js. Precisa vir ANTES das factories
// logo abaixo, que já usam essas funções (rotasSobra, rotasContadorTracos,
// rotasLeituraEAjustes, rotasRegistroOperacao, rotasBackup). Depende de
// todayBrasiliaServer, importada de lib/tempo.js lá no topo deste arquivo
// (Fase 19, ver README) — não depende mais de hoisting de function
// declaration, é um valor de verdade já disponível neste ponto.
const {
  dirParaModoTeste,
  lerContadorTracosHoje,
  incrementarContadorTracosHoje,
} = require('./lib/contador-tracos-estado.js')({ fs, path, DB_DIR, db, todayBrasiliaServer });

// ── Fatias de rotas extraídas pra lib/rotas/ (ver esse arquivo pro padrão
// seguido) — cada uma é uma factory que recebe só as dependências que
// aquele domínio usa, e devolve uma função tentar(req,res,urlPath) que
// devolve true se já respondeu. Chamadas em sequência dentro do
// http.createServer, abaixo, antes das rotas que ainda não foram
// extraídas (ver o loop logo no início do callback).
const rotasUsuarios = require('./lib/rotas/usuarios.js')({ fs, path, PRIVATE_DIR, auth, sessao: sessaoOuAdmin, sessaoUsuario, perfis, perfisCustomizados, perfisFixosOverrides, itensPermissao });
const rotasPerfisCustomizados = require('./lib/rotas/perfis-customizados.js')({ fs, path, PRIVATE_DIR, sessao: sessaoOuAdmin, perfisCustomizados, itensPermissao });
const rotasParadas = require('./lib/rotas/paradas.js')({ db, podeEditarArea, negarEdicao });
const rotasManutencao = require('./lib/rotas/manutencao.js')({
  db, podeEditarArea, negarEdicao, podeExcluirChamado,
  podeEditarAberturaChamado, podeAceitarChamado, podeAceitarPedidoPeca,
  podeRenotificarManutencao, podeConfirmarRecebimentoPeca, nomeDeQuemAceita,
  nomeParaVisualizacao, notificarAberturaChamado: notificacoesPush.notificarAberturaChamado,
  notificarPedidoPeca: notificacoesPush.notificarPedidoPeca,
  notificarPecaRecebida: notificacoesPush.notificarPecaRecebida,
  notificarManutencaoProgramada: notificacoesPush.notificarManutencaoProgramada,
  notificarAceiteChamado: notificacoesPush.notificarAceiteChamado,
  notificarAtualizacaoChamadoCorretivo: notificacoesPush.notificarAtualizacaoChamadoCorretivo,
  notificarAtualizacaoManutencaoProgramada: notificacoesPush.notificarAtualizacaoManutencaoProgramada,
});
const rotasNotificacoes = require('./lib/rotas/notificacoes.js')({ db, notificacoesPush, nomeDeQuemAceita });
const rotasQualidade = require('./lib/rotas/qualidade.js')({ db, lerOperacoesNaoAvaliadas, removerDaFilaNaoAvaliadas, podeEditarArea, negarEdicao });
const rotasSqlAdmin = require('./lib/rotas/sql-admin.js')({ db, sessao: sessaoOuAdmin, adicionarNaFilaNaoAvaliadas, broadcastDadosSqlExcluidos });
const rotasConsultas = require('./lib/rotas/consultas.js')({ db });
const rotasExportarPdf = require('./lib/rotas/exportar-pdf.js')({ db, PRIVATE_DIR, sessaoUsuario, sessao, notificarPdfPronto: notificacoesPush.notificarPdfPronto });
const rotasSobra = require('./lib/rotas/sobra.js')({ db, fs, path, dirParaModoTeste, podeEditarArea, negarEdicao });
// Registro de Traço Descartado (Perda) — passo 2 do plano, ver README.
const rotasTracosDescartados = require('./lib/rotas/tracos-descartados.js')({ db, podeEditarArea, negarEdicao });
// Ocorrências de Segurança — Fase 1 do plano do One Page Report (ver
// README, "Nova página: One Page Report (planejamento)"). `sessao:
// sessaoOuAdmin` (não `podeEditarArea`) de propósito — ver comentário de
// PERMISSÃO DE ESCRITA no topo de lib/rotas/seguranca.js.
const rotasSeguranca = require('./lib/rotas/seguranca.js')({ db, todayBrasiliaServer, sessao: sessaoOuAdmin });
// Cargas de Expedição — Fase 2 do plano do One Page Report (ver README,
// "Nova página: One Page Report (planejamento)"). Mesma decisão de
// PERMISSÃO DE ESCRITA da Fase 1 — ver comentário no topo de
// lib/rotas/expedicao.js.
const rotasExpedicao = require('./lib/rotas/expedicao.js')({ db, todayBrasiliaServer, sessao: sessaoOuAdmin });
// Comentários do One Page Report — Fase 3 do plano (ver README). Módulo de
// dados PRÓPRIO (JSON simples em DB_DIR, não a conexão SQLite de db.js) —
// ver comentário no topo de lib/db/one-page-comentarios.js.
const comentariosOnePageReport = require('./lib/db/one-page-comentarios.js')({ fs, path, DB_DIR });
// `dbSql`/`todayBrasiliaServer` — Fase 4 do plano (endpoint de agregação,
// GET /db/one-page-report.json): junta Segurança/Expedição (SQLite) com
// Produção/Refugo (também SQLite, tabelas "operacoes"/"avaliacao_paineis"/
// "traco_usos") e Comentários (`comentarios`, acima). Ver comentário de
// FASE 4 no topo de lib/rotas/one-page-report.js.
const rotasOnePageReport = require('./lib/rotas/one-page-report.js')({
  comentarios: comentariosOnePageReport, sessao: sessaoOuAdmin, dbSql: db, todayBrasiliaServer,
});
const rotasContadorTracos = require('./lib/rotas/contador-tracos.js')({ lerContadorTracosHoje, incrementarContadorTracosHoje, podeControlarOperacao, negarControleDeOperacao });
const rotasLogAcesso = require('./lib/rotas/log-acesso.js')({ fs, path, ROOT_DIR });
const rotasOperacaoAndamento = require('./lib/rotas/operacao-andamento.js')({
  sessao: sessaoOuAdmin, lerOperacaoAndamento, salvarOperacaoAndamentoNoDisco, broadcastOperacaoAndamento,
  lerBercosAndamento, salvarBercosAndamentoNoDisco, podeControlarOperacao, negarControleDeOperacao,
});
const rotasAutenticacao = require('./lib/rotas/autenticacao.js')({ fs, path, DB_DIR, SECURITY_PATH, auth, sessao });
const rotasDispositivosAutorizados = require('./lib/rotas/dispositivos-autorizados.js')({ fs, path, DB_DIR, sessao: sessaoOuAdmin });
const rotasCertificadosDispositivo = require('./lib/rotas/certificados-dispositivo.js')({ sessao: sessaoOuAdmin, certificadoDispositivo });
const rotasImportacao = require('./lib/rotas/importacao.js')({ db, podeUsarItem, negarAcesso, numOuNulo });
const rotasLeituraEAjustes = require('./lib/rotas/leitura-e-ajustes.js')({ fs, path, db, DB_DIR, dirParaModoTeste, broadcastLeituraAutomatica });
const rotasEdicao = require('./lib/rotas/edicao.js')({ db, podeEditarArea, negarEdicao, numOuNulo });
const rotasRegistroOperacao = require('./lib/rotas/registro-operacao.js')({
  db, fs, path, dirParaModoTeste,
  podeControlarOperacao, negarControleDeOperacao,
  lerBercosAndamento, salvarBercosAndamentoNoDisco,
  adicionarNaFilaNaoAvaliadas, broadcastOperacaoFinalizada,
});
// Backup Automático no Google Drive (ver README, "Backup Automático no
// Google Drive") — googleDrive (lib/google-drive.js) fala com o Google via
// fetch nativo (sem dependência nova); backupDriveJson (lib/backup-drive-
// json.js) guarda a credencial da conta conectada em
// private/backup-drive.json (mesmo raciocínio de segurança de
// SECURITY_PATH/USUARIOS_PATH: nunca dentro de public/db/). BACKUP_DRIVE_PATH
// entra na lista de exclusões do Backup Geral (ver VALIDADORES_BACKUP_GERAL,
// lib/rotas/backup.js) — o refreshToken guardado ali é reversível (ao
// contrário dos hashes de senha), então um backup não deve incluí-lo.
const googleDrive = require('./lib/google-drive.js')();
const backupDriveJson = require('./lib/backup-drive-json.js')({ fs, path, PRIVATE_DIR });
const rotasBackupDrive = require('./lib/rotas/backup-drive.js')({ sessao: sessaoOuAdmin, podeUsarItem, negarAcesso, auth, googleDrive, backupDriveJson });

const rotasBackup = require('./lib/rotas/backup.js')({
  db, fs, path, JSZip,
  ROOT_DIR, DB_DIR, SECURITY_PATH, USUARIOS_PATH, PERFIS_CUSTOMIZADOS_PATH,
  auth, podeUsarItem, negarAcesso,
  todayBrasiliaServer, horaMinutoBrasiliaServer,
  lerContadorTracosHoje, recalcularFilaNaoAvaliadasApartirDoSql,
  googleDrive, backupDriveJson,
});
// Registro de Operação Offline (PWA) — itens 5, 6 e 7 do plano, ver README.
// POST /operacao-offline/enviar é sem sessão (não tem como exigir login
// numa rota pensada pra quando não há rede pra logar); as demais
// (pendentes/corrigir/validar/recusar) exigem sessaoOuAdmin.
const rotasOperacaoOffline = require('./lib/rotas/operacao-offline.js')({
  adicionarNaFilaOffline, buscarPorIdTemp, atualizarNaFilaOffline, removerDaFilaOffline, lerFilaOffline,
  rateLimitOffline, logger, sessao: sessaoOuAdmin, db,
  adicionarNaFilaNaoAvaliadas, incrementarContadorTracosHoje,
});
const ROTAS_EXTRAIDAS = [rotasUsuarios, rotasPerfisCustomizados, rotasParadas, rotasManutencao, rotasNotificacoes, rotasQualidade, rotasSqlAdmin, rotasConsultas, rotasExportarPdf, rotasSobra, rotasTracosDescartados, rotasSeguranca, rotasExpedicao, rotasOnePageReport, rotasContadorTracos, rotasLogAcesso, rotasOperacaoAndamento, rotasAutenticacao, rotasDispositivosAutorizados, rotasCertificadosDispositivo, rotasImportacao, rotasLeituraEAjustes, rotasEdicao, rotasRegistroOperacao, rotasBackup.tentar, rotasBackupDrive.tentar, rotasOperacaoOffline];

// Migração automática Fase 2 (ver db.js) — só faz algo na primeira vez
// que sobe com a tabela "operacoes" vazia E historico.json ainda existir
// com esse nome exato; depois disso é sempre um no-op rápido (1 SELECT
// COUNT(*) + 1 fs.existsSync).
db.migrarHistoricoSeNecessario(DB_DIR);
// Fase 3 — mesmo critério, pra paradas.json.
db.migrarParadasSeNecessario(DB_DIR);
// Fase 4 — mesmo critério, pra sobra.json e contador_tracos.json.
db.migrarSobraSeNecessario(DB_DIR);
db.migrarContadorTracosSeNecessario(DB_DIR);
// Fase 5 — mesmo critério, pra relatorio_injecao.json + ajustes_tracos.json
// (a mais complexa; depende da Fase 2 já ter rodado, pra "operacoes" já
// existir quando os usos forem conferidos — por isso vem por último).
db.migrarRelatorioInjecaoSeNecessario(DB_DIR);

// Migração da fila de avaliação (ver lib/fila-avaliacao.js) — precisa vir
// DEPOIS das migrações do db.js acima: recalcula a partir de "operacoes"/
// "operacoes_avaliadas", que só existem depois delas.
migrarFilaNaoAvaliadasSeNecessario();

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.key':  'text/plain',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  // Ícones do PWA (ver public/icons/, manifest.json) — sem isso, o
  // servidor devolvia qualquer .png como 'text/plain' (fallback,
  // abaixo), e o navegador não reconhece esses arquivos como ícone.
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ─── HORÁRIO DE BRASÍLIA — ver lib/tempo.js (Fase 19) ─────────────────────
// _agoraServer/todayBrasiliaServer/horaMinutoBrasiliaServer agora vivem lá
// (require no topo deste arquivo, logo após numOuNulo). LW_TEST_RELOGIO_ISO
// continua sendo a mesma variável de ambiente de sempre — só a definição de
// _agoraServer() que a lê mudou de lugar, não o comportamento.

// ─── MODO DE TESTE + CONTADOR DE TRAÇOS DO DIA (estado) — Fase 18, ver README ──
// dirParaModoTeste/lerContadorTracosHoje/incrementarContadorTracosHoje agora
// vivem em lib/contador-tracos-estado.js (require logo acima, junto das
// outras factories que precisam vir ANTES de serem usadas — ver
// const { dirParaModoTeste, ... } = require('./lib/contador-tracos-estado.js')(...)
// perto de rotasSobra, mais acima).

// ─── OPERAÇÃO EM ANDAMENTO: transmissão em tempo real (WebSocket) ─────────
// lerOperacaoAndamento/salvarOperacaoAndamentoNoDisco (e, mais abaixo,
// lerBercosAndamento/salvarBercosAndamentoNoDisco) agora vivem em
// lib/operacao-andamento-estado.js — Fase 14 do fatiamento, ver README →
// "Fatiamento de server.js" → "Plano de continuidade". Import logo após
// DB_DIR estar definido, no topo do arquivo (ver
// const operacaoAndamentoEstado = require(...), perto do topo).

// ─── FILA DE AVALIAÇÃO (Setor de Qualidade): "não avaliadas" ──────────────
// lerOperacoesNaoAvaliadas/salvarOperacoesNaoAvaliadasNoDisco/
// adicionarNaFilaNaoAvaliadas/removerDaFilaNaoAvaliadas/
// recalcularFilaNaoAvaliadasApartirDoSql/migrarFilaNaoAvaliadasSeNecessario
// agora vivem em lib/fila-avaliacao.js — Fase 15 do fatiamento, ver README →
// "Fatiamento de server.js" → "Plano de continuidade". Import logo após
// DB_DIR/db/logger já definidos, no topo do arquivo (ver
// const filaAvaliacao = require(...), perto do topo). A CHAMADA de
// migrarFilaNaoAvaliadasSeNecessario() continua aqui embaixo, logo depois
// das migrações do db.js (ver comentário junto a essa chamada) — só a
// função mudou de lugar, não quando ela roda.

// ─── BERÇOS DA OPERAÇÃO EM ANDAMENTO: "baixou/vazou" marcado ao vivo ──────
// lerBercosAndamento/salvarBercosAndamentoNoDisco agora vivem em
// lib/operacao-andamento-estado.js — ver nota da Fase 14, acima.

// ─── LOG DE ACESSO ──────────────────────────────────────────────────────────
// Registra cada acesso a rotas "sensíveis" do app (por enquanto, só
// "Registrar Operação" — ver POST /registrar-acesso, mais abaixo) com
// ip + user-agent (capturados aqui, de fontes confiáveis do próprio
// request) e deviceId (gerado e persistido no navegador de quem acessou).
// Base pra, no futuro, restringir quem pode registrar operação a um único
// computador. Cresce sem limite por enquanto — sem rotina de limpeza
// automática (mesma ressalva já documentada pra backups-seguranca/).
//
// Fica em logs/, FORA de public/ — diferente dos arquivos de public/db/
// (que são servidos como arquivo estático comum, ex: /db/security.json
// funciona por URL direta — ver "Limitações conhecidas" no README), aqui
// o IP de quem acessa não pode ficar visível pra qualquer um que souber a
// URL. Pasta criada na hora (mkdirSync) se ainda não existir.
const DIR_LOGS = path.join(ROOT_DIR, 'logs');
const ACESSOS_PATH = path.join(DIR_LOGS, 'acessos.json');



const server = http.createServer((req, res) => {

  // Extrai o caminho (pathname) da URL e os parâmetros de query (ex:
  // ?deviceId=... — usado tanto pra identificar o "dono" da operação em
  // andamento (ver donoDeviceId em lib/rotas/operacao-andamento.js) QUANTO
  // de novo pra AUTORIZAÇÃO de dispositivo (ver dispositivoAutorizado() e
  // podeControlarOperacao(), acima) — controlar operações agora exige
  // sessão de usuário válida E dispositivo autorizado, as duas juntas;
  // ?modoTeste=true — usado pelo Toggle de Teste em Registrar Operação,
  // ver dirParaModoTeste(), lib/contador-tracos-estado.js).
  const [urlPath, queryString] = req.url.split('?');
  const queryParams = new URLSearchParams(queryString || '');
  const deviceId = queryParams.get('deviceId') || '';
  const modoTeste = queryParams.get('modoTeste') === 'true';

  // ─── Cookie de identidade do dispositivo (ver lib/dispositivo-cookie.js) ─
  // Resolve (ou cria) o deviceId "seguro" deste navegador. Quando o cookie
  // já existe, ele passa a valer como a identidade real do dispositivo pra
  // TODAS as rotas abaixo (sobrescrevendo aqui mesmo o valor de
  // queryParams.get('deviceId') — cada rota extraída continua lendo
  // normalmente de queryParams, sem precisar saber que isso existe), porque
  // é uma fonte que o JavaScript do navegador não controla (diferente do
  // deviceId antigo, mandado pelo próprio cliente via query string a
  // partir do localStorage). Quando o cookie AINDA não existe (primeira
  // visita deste navegador, ou um cliente que não guarda cookies — ex: os
  // testes automatizados, de propósito), cai no valor antigo (query
  // string) sem quebrar nada — e um Set-Cookie é enfileirado pra essa
  // resposta, pra da próxima vez em diante já valer o cookie.
  const deviceIdCookieExistente = dispositivoCookie.deviceIdDoCookie(req);
  const deviceIdGeradoAgora = deviceIdCookieExistente ? null : dispositivoCookie.gerarDeviceId();
  const novoCookieDispositivo = deviceIdGeradoAgora ? dispositivoCookie.criarCookieDeviceId(deviceIdGeradoAgora) : null;
  if (deviceIdCookieExistente) {
    queryParams.set('deviceId', deviceIdCookieExistente);
  }
  if (novoCookieDispositivo) {
    const writeHeadOriginal = res.writeHead.bind(res);
    res.writeHead = (statusCode, headers) => {
      headers = headers || {};
      const existenteHeader = headers['Set-Cookie'];
      headers['Set-Cookie'] = existenteHeader
        ? [].concat(existenteHeader, novoCookieDispositivo)
        : novoCookieDispositivo;
      return writeHeadOriginal(statusCode, headers);
    };
  }

  // ─── /db/*.json NUNCA pode ser servido do cache do navegador ───────────
  // Mesmo raciocínio do bloco de Cache-Control lá embaixo (fallback de
  // arquivo estático) — mas aplicado ANTES das rotas extraídas
  // (ROTAS_EXTRAIDAS, abaixo). A maioria dos arquivos sob /db/ hoje não é
  // mais servida daquele fallback: foi migrada pra rotas dinâmicas que
  // reconstroem o conteúdo do SQLite a cada chamada (ver lib/rotas/
  // qualidade.js, consultas.js etc.) e respondem sozinhas com
  // `res.writeHead(200, {'Content-Type': 'application/json'})`, sem
  // Cache-Control nenhum — perdendo, sem querer, a mesma proteção que
  // tinha sido criada pra isso (ver comentário do fallback, abaixo: "sem
  // cabeçalho de cache nenhum... mudanças salvas não aparecem nem com
  // F5"). Sintoma real que motivou esta correção: corrigir a data de
  // desmoldagem de uma avaliação atualizava Relatório/Dashboard na hora,
  // mas o Debriefing (public/js/debriefing.js, fetch direto de
  // 'db/avaliacoes_qualidade.json', sem cache:'no-store') continuava
  // mostrando a data antiga mesmo fechando/reabrindo — o navegador
  // reaproveitava a resposta em cache em vez de ir à rede de novo.
  // (Debriefing depois passou a usar a MESMA rota do Dashboard —
  // /avaliacoes-qualidade, ver debriefing.js — mas o /db/*.json
  // continua usado por historico.json/relatorio_injecao.json e pelo
  // Backup de Dados, então este patch continua necessário.)
  // Um único monkey-patch aqui (mesmo padrão do Set-Cookie, acima) cobre
  // TODA rota de /db/ de uma vez, sem precisar editar cada módulo de rota
  // individualmente nem torcer pra ninguém esquecer o header numa rota
  // nova.
  if (urlPath.startsWith('/db/')) {
    const writeHeadOriginalDb = res.writeHead.bind(res);
    res.writeHead = (statusCode, headers) => {
      headers = headers || {};
      headers['Cache-Control'] = 'no-store';
      return writeHeadOriginalDb(statusCode, headers);
    };
  }

  // ─── Limite de tamanho de corpo (POST) ─────────────────────────────────
  // Nenhuma rota abaixo tinha limite nenhum — cada uma só acumula
  // `req.on('data', chunk => body += chunk)` até o 'end', sem nenhum teto.
  // Um POST com um corpo gigante (intencional ou não) ficaria inteiro em
  // memória, sem nenhuma defesa. 50MB é generoso o bastante pro Backup
  // Geral/Restaurar Geral (a rota que de longe manda o maior payload —
  // projeto inteiro em JSON), mas ainda assim finito. Não substitui a
  // leitura de cada rota — só corta a conexão mais cedo se ela passar do
  // limite, antes de o corpo inteiro acumular em memória.
  //
  // EXCEÇÃO: POST /exportar-pdf/iniciar (lib/rotas/exportar-pdf.js) manda
  // o HTML inteiro já renderizado no cliente — Análise Focada
  // "Personalizada"/"Do Dia" cobrindo muitas operações (relatado em
  // produção: 162 avaliações já estourava os 50MB, mesmo sem fotos —
  // berços/receita/traços reaproveitados/avaliação de qualidade por
  // operação somam bastante em texto puro quando são muitas). Só esta
  // rota ganha um teto bem mais alto — as demais continuam em 50MB, sem
  // motivo pra afrouxar a proteção onde ela não é necessária.
  const MAX_BODY_BYTES_PADRAO = 50 * 1024 * 1024;
  const MAX_BODY_BYTES_EXPORTAR_PDF = 300 * 1024 * 1024;
  const MAX_BODY_BYTES = urlPath === '/exportar-pdf/iniciar' ? MAX_BODY_BYTES_EXPORTAR_PDF : MAX_BODY_BYTES_PADRAO;
  if (req.method === 'POST') {
    let _bytesRecebidos = 0;
    let _corpoAbortado = false;
    req.on('data', (chunk) => {
      _bytesRecebidos += chunk.length;
      if (!_corpoAbortado && _bytesRecebidos > MAX_BODY_BYTES) {
        _corpoAbortado = true;
        const mbLimite = Math.round(MAX_BODY_BYTES / (1024 * 1024));
        // BUG CORRIGIDO (relatado em produção: cliente via só
        // "TypeError: Failed to fetch", sem NENHUMA mensagem de erro
        // legível, exatamente quando o corpo passava do limite): antes,
        // `req.destroy()` era chamado logo depois de `res.end(...)`, sem
        // esperar a resposta terminar de sair — como request/resposta
        // compartilham a MESMA conexão TCP, isso podia derrubar o socket
        // ANTES do 413 (com a mensagem de erro certinha) chegar de
        // verdade ao navegador, que só via a conexão cair no meio, sem
        // corpo de resposta nenhum. Agora `req.destroy()` só roda DEPOIS
        // que `res.end()` confirma (via callback) que a resposta já foi
        // escrita por completo — a pessoa recebe a mensagem clara
        // primeiro, o socket só fecha depois.
        try {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: `Corpo da requisição excede o limite permitido (${mbLimite}MB).` }), () => {
            req.destroy();
          });
        } catch (_) {
          // resposta pode já ter sido enviada por outra checagem — ainda
          // assim garante que a conexão não fica presa recebendo dados à
          // toa pra sempre.
          req.destroy();
        }
      }
    });
  }

  // GET /meu-device-id — devolve o deviceId "seguro" (cookie HttpOnly)
  // deste navegador em JSON. Necessário porque HttpOnly, por definição,
  // não pode ser lido pelo JavaScript do navegador — esta rota existe só
  // pra a tela Configurações → Dispositivos Autorizados conseguir MOSTRAR
  // o ID pro Administrador copiar/autorizar (ver getDeviceId() em
  // public/js/data.js). Não abre brecha nenhuma: quem decide se um
  // dispositivo está autorizado continua sendo sempre o valor real do
  // cookie no request (ver dispositivoAutorizado()/podeControlarOperacao,
  // acima) — o que o cliente FAZ com o valor devolvido aqui não afeta essa
  // checagem.
  if (req.method === 'GET' && urlPath === '/meu-device-id') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deviceId: deviceIdCookieExistente || deviceIdGeradoAgora }));
    return;
  }

  // ─── Rotas extraídas pra lib/rotas/ (ver ROTAS_EXTRAIDAS, acima) ───────
  // Tentadas ANTES das rotas ainda inline abaixo — cada módulo devolve
  // `true` se já respondeu (encerra aqui) ou `false` se essa requisição
  // não é dele (segue tentando o próximo módulo, e por fim as rotas
  // ainda-não-extraídas mais abaixo). Corpo grande já foi validado acima
  // (o teto de 50MB vale pra QUALQUER rota, extraída ou não). queryParams
  // é passado a todos (mesmo os módulos que não usam — um argumento a
  // mais que a função não declara é só ignorado pelo JS).
  for (const modulo of ROTAS_EXTRAIDAS) {
    if (modulo(req, res, urlPath, queryParams)) return;
  }

  // Rota INTERNA só pra testes automatizados (ver
  // test/manutencao-programada-lembrete.test.js) — dispara na hora o job
  // do lembrete diário (normalmente só chamado pelo setInterval de 60s
  // ou no boot, ver server.listen abaixo), pra não precisar esperar até
  // 1 minuto de verdade em cada teste. SÓ existe (registrada) quando
  // LW_TEST_RELOGIO_ISO está setada (mesma variável que já congela o
  // relógio do servidor, ver _agoraServer() em lib/tempo.js) — nunca ativa numa
  // instalação normal (`npm start`), então nunca é uma rota alcançável
  // em produção.
  if (process.env.LW_TEST_RELOGIO_ISO && req.method === 'POST' && urlPath === '/__test__/executar-lembrete-programada') {
    notificacoesPush.executarLembreteManutencaoProgramadaSeNecessario().then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Servir arquivos estáticos normalmente
  let filePath = path.join(DIR, urlPath === '/' ? 'login.html' : urlPath);
  const ext = path.extname(filePath);
  if (!MIME[ext] && !ext) filePath += '.html';

  // ─── Path traversal ─────────────────────────────────────────────────────
  // path.join() acima NÃO impede que urlPath contenha "..", "%2e%2e" (já
  // decodificado), ou um caminho absoluto — ex: GET /../server.js ou
  // GET /../../private/security.json escapariam de DIR (public/) e
  // exporiam qualquer arquivo do disco que o processo Node consiga ler.
  // Resolve o caminho final e recusa qualquer um que não fique estritamente
  // dentro de DIR (mesma técnica já usada em caminhoSeguroDentroDoProjeto(),
  // acima, pra Restauração Geral).
  const caminhoResolvido = path.resolve(filePath);
  if (caminhoResolvido !== DIR && !caminhoResolvido.startsWith(DIR + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(caminhoResolvido, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const headers = { 'Content-Type': MIME[path.extname(caminhoResolvido)] || 'text/plain' };
    // ─── /db/*.json NUNCA pode ser servido do cache do navegador ────────
    // Sem cabeçalho de cache nenhum (situação de antes desta mudança), o
    // navegador é livre pra decidir sozinho por quanto tempo confiar numa
    // cópia antiga — na prática, isso fazia mudanças salvas em
    // Configurações (ex: reordenar Paletes) não aparecerem nem com F5,
    // só depois de logout+login (que por acaso força uma navegação nova
    // o bastante pra descartar a cópia em cache). O service worker (ver
    // public/service-worker.js) já EXCLUI '/db/' da sua própria camada de
    // cache de propósito, com o mesmo raciocínio — mas isso não impede o
    // cache HTTP nativo do navegador, uma camada totalmente separada, de
    // guardar a resposta por conta própria. `no-store` fecha as duas
    // pontas: nunca guarda, então nunca serve stale, pra qualquer
    // arquivo debaixo de /db/ (config.json, usuarios.json não fica aqui
    // — fica em private/ —, mas historico.json e afins também se
    // beneficiam da mesma garantia).
    if (urlPath.startsWith('/db/')) headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
    res.end(data);
  });

});

// ── WEBSOCKET: transmite em tempo real qualquer mudança da operação em
// andamento (tela "Registrar Operação") pra quem mais estiver com a tela
// aberta. Quem dispara o broadcast é a rota POST /salvar-operacao-andamento,
// acima; aqui só ficam a conexão e o encaminhamento pra
// lib/websocket-broadcast.js (ver Fase 13, acima) — a lista de clientes
// conectados e o número de revisão vivem lá agora.
const wss = new WebSocket.Server({ server, path: '/ws/operacao-andamento' });

wss.on('connection', (ws) => {
  wsBroadcast.adicionarCliente(ws);

  // Ao conectar, manda na hora o snapshot atual — é assim que a tela
  // carrega já mostrando uma operação que outra pessoa tenha deixado
  // rodando (ou null, se não houver nenhuma). Inclui a revisão ATUAL
  // (não 0) — pra esta aba já nascer sabendo a partir de qual ponto
  // futuras atualizações contam como "mais novas".
  try {
    ws.send(JSON.stringify({ tipo: 'estado', dados: lerOperacaoAndamento(), revisao: wsBroadcast.getRevisaoAtual() }));
  } catch (_) { /* conexão pode ter caído nesse exato instante — ignora */ }

  ws.on('close', () => wsBroadcast.removerCliente(ws));
  ws.on('error', () => wsBroadcast.removerCliente(ws));
});

server.listen(PORT, HOST, () => {
  logger.info('server', `Lightwall rodando em http://${HOST}:${PORT}`);

  // Checa a cada minuto se já é "fim de dia" e falta fazer o backup
  // automático de hoje. Roda também uma vez já no boot, pro caso do
  // servidor subir depois das 23:50 de algum dia. A função em si vive em
  // lib/rotas/backup.js (ver comentário no topo daquele arquivo pro
  // porquê da factory devolver um objeto { tentar, ... } em vez de só a
  // função tentar() como os outros módulos desta série) — nunca é
  // chamada por uma rota HTTP, só por este setInterval.
  setInterval(rotasBackup.executarBackupAutomaticoSeNecessario, 60 * 1000);
  rotasBackup.executarBackupAutomaticoSeNecessario();

  // Checa a cada minuto se já é 09h da manhã e existe alguma manutenção
  // PROGRAMADA (status='Aprovado') marcada pra HOJE que ainda não teve o
  // lembrete do dia disparado — pedido do usuário: "agendamento pro dia
  // 12, quero um lembrete no dia 12 às 09h". Roda também uma vez já no
  // boot, mesmo raciocínio do backup automático acima (servidor subindo
  // depois das 09h não pode perder o lembrete do dia). A função em si
  // vive em lib/notificacoes-push.js (executarLembreteManutencaoProgramadaSeNecessario)
  // — nunca é chamada por uma rota HTTP, só por este setInterval.
  setInterval(notificacoesPush.executarLembreteManutencaoProgramadaSeNecessario, 60 * 1000);
  notificacoesPush.executarLembreteManutencaoProgramadaSeNecessario();
});