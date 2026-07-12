// ─── lib/rotas/leitura-e-ajustes.js — Leitura Automática + Ajustes de Traço ─
// Décima quarta fatia extraída de server.js (ver lib/rotas/operadores.js
// pro padrão completo). Rotas cobertas: POST /leitura-automatica,
// POST /registrar-ajuste-traco.
//
// `broadcastLeituraAutomatica` é injetada via ctx — definida perto do
// WebSocket (server.js), mas é uma function declaration hoisted, então
// funciona independente de onde está textualmente no arquivo.
// `dirParaModoTeste` também é compartilhada com outros domínios ainda em
// server.js (registrar-operacao, salvar-sobra, etc.).
//
// `modoTeste` é derivado aqui dentro a partir de queryParams — só
// /registrar-ajuste-traco precisa dele.

module.exports = function criarRotasLeituraEAjustes({ fs, path, db, DB_DIR, dirParaModoTeste, broadcastLeituraAutomatica }) {

  const CAMPOS_INSUMO_VALIDOS = new Set(['cimento_real', 'agua_real', 'eps_real', 'superplast_real', 'incorporador_real']);

  return function tentar(req, res, urlPath, queryParams) {

    // ── POST /leitura-automatica: recebe UMA leitura vinda de fora (hoje só
    // via teste manual — a fonte real seria um coletor Modbus TCP lendo o
    // CLP da linha de produção, que ainda não está conectado, ver README,
    // "Modo Automático") e transmite via WebSocket pra quem estiver com
    // "🤖 Modo Automático" ativo em Registrar Operação (ver operacao.js,
    // _aplicarLeituraAutomatica) — essa tela decide o que fazer com a
    // leitura; esta rota só valida o formato mínimo e repassa.
    //
    // 2 formatos aceitos:
    //   Insumo (balança):  { tipo:'insumo', campo:'cimento_real', valor:512.3, traco:1 }
    //     - campo: um dos 5 insumos reais do traço (ver CAMPOS_INSUMO_VALIDOS)
    //     - traco: número do traço (t.num) a que se refere — opcional, se
    //       omitido a tela aplica no traço selecionado no momento
    //   Berço (injetora):  { tipo:'berco', berco:'B7' }
    //     - ainda SEM AÇÃO definida do lado da tela (só chega e é logada) —
    //       falta decidir o que uma leitura de berço da injetora deve mudar
    //       (ver operacao.js)
    //
    // Sem exigir permissão de controlar operação nem sessão de admin de
    // propósito: mesmo espírito de baixa fricção de
    // /marcar-berco-andamento — é uma leitura de sensor, não um controle
    // da operação em si.
    if (req.method === 'POST' && urlPath === '/leitura-automatica') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const leitura = JSON.parse(body);
          if (!leitura || (leitura.tipo !== 'insumo' && leitura.tipo !== 'berco')) {
            throw new Error('Campo "tipo" precisa ser "insumo" ou "berco".');
          }

          // Confere o flag GLOBAL (Configurações → Automação), não mais um
          // estado por operação — rejeita cedo se ninguém ligou o Modo
          // Automático, pra um coletor mal configurado não ficar mandando
          // leituras que nunca serão aplicadas (e pra deixar claro pra quem
          // está testando a integração que precisa ligar o modo primeiro).
          const cfgAtual = JSON.parse(fs.readFileSync(path.join(DB_DIR, 'config.json'), 'utf8'));
          if (cfgAtual.modoAutomatico !== true) {
            throw new Error('Modo Automático está desligado (Configurações → Automação).');
          }
          if (leitura.tipo === 'insumo') {
            if (!CAMPOS_INSUMO_VALIDOS.has(leitura.campo)) {
              throw new Error('Campo de insumo inválido: ' + leitura.campo);
            }
            if (typeof leitura.valor !== 'number' || !isFinite(leitura.valor)) {
              throw new Error('"valor" precisa ser um número.');
            }
          } else if (leitura.tipo === 'berco') {
            if (!leitura.berco || typeof leitura.berco !== 'string' || !/^B\d+$/.test(leitura.berco)) {
              throw new Error('Berço inválido.');
            }
          }

          broadcastLeituraAutomatica(leitura);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── AJUSTES DE TRAÇO: registra um ajuste (insumo + tempo de batida juntos)
    // no histórico de auditoria — não interfere no traço em si (que já foi
    // salvo no historico.json/relatorio_injecao.json); isso é só o "log" de
    // qual ajuste veio com qual tempo de batida, organizado por traço.
    // Numeração de "ajuste_N" é decidida AQUI no servidor (não no navegador)
    // pra evitar duas abas/operações gerando o mesmo número pro mesmo traço.
    if (req.method === 'POST' && urlPath === '/registrar-ajuste-traco') {
      const modoTeste = queryParams.get('modoTeste') === 'true';
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { id_traco, ajuste } = JSON.parse(body);
          if (!id_traco || typeof id_traco !== 'string') {
            throw new Error('Payload inválido: "id_traco" obrigatório.');
          }
          if (!ajuste || typeof ajuste !== 'object' || Array.isArray(ajuste)) {
            throw new Error('Payload inválido: "ajuste" obrigatório.');
          }
          if (typeof ajuste.tempo_batida !== 'number' || ajuste.tempo_batida <= 0) {
            throw new Error('"ajuste.tempo_batida" obrigatório (minutos, > 0).');
          }

          if (modoTeste) {
            const ajustesPath = path.join(dirParaModoTeste(true), 'ajustes_tracos.json');
            let ajustesTracos = [];
            try { ajustesTracos = JSON.parse(fs.readFileSync(ajustesPath, 'utf8') || '[]'); } catch (_) {}
            if (!Array.isArray(ajustesTracos)) ajustesTracos = [];

            let entrada = ajustesTracos.find(e => e.id_traco === id_traco);
            if (!entrada) { entrada = { id_traco }; ajustesTracos.push(entrada); }

            const numerosExistentes = Object.keys(entrada)
              .map(k => /^ajuste_(\d+)$/.exec(k)).filter(Boolean).map(m => parseInt(m[1], 10));
            const proximoNumero = (numerosExistentes.length ? Math.max(...numerosExistentes) : 0) + 1;
            entrada['ajuste_' + proximoNumero] = { ...ajuste, registrado_em: new Date().toISOString() };

            const tmp = ajustesPath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(ajustesTracos, null, 2), 'utf8');
            fs.renameSync(tmp, ajustesPath);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ajusteNumero: proximoNumero }));
            return;
          }

          // Caminho real (SQL): "ordem" = próximo número sequencial pra esse
          // id_traco — não tem FK pra "tracos" de propósito (ver schema em
          // db.js): este ajuste ao vivo acontece ANTES do traço existir lá,
          // já que só é registrado de verdade ao finalizar a operação.
          const ultimaOrdem = db.prepare('SELECT MAX(ordem) AS m FROM ajustes WHERE id_traco = ?').get(id_traco).m || 0;
          const proximaOrdem = ultimaOrdem + 1;

          db.prepare(db.SQL_INSERIR_AJUSTE).run({
            id_traco,
            ordem: proximaOrdem,
            tempo_batida: ajuste.tempo_batida,
            cimento: ajuste.cimento ?? null,
            agua: ajuste.agua ?? null,
            eps: ajuste.eps ?? null,
            superplast: ajuste.superplast ?? null,
            incorporador: ajuste.incorporador ?? null,
            registrado_em: new Date().toISOString(),
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ajusteNumero: proximaOrdem }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    return false;
  };
};
