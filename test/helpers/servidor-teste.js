// ─── test/helpers/servidor-teste.js ─────────────────────────────────────────
// Sobe uma cópia ISOLADA do server.js de verdade (não um mock) numa porta
// própria, pra cada teste poder bater nas rotas reais por HTTP sem nunca
// tocar nos dados da instalação de verdade (public/db/, private/, etc. do
// projeto raiz continuam intactos).
//
// A cópia fica em .test-tmp/ (dentro do projeto, não em /tmp do sistema) DE
// PROPÓSITO: assim o Node acha node_modules/ subindo os diretórios
// normalmente (resolução padrão do require) sem precisar copiar nem
// symlinkar nada — funciona com `npm install` normal, nenhuma configuração
// extra.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAIZ_PROJETO = path.join(__dirname, '..', '..');
const PASTA_TMP_BASE = path.join(RAIZ_PROJETO, '.test-tmp');

const ARQUIVOS_NECESSARIOS = ['server.js', 'db.js', 'lib', 'public', 'package.json'];

/**
 * @param {object} [opcoes]
 * @param {object} [opcoes.seedSecurityJson] - se informado, escreve esse
 *   objeto em public/db/security.json ANTES de subir o servidor — simula
 *   uma instalação existente (testa a migração automática pra private/) e
 *   dá um hash conhecido pros testes de senha usarem.
 * @param {string[]} [opcoes.dispositivosAutorizados] - se informado, uma
 *   lista de deviceIds pra já nascer autorizados em config.json
 *   (dispositivosAutorizados — ver dispositivoAutorizado(), server.js).
 *   Sem isto, a lista nasce vazia — NENHUM dispositivo consegue controlar
 *   operação (mesmo comportamento de uma instalação nova, ver conversa
 *   que motivou a mudança) até autorizar um explicitamente. Testes que
 *   batem em rotas de controle de operação (POST /registrar-operacao,
 *   POST /salvar-operacao-andamento, etc.) e esperam sucesso precisam
 *   disto — ver DEVICE_ID_TESTE_PADRAO, exportado abaixo, pra usar um
 *   deviceId consistente entre `dispositivosAutorizados` aqui e a query
 *   string `?deviceId=...` de cada fetch().
 * @param {object} [opcoes.env] - variáveis de ambiente extras pro processo
 *   do servidor de teste (ex: LW_TEST_RELOGIO_ISO, ver server.js/
 *   _agoraServer() — congela o relógio do servidor pra testar jobs
 *   baseados em hora/data deterministicamente).
 */
async function _subirProcesso(pastaTemp, envExtra, obterHistorico) {
  const porta = 4000 + Math.floor(Math.random() * 5000);
  const processo = spawn('node', ['server.js'], {
    cwd: pastaTemp,
    env: { ...process.env, PORT: String(porta), ...(envExtra || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let saidaDesteProcesso = '';
  processo.stdout.on('data', chunk => { saidaDesteProcesso += chunk.toString(); });
  processo.stderr.on('data', chunk => { saidaDesteProcesso += chunk.toString(); });

  const baseUrl = `http://localhost:${porta}`;
  // obterHistorico() opcional — soma o log de processos ANTERIORES (ver
  // reiniciar(), abaixo), pra um log emitido antes de um restart continuar
  // valendo como evidência depois (ex: "IP foi bloqueado" aconteceu no
  // processo de antes, mas o teste só confere depois de reiniciar).
  const obterSaida = () => (obterHistorico ? obterHistorico() : '') + saidaDesteProcesso;
  await esperarServidorSubir(baseUrl, processo, obterSaida);

  return { processo, baseUrl, obterSaida };
}

async function iniciarServidorDeTeste(opcoes = {}) {
  fs.mkdirSync(PASTA_TMP_BASE, { recursive: true });
  const pastaTemp = fs.mkdtempSync(path.join(PASTA_TMP_BASE, 'srv-'));

  for (const item of ARQUIVOS_NECESSARIOS) {
    fs.cpSync(path.join(RAIZ_PROJETO, item), path.join(pastaTemp, item), { recursive: true });
  }

  if (opcoes.seedSecurityJson) {
    fs.writeFileSync(
      path.join(pastaTemp, 'public', 'db', 'security.json'),
      JSON.stringify(opcoes.seedSecurityJson, null, 2),
      'utf8'
    );
  }

  if (opcoes.dispositivosAutorizados) {
    const configPath = path.join(pastaTemp, 'public', 'db', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cfg.dispositivosAutorizados = opcoes.dispositivosAutorizados.map(deviceId => ({
      deviceId, nome: 'Dispositivo de Teste', autorizadoEm: new Date().toISOString(),
    }));
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  }

  let { processo, baseUrl, obterSaida } = await _subirProcesso(pastaTemp, opcoes.env);

  const servidor = {
    get baseUrl() { return baseUrl; },
    pastaTemp,
    get obterSaida() { return obterSaida; },
    async parar() {
      processo.kill();
      fs.rmSync(pastaTemp, { recursive: true, force: true });
    },
    // Mata o processo atual e sobe um NOVO processo, do zero, apontando pra
    // MESMA pastaTemp (mesmo data/lightwall.sqlite, mesmo private/,
    // mesmo public/db/) — simula um restart de verdade (deploy, reboot,
    // crash) sem apagar nenhum dado. Usado por testes de "isso sobrevive a
    // um restart do processo?" (ex: rate limit persistido em SQLite —
    // ver lib/auth.js — em vez de num Map em memória, que zerava sozinho).
    async reiniciar(opcoesExtra = {}) {
      processo.kill();
      await new Promise(resolve => {
        if (processo.exitCode !== null) return resolve();
        processo.once('exit', resolve);
      });
      const subido = await _subirProcesso(pastaTemp, { ...(opcoes.env || {}), ...(opcoesExtra.env || {}) }, obterSaida);
      processo = subido.processo;
      baseUrl = subido.baseUrl;
      obterSaida = subido.obterSaida;
    },
  };
  return servidor;
}

async function esperarServidorSubir(baseUrl, processo, obterErro, tentativas = 300) {
  // 300 tentativas * 100ms = até 30s de espera (era 10s/100 tentativas).
  // Por padrão, `node --test` sobe vários arquivos de teste em paralelo, e
  // CADA UM desses spawna seu próprio `node server.js` (ver
  // iniciarServidorDeTeste, acima). Numa máquina/CI com poucos núcleos, um
  // punhado de servidores de teste subindo ao mesmo tempo — cada um
  // carregando Express + better-sqlite3 (módulo nativo) do zero — pode
  // legitimamente levar bem mais que 10s pra responder, sem que nada
  // esteja de fato quebrado (só fila de CPU). 10s tornava esse cenário
  // (comum, não uma exceção) indistinguível de um servidor travado de
  // verdade. Se ainda assim isso for insuficiente em algum CI, rodar
  // com `--test-concurrency=1` (ver "test:serial" no package.json)
  // remove a causa raiz (contenção), em troca de uma suíte mais lenta.
  for (let i = 0; i < tentativas; i++) {
    if (processo.exitCode !== null) {
      throw new Error(`server.js de teste encerrou sozinho antes de subir.\n${obterErro()}`);
    }
    try {
      await fetch(baseUrl + '/login.html');
      return;
    } catch (_) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error('Servidor de teste não respondeu a tempo.');
}

// deviceId padrão pra testes que precisam de UM dispositivo autorizado
// consistente — usar como opcoes.dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO]
// no before() e '?deviceId=' + DEVICE_ID_TESTE_PADRAO em cada fetch() que
// controla operação.
const DEVICE_ID_TESTE_PADRAO = 'dev_teste_padrao';

module.exports = { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO };
