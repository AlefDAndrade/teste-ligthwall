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
 */
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

  const porta = 4000 + Math.floor(Math.random() * 5000);
  const processo = spawn('node', ['server.js'], {
    cwd: pastaTemp,
    env: { ...process.env, PORT: String(porta) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let saidaErro = '';
  processo.stderr.on('data', chunk => { saidaErro += chunk.toString(); });

  const baseUrl = `http://localhost:${porta}`;
  await esperarServidorSubir(baseUrl, processo, () => saidaErro);

  return {
    baseUrl,
    pastaTemp,
    async parar() {
      processo.kill();
      fs.rmSync(pastaTemp, { recursive: true, force: true });
    },
  };
}

async function esperarServidorSubir(baseUrl, processo, obterErro, tentativas = 100) {
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

module.exports = { iniciarServidorDeTeste };
