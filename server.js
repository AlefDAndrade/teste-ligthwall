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

// Converte pra número, ou null se vazio/nulo/indefinido — usado ao montar
// parâmetros de colunas SQL a partir de valores de formulário (que chegam
// como string vazia '' quando o campo não foi preenchido).
function numOuNulo(v) {
  return (v === '' || v === null || v === undefined) ? null : Number(v);
}

const PORT = process.env.PORT || 5000; // env var facilita rodar testes numa porta separada
const ROOT_DIR = __dirname; // raiz do projeto — usado pelo backup geral
const DIR = path.join(__dirname, 'public');
const DB_DIR = path.join(DIR, 'db'); // arquivos-de-dados (JSON usados como "banco")

// ─── security.json mora FORA de public/ ────────────────────────────────────
// Antes, security.json vivia em public/db/ — e por isso era servido como
// arquivo estático comum (GET /db/security.json acessível por qualquer um,
// sem senha nenhuma; ver README, "Limitações conhecidas"). Agora mora em
// private/ (irmã de public/, nunca servida como estático — mesmo padrão já
// usado por backups-seguranca/ e logs/). O acesso por HTTP passa a exigir
// uma sessão de admin válida (ver GET /db/security.json e lib/sessao.js,
// mais abaixo) — a URL que o navegador usa não muda, só fica protegida.
const PRIVATE_DIR = path.join(ROOT_DIR, 'private');
const SECURITY_PATH = path.join(PRIVATE_DIR, 'security.json');
// Cadastro de usuários com login+senha+perfil (ver lib/rotas/usuarios.js,
// lib/perfis.js) — mesmo motivo de segurança: contém senhaHash por
// usuário, e um arquivo dentro de public/db/ seria servido cru pela rota
// estática genérica pra qualquer um que soubesse a URL (foi exatamente o
// problema histórico de security.json — ver README, "Limitações
// conhecidas"). GET /usuarios (lib/rotas/usuarios.js) nunca devolve
// senhaHash, só {id, nomeUsuario, perfil}.
const USUARIOS_PATH = path.join(PRIVATE_DIR, 'usuarios.json');
fs.mkdirSync(PRIVATE_DIR, { recursive: true });

// Migração automática, só na 1ª vez que sobe depois desta mudança: se o
// arquivo antigo (public/db/security.json) ainda existir e o novo ainda
// não, copia o conteúdo pro novo lugar e RENOMEIA o antigo (nunca apaga —
// mesmo padrão das migrações de db.js, que preferem deixar um rastro
// "<nome>.migrado-<timestamp>" a apagar dados).
(function migrarSecurityJsonSeNecessario() {
  const caminhoAntigo = path.join(DB_DIR, 'security.json');
  if (fs.existsSync(SECURITY_PATH)) return; // já migrado
  if (!fs.existsSync(caminhoAntigo)) return; // instalação nova — nada pra migrar
  fs.copyFileSync(caminhoAntigo, SECURITY_PATH);
  fs.renameSync(caminhoAntigo, caminhoAntigo + `.migrado-${Date.now()}`);
})();

// Autenticação do Administrador (hash de senha + rate limiting de
// tentativas) — extraído pra lib/auth.js (ver esse arquivo pros detalhes
// e comentários originais; aqui só instanciamos e usamos).
const auth = require('./lib/auth.js')(SECURITY_PATH);

// Sessão de Administrador (token em cookie HttpOnly) — extraído pra
// lib/sessao.js. Cobre as 2 rotas que não tinham proteção própria nenhuma
// antes desta mudança: GET /db/security.json e POST /salvar-security.
const sessao = require('./lib/sessao.js')();

// Sessão de USUÁRIO CADASTRADO (Operador/Analista/Qualidade/Manutenção/
// Administrativo — ver lib/perfis.js) — diferente de `sessao` acima, que é
// só pro Administrador Master (senha única mestra). Ver lib/sessao-usuario.js.
const sessaoUsuario = require('./lib/sessao-usuario.js')();

// Mapa central de permissões por perfil (quais páginas cada um vê) — ver
// lib/perfis.js. Usado tanto por GET /perfis (front monta o menu) quanto
// por validações no servidor (lib/rotas/usuarios.js).
const perfis = require('./lib/perfis.js');

// ── Fatias de rotas extraídas pra lib/rotas/ (ver esse arquivo pro padrão
// seguido) — cada uma é uma factory que recebe só as dependências que
// aquele domínio usa, e devolve uma função tentar(req,res,urlPath) que
// devolve true se já respondeu. Chamadas em sequência dentro do
// http.createServer, abaixo, antes das rotas que ainda não foram
// extraídas (ver o loop logo no início do callback).
const rotasUsuarios = require('./lib/rotas/usuarios.js')({ fs, path, PRIVATE_DIR, auth, sessao, sessaoUsuario, perfis });
const rotasParadas = require('./lib/rotas/paradas.js')({ db });
const rotasQualidade = require('./lib/rotas/qualidade.js')({ db, lerOperacoesNaoAvaliadas, removerDaFilaNaoAvaliadas });
const rotasSqlAdmin = require('./lib/rotas/sql-admin.js')({ db, sessao, adicionarNaFilaNaoAvaliadas, broadcastDadosSqlExcluidos });
const rotasConsultas = require('./lib/rotas/consultas.js')({ db });
const rotasSobra = require('./lib/rotas/sobra.js')({ db, fs, path, dirParaModoTeste });
const rotasContadorTracos = require('./lib/rotas/contador-tracos.js')({ lerContadorTracosHoje, incrementarContadorTracosHoje, podeControlarOperacao, negarControleDeOperacao });
const rotasLogAcesso = require('./lib/rotas/log-acesso.js')({ fs, path, ROOT_DIR });
const rotasOperacaoAndamento = require('./lib/rotas/operacao-andamento.js')({
  sessao, lerOperacaoAndamento, salvarOperacaoAndamentoNoDisco, broadcastOperacaoAndamento,
  lerBercosAndamento, salvarBercosAndamentoNoDisco, podeControlarOperacao, negarControleDeOperacao,
});
const rotasAutenticacao = require('./lib/rotas/autenticacao.js')({ fs, path, DB_DIR, SECURITY_PATH, auth, sessao });
const rotasImportacao = require('./lib/rotas/importacao.js')({ db, sessao, numOuNulo });
const rotasLeituraEAjustes = require('./lib/rotas/leitura-e-ajustes.js')({ fs, path, db, DB_DIR, dirParaModoTeste, broadcastLeituraAutomatica });
const rotasEdicao = require('./lib/rotas/edicao.js')({ db, sessao, numOuNulo });
const rotasRegistroOperacao = require('./lib/rotas/registro-operacao.js')({
  db, fs, path, dirParaModoTeste,
  podeControlarOperacao, negarControleDeOperacao,
  lerBercosAndamento, salvarBercosAndamentoNoDisco,
  adicionarNaFilaNaoAvaliadas, broadcastOperacaoFinalizada,
});
const rotasBackup = require('./lib/rotas/backup.js')({
  db, fs, path, JSZip,
  ROOT_DIR, DB_DIR, SECURITY_PATH, USUARIOS_PATH,
  auth, sessao,
  todayBrasiliaServer, horaMinutoBrasiliaServer,
  lerContadorTracosHoje, recalcularFilaNaoAvaliadasApartirDoSql,
});
const ROTAS_EXTRAIDAS = [rotasUsuarios, rotasParadas, rotasQualidade, rotasSqlAdmin, rotasConsultas, rotasSobra, rotasContadorTracos, rotasLogAcesso, rotasOperacaoAndamento, rotasAutenticacao, rotasImportacao, rotasLeituraEAjustes, rotasEdicao, rotasRegistroOperacao, rotasBackup.tentar];

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

// Retorna a data de hoje em Brasília no formato YYYY-MM-DD (consistente com
// todayBrasilia() do frontend), independente do fuso horário do servidor.
function todayBrasiliaServer() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date()); // en-CA já formata como YYYY-MM-DD
}

// Retorna { hora, minuto } de agora em Brasília — usado pelo backup
// automático diário, pra saber se já passou do horário de "fim de dia".
function horaMinutoBrasiliaServer() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const partes = fmt.formatToParts(new Date());
  const hora = parseInt(partes.find(p => p.type === 'hour').value, 10);
  const minuto = parseInt(partes.find(p => p.type === 'minute').value, 10);
  return { hora, minuto };
}

// ─── MODO DE TESTE (Registrar Operação) ────────────────────────────────────
// Toggle na tela "Registrar Operação" — quando ativo, a operação inteira
// (historico, relatório de injeção, contador de traços, ajustes, sobra) é
// salva em public/db/teste/ em vez de public/db/, pra treinar/testar o
// fluxo sem misturar com dados reais de produção. Nunca toca nos arquivos
// normais. Pasta criada na hora (mkdirSync) na primeira escrita.
const DB_TESTE_DIR = path.join(DB_DIR, 'teste');

function dirParaModoTeste(modoTesteFlag) {
  if (!modoTesteFlag) return DB_DIR;
  fs.mkdirSync(DB_TESTE_DIR, { recursive: true });
  return DB_TESTE_DIR;
}

// Lê o contador de traços do dia, resetando automaticamente se a data mudou
// (Brasília). NÃO incrementa — apenas garante que o objeto retornado é válido
// para o dia de hoje. Quem chama decide se quer ler ou incrementar.
// Lê o contador de traços do dia — Modo de Teste continua em JSON
// (arquivo isolado de sempre); o caminho real lê da tabela contador_tracos
// (uma query simples, sem o reset manual de "novo dia" — cada dia já é
// uma linha própria, então um dia novo simplesmente ainda não tem linha).
function lerContadorTracosHoje(modoTesteFlag = false) {
  const hoje = todayBrasiliaServer();
  if (modoTesteFlag) {
    const contadorPath = path.join(dirParaModoTeste(true), 'contador_tracos.json');
    let contador = { data: hoje, total: 0 };
    try {
      contador = JSON.parse(fs.readFileSync(contadorPath, 'utf8'));
    } catch (_) { /* arquivo ainda não existe — usa o default acima */ }
    if (contador.data !== hoje) {
      contador = { data: hoje, total: 0 }; // novo dia: reinicia a contagem
    }
    return contador;
  }
  const row = db.prepare('SELECT total FROM contador_tracos WHERE data = ?').get(hoje);
  return { data: hoje, total: row ? row.total : 0 };
}

// Incrementa o contador de traços do dia em "quantidade" — Modo de Teste
// continua fazendo ler-tudo-somar-escrever-tudo (arquivo isolado, sem
// concorrência real pra se preocupar); o caminho real faz a soma DENTRO
// do banco, numa query só — sem isso, dois "/confirmar-tracos-hoje" quase
// simultâneos podiam ler o mesmo total, somar separado, e um incremento
// se perder (o último a escrever "ganha", sem nunca somar os dois juntos).
function incrementarContadorTracosHoje(quantidade, modoTesteFlag = false) {
  const hoje = todayBrasiliaServer();
  if (modoTesteFlag) {
    const contador = lerContadorTracosHoje(true);
    contador.total += quantidade;
    const contadorPath = path.join(dirParaModoTeste(true), 'contador_tracos.json');
    fs.writeFileSync(contadorPath, JSON.stringify(contador, null, 2), 'utf8');
    return contador;
  }
  db.prepare(`
    INSERT INTO contador_tracos (data, total) VALUES (?, ?)
    ON CONFLICT(data) DO UPDATE SET total = total + ?
  `).run(hoje, quantidade, quantidade);
  return lerContadorTracosHoje(false);
}

// ─── OPERAÇÃO EM ANDAMENTO: transmissão em tempo real (WebSocket) ─────────
// Só existe UMA operação em andamento por vez, pra fábrica inteira — então
// o arquivo guarda sempre um único objeto (ou null, sem nenhuma operação
// rodando agora), nunca uma lista. A tela "Registrar Operação" manda pra cá
// a cada mudança (ver POST /salvar-operacao-andamento, mais abaixo) e o
// servidor propaga na hora pra qualquer outra aba/computador com essa
// mesma tela aberta (ver wss.on('connection', ...), perto do final do
// arquivo) — é assim que outras pessoas acompanham a operação ao vivo.
const OPERACAO_ANDAMENTO_PATH = path.join(DB_DIR, 'operacao_andamento.json');

function lerOperacaoAndamento() {
  try {
    const texto = fs.readFileSync(OPERACAO_ANDAMENTO_PATH, 'utf8').trim();
    return texto ? JSON.parse(texto) : null;
  } catch (_) {
    return null; // arquivo ainda não existe / corrompido — trata como "nenhuma operação"
  }
}

function salvarOperacaoAndamentoNoDisco(dados) {
  const tmp = OPERACAO_ANDAMENTO_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(dados, null, 2), 'utf8');
  fs.renameSync(tmp, OPERACAO_ANDAMENTO_PATH);
}

// ─── FILA DE AVALIAÇÃO (Setor de Qualidade): "não avaliadas" ──────────────
// Antes, GET /operacoes-nao-avaliadas CALCULAVA a fila toda vez (SELECT ...
// WHERE id NOT IN (SELECT id_operacao FROM operacoes_avaliadas)) — nunca
// existia como lista própria, só como diferença entre duas outras coisas.
// Agora é o CONTRÁRIO: um arquivo próprio (JSON simples — cresce a cada
// operação registrada, encolhe a cada avaliação, e nunca chega perto do
// tamanho de "operacoes"/"operacoes_avaliadas", que só crescem) é a fonte
// de verdade — guarda só os IDs pendentes, na ordem em que entraram. GET
// /operacoes-nao-avaliadas lê esta lista e busca os detalhes de cada
// operação no SQL só pra exibir (não pra decidir QUEM está na fila).
//
// Mantido em sincronia em 2 pontos (nunca em mais nenhum outro lugar):
//   - adicionarNaFilaNaoAvaliadas(id) — POST /registrar-operacao, depois do
//     INSERT em "operacoes" (nunca em Modo de Teste — mesma regra de
//     sempre, essas operações nunca entram na fila do Setor de Qualidade).
//   - removerDaFilaNaoAvaliadas(id) — sempre que uma operação é marcada
//     avaliada (POST /marcar-operacao-avaliada, e dentro de
//     db.marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada, pro caso de
//     avaliação avulsa — ver os 2 call sites, mais abaixo).
const OPERACOES_NAO_AVALIADAS_PATH = path.join(DB_DIR, 'operacoes_nao_avaliadas.json');

function lerOperacoesNaoAvaliadas() {
  try {
    const texto = fs.readFileSync(OPERACOES_NAO_AVALIADAS_PATH, 'utf8').trim();
    return texto ? JSON.parse(texto) : [];
  } catch (_) {
    return []; // arquivo ainda não existe/corrompido — ver migrarFilaNaoAvaliadasSeNecessario, que cobre a 1ª vez
  }
}

function salvarOperacoesNaoAvaliadasNoDisco(lista) {
  const tmp = OPERACOES_NAO_AVALIADAS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(lista, null, 2), 'utf8');
  fs.renameSync(tmp, OPERACOES_NAO_AVALIADAS_PATH);
}

function adicionarNaFilaNaoAvaliadas(idOperacao) {
  const lista = lerOperacoesNaoAvaliadas();
  if (!lista.includes(idOperacao)) {
    lista.push(idOperacao);
    salvarOperacoesNaoAvaliadasNoDisco(lista);
  }
}

function removerDaFilaNaoAvaliadas(idOperacao) {
  const lista = lerOperacoesNaoAvaliadas();
  const idx = lista.indexOf(idOperacao);
  if (idx !== -1) {
    lista.splice(idx, 1);
    salvarOperacoesNaoAvaliadasNoDisco(lista);
  }
}

// Recalcula a fila do ZERO a partir do SQL (mesmo critério de sempre: toda
// operação real, fora de Modo de Teste, que ainda não tem linha em
// "operacoes_avaliadas") — usada só em 2 situações, nunca no dia a dia:
//   1) 1ª vez que o servidor sobe com este arquivo ainda inexistente (ver
//      migrarFilaNaoAvaliadasSeNecessario, chamada no boot, abaixo) —
//      instalação já em uso antes desta mudança existir.
//   2) Depois de restaurar um backup que trouxe historico.json e/ou
//      operacoes_avaliadas.json mas NÃO trouxe operacoes_nao_avaliadas.json
//      (backup mais antigo, de antes deste arquivo existir) — sem isso, o
//      arquivo antigo (se já existisse aqui) ficaria fora de sincronia com
//      as tabelas SQL recém-substituídas (ver POST /restaurar-backup-dados).
function recalcularFilaNaoAvaliadasApartirDoSql() {
  const rows = db.prepare(`
    SELECT id FROM operacoes
    WHERE modo_teste = 0
      AND id NOT IN (SELECT id_operacao FROM operacoes_avaliadas)
    ORDER BY data ASC, fim ASC
  `).all();
  salvarOperacoesNaoAvaliadasNoDisco(rows.map(r => r.id));
  return rows.length;
}

function migrarFilaNaoAvaliadasSeNecessario() {
  if (fs.existsSync(OPERACOES_NAO_AVALIADAS_PATH)) return; // já existe — não é a 1ª vez, nada a fazer
  try {
    const qtd = recalcularFilaNaoAvaliadasApartirDoSql();
    console.log(`[migração] operacoes_nao_avaliadas.json criado com ${qtd} operação(ões) pendente(s) (calculado a partir do estado atual do banco).`);
  } catch (e) {
    console.error('[migração] Falha ao criar operacoes_nao_avaliadas.json — seguindo com fila vazia:', e.message);
    try { salvarOperacoesNaoAvaliadasNoDisco([]); } catch (_) { /* pior caso: arquivo continua ausente, lerOperacoesNaoAvaliadas() já trata isso como fila vazia */ }
  }
}
// Chamada AQUI mesmo (logo depois das funções/consts acima, não lá em cima
// junto das outras "Fase N" — ver caminhoArquivoDb, no topo do arquivo):
// depende de OPERACOES_NAO_AVALIADAS_PATH (const, sem hoisting de valor) e
// de "db" já com "operacoes"/"operacoes_avaliadas" prontas (migração de
// histórico já rodou lá em cima) — chamar antes desta linha do arquivo ser
// executada lançaria ReferenceError (TDZ) na const.
migrarFilaNaoAvaliadasSeNecessario();

// ─── BERÇOS DA OPERAÇÃO EM ANDAMENTO: "baixou/vazou" marcado ao vivo ──────
// Snapshot separado de operacao_andamento.json de propósito: aquele arquivo
// é sobrescrito por INTEIRO a cada mudança que a tela Registrar Operação
// manda (ver POST /salvar-operacao-andamento) — se os estados de berço
// vivessem dentro dele, o próximo campo que o operador editasse sobrescreveria
// as marcações feitas por quem estiver olhando "Bateria Atual" (potencialmente
// em outro computador, sem relação com "o dono" da operação). Aqui é um
// arquivo à parte, só mexido pelas 2 rotas de berço (GET /bercos-andamento,
// POST /marcar-berco-andamento) — ninguém mais escreve nele.
//
// Mapa ESPARSO em 2 níveis: { 'B1': { esquerda: 'baixou' } } — só guarda
// berço/lado que NÃO estão 'okay'; lado ausente (ou berço ausente por
// inteiro) é 'okay' implicitamente. Os 2 lados de um mesmo berço são
// independentes — marcar um não mexe no outro. Reversível por natureza
// (marcar de novo remove a entrada daquele lado — ver POST
// /marcar-berco-andamento).
//
// Resetado (vira {} de novo) em 2 pontos: quando a operação em andamento é
// limpa (POST /salvar-operacao-andamento com dados=null — fim normal, ou
// "🗑️ Limpar Tudo") e quando a operação é registrada de verdade (POST
// /registrar-operacao — nesse ponto, o conteúdo já foi transferido pra
// bercos_visuais antes de resetar, ver essa rota).
const BERCOS_ANDAMENTO_PATH = path.join(DB_DIR, 'bercos_andamento.json');

function lerBercosAndamento() {
  try {
    const texto = fs.readFileSync(BERCOS_ANDAMENTO_PATH, 'utf8').trim();
    const obj = texto ? JSON.parse(texto) : {};
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (_) {
    return {}; // arquivo ainda não existe / corrompido — trata como "nenhum berço marcado"
  }
}

function salvarBercosAndamentoNoDisco(mapa) {
  const tmp = BERCOS_ANDAMENTO_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(mapa, null, 2), 'utf8');
  fs.renameSync(tmp, BERCOS_ANDAMENTO_PATH);
}

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

// ─── QUEM PODE CONTROLAR A OPERAÇÃO (iniciar/encerrar/registrar) ──────────
// Substituiu o antigo sistema de "dispositivo autorizado" (lista de
// deviceIds em config.json, editável em Configurações → Autorizados) —
// ver conversa que motivou a mudança: a trava agora é por PESSOA
// (sessão de usuário logado — ver lib/sessao-usuario.js), não por
// computador. "Administrador" (senha mestra) e "Administrativo" sempre
// podem, irrestrito; os demais perfis só se o usuário específico tiver
// sido marcado com podeIniciarOperacao:true no cadastro (Configurações →
// Usuários — ver lib/rotas/usuarios.js, lib/perfis.js).
//
// Diferente da versão antiga (função pura, só um deviceId), esta lê o
// `req` inteiro pra extrair o cookie de sessão — ver
// sessaoUsuario.dadosDaSessao(req).
function podeControlarOperacao(req) {
  const dados = sessaoUsuario.dadosDaSessao(req);
  if (!dados) return false; // sem sessão de usuário válida, sem acesso
  if (dados.perfil === 'Administrativo') return true; // "quase tudo", ver lib/perfis.js
  return !!dados.podeIniciarOperacao;
}

function negarControleDeOperacao(res) {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: false,
    erro: 'Você não está autorizado a controlar operações. Peça ao Administrador pra habilitar isso no seu cadastro (Configurações → Usuários).',
  }));
}

const server = http.createServer((req, res) => {

  // Extrai o caminho (pathname) da URL e os parâmetros de query (ex:
  // ?deviceId=... — usado só pra identificar o "dono" da operação em
  // andamento, ver donoDeviceId em lib/rotas/operacao-andamento.js; a
  // AUTORIZAÇÃO pra controlar operações agora é por sessão de usuário
  // logado, ver podeControlarOperacao(), acima;
  // ?modoTeste=true — usado pelo Toggle de Teste em Registrar Operação,
  // ver dirParaModoTeste(), mais abaixo).
  const [urlPath, queryString] = req.url.split('?');
  const queryParams = new URLSearchParams(queryString || '');
  const deviceId = queryParams.get('deviceId') || '';
  const modoTeste = queryParams.get('modoTeste') === 'true';

  // ─── Limite de tamanho de corpo (POST) ─────────────────────────────────
  // Nenhuma rota abaixo tinha limite nenhum — cada uma só acumula
  // `req.on('data', chunk => body += chunk)` até o 'end', sem nenhum teto.
  // Um POST com um corpo gigante (intencional ou não) ficaria inteiro em
  // memória, sem nenhuma defesa. 50MB é generoso o bastante pro Backup
  // Geral/Restaurar Geral (a rota que de longe manda o maior payload —
  // projeto inteiro em JSON), mas ainda assim finito. Não substitui a
  // leitura de cada rota — só corta a conexão mais cedo se ela passar do
  // limite, antes de o corpo inteiro acumular em memória.
  const MAX_BODY_BYTES = 50 * 1024 * 1024;
  if (req.method === 'POST') {
    let _bytesRecebidos = 0;
    let _corpoAbortado = false;
    req.on('data', (chunk) => {
      _bytesRecebidos += chunk.length;
      if (!_corpoAbortado && _bytesRecebidos > MAX_BODY_BYTES) {
        _corpoAbortado = true;
        try {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: 'Corpo da requisição excede o limite permitido (50MB).' }));
        } catch (_) { /* resposta pode já ter sido enviada por outra checagem — ignora */ }
        req.destroy();
      }
    });
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(caminhoResolvido)] || 'text/plain' });
    res.end(data);
  });

});

// ── WEBSOCKET: transmite em tempo real qualquer mudança da operação em
// andamento (tela "Registrar Operação") pra quem mais estiver com a tela
// aberta. Quem dispara o broadcast é a rota POST /salvar-operacao-andamento,
// acima; aqui só ficam a conexão e a lista de clientes conectados.
const wss = new WebSocket.Server({ server, path: '/ws/operacao-andamento' });
const clientesOperacaoAndamento = new Set();

wss.on('connection', (ws) => {
  clientesOperacaoAndamento.add(ws);

  // Ao conectar, manda na hora o snapshot atual — é assim que a tela
  // carrega já mostrando uma operação que outra pessoa tenha deixado
  // rodando (ou null, se não houver nenhuma).
  try {
    ws.send(JSON.stringify({ tipo: 'estado', dados: lerOperacaoAndamento() }));
  } catch (_) { /* conexão pode ter caído nesse exato instante — ignora */ }

  ws.on('close', () => clientesOperacaoAndamento.delete(ws));
  ws.on('error', () => clientesOperacaoAndamento.delete(ws));
});

function _enviarWsParaTodos(msg) {
  const texto = JSON.stringify(msg);
  for (const ws of clientesOperacaoAndamento) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(texto); } catch (_) { /* cliente pode ter caído nesse exato instante */ }
    }
  }
}

function broadcastOperacaoAndamento(dados, origemClientId) {
  _enviarWsParaTodos({ tipo: 'estado', dados, origemClientId });
}

// Avisa todo mundo "ligado" no sistema (exceto quem registrou — esse já
// vê o resumo localmente) que uma operação foi finalizada/registrada —
// fim da dinâmica de dono. Disparado por POST /registrar-operacao, nunca
// em modo de teste. `resumo` é o mesmo formato que showSuccessModal()
// (operacao.js) já usa pra exibir o modal de sucesso.
function broadcastOperacaoFinalizada(resumo, origemClientId) {
  _enviarWsParaTodos({ tipo: 'operacao_finalizada', resumo, origemClientId });
}

// Avisa quem estiver com "Modo Automático" ativo (ver operacao.js,
// _aplicarLeituraAutomatica) que uma leitura chegou de fora — hoje
// disparado só por POST /leitura-automatica (ver mais acima), que por
// enquanto é chamado manualmente/por teste; a fonte real (coletor Modbus
// TCP lendo o CLP WAGO) ainda não existe — ver README, "Modo Automático".
function broadcastLeituraAutomatica(leitura) {
  _enviarWsParaTodos({ tipo: 'leitura_automatica', leitura });
}

// Avisa TODO MUNDO conectado (qualquer página, não só quem tem "Registrar
// Operação" aberta — ver conectarOperacaoAndamento() em data.js, chamada
// uma vez só no boot do app, independente da tela visível) que uma linha
// foi excluída em Configurações → Dados SQL. Quem originou a exclusão já
// recarrega a própria página sozinho (ver cfgSqlExcluirLinha, app-core.js)
// — por isso `origemClientId` (mesmo padrão de broadcastOperacaoFinalizada,
// via wsClientId na query string) evita mandar essa mesma pessoa recarregar
// 2 vezes.
function broadcastDadosSqlExcluidos(info, origemClientId) {
  _enviarWsParaTodos({ tipo: 'dados_sql_excluidos', ...info, origemClientId });
}

server.listen(PORT, () => {
  console.log(`Lightwall rodando em http://localhost:${PORT}`);

  // Checa a cada minuto se já é "fim de dia" e falta fazer o backup
  // automático de hoje. Roda também uma vez já no boot, pro caso do
  // servidor subir depois das 23:50 de algum dia. A função em si vive em
  // lib/rotas/backup.js (ver comentário no topo daquele arquivo pro
  // porquê da factory devolver um objeto { tentar, ... } em vez de só a
  // função tentar() como os outros módulos desta série) — nunca é
  // chamada por uma rota HTTP, só por este setInterval.
  setInterval(rotasBackup.executarBackupAutomaticoSeNecessario, 60 * 1000);
  rotasBackup.executarBackupAutomaticoSeNecessario();
});