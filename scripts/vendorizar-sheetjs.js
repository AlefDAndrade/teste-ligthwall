// ─── scripts/vendorizar-sheetjs.js ──────────────────────────────────────
// Baixa a build oficial e corrigida do SheetJS (xlsx.full.min.js) direto
// da CDN oficial deles (https://cdn.sheetjs.com) e salva uma cópia local
// em public/js/vendor/, em vez de depender de um <script src="https://...">
// carregado toda vez que alguém abre a página.
//
// Por quê: o pacote `xlsx` publicado no npm está travado na versão 0.18.5,
// que tem 2 vulnerabilidades de alta severidade sem correção ali (prototype
// pollution — CVE-2023-30533 — e ReDoS). A própria SheetJS parou de
// publicar no npm e agora distribui só pela CDN oficial deles. As versões
// >= 0.19.3 já corrigem os dois problemas.
//
// Este script:
//   1. baixa https://cdn.sheetjs.com/xlsx-<VERSAO>/package/dist/xlsx.full.min.js
//   2. confere o hash MD5 contra o valor publicado pela própria SheetJS
//      (ver https://docs.sheetjs.com/docs/miscellany/contributing/), pra
//      garantir que o arquivo não foi alterado no caminho
//   3. salva em public/js/vendor/xlsx.full.min.js
//
// Rodar manualmente quando quiser atualizar a versão vendorizada:
//   node scripts/vendorizar-sheetjs.js
//
// Precisa de acesso de rede a cdn.sheetjs.com (esse script não roda em
// ambientes com rede restrita/whitelist que não inclua esse domínio).

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSAO = '0.20.3';
const MD5_ESPERADO = '6b3130af1ceadf07caa0ec08af7addff'; // publicado pela SheetJS para a v0.20.3
const URL = `https://cdn.sheetjs.com/xlsx-${VERSAO}/package/dist/xlsx.full.min.js`;
const DESTINO_DIR = path.join(__dirname, '..', 'public', 'js', 'vendor');
const DESTINO_PATH = path.join(DESTINO_DIR, 'xlsx.full.min.js');

function baixar(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(baixar(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Falha ao baixar (HTTP ${res.statusCode}): ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  console.log(`Baixando SheetJS v${VERSAO} de ${URL} ...`);
  const conteudo = await baixar(URL);

  const md5Real = crypto.createHash('md5').update(conteudo).digest('hex');
  if (md5Real !== MD5_ESPERADO) {
    console.error(`ERRO: MD5 não confere!\n  esperado: ${MD5_ESPERADO}\n  obtido:   ${md5Real}\nArquivo NÃO foi salvo — verifique manualmente antes de confiar nele.`);
    process.exit(1);
  }

  fs.mkdirSync(DESTINO_DIR, { recursive: true });
  fs.writeFileSync(DESTINO_PATH, conteudo);
  console.log(`OK — salvo em ${DESTINO_PATH} (MD5 conferido: ${md5Real})`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
