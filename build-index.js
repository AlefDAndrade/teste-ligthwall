// ─── build-index.js — monta public/index.html a partir dos pedaços ─────────
// O navegador não tem `require()`/`import` de HTML — então, diferente da
// fatia do server.js (que usa módulos Node de verdade), aqui quem "junta as
// partes" é este script, rodado ANTES de subir o servidor.
//
// Fonte: public/index.template.html (a "casca" — head, topbar, sidebar,
// scripts — com um marcador `<!-- INCLUDE:nome.html -->` em cada lugar
// onde um pedaço de public/partials/ entra).
// Saída: public/index.html (o arquivo de verdade, servido pelo server.js).
//
// public/index.html GERADO não deve ser editado à mão a partir de agora —
// qualquer edição direta nele se perde no próximo build. Edite o partial
// correspondente (ou o template, pra mudanças na casca) e rode:
//   node build-index.js
//
// Importante: o HTML final é byte-a-byte o mesmo que seria se tudo
// estivesse num arquivo só (nenhuma tag nova, nenhuma mudança de ordem) —
// isso só reorganiza ONDE o código mora, não muda o que o navegador recebe.

const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, 'public', 'index.template.html');
const PARTIALS_DIR = path.join(__dirname, 'public', 'partials');
const SAIDA_PATH = path.join(__dirname, 'public', 'index.html');

const MARCADOR_RE = /<!-- INCLUDE:([\w.-]+\.html) -->/g;

function montarIndexHtml() {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  const resultado = template.replace(MARCADOR_RE, (match, nomeArquivo) => {
    const partialPath = path.join(PARTIALS_DIR, nomeArquivo);
    if (!fs.existsSync(partialPath)) {
      throw new Error(`Partial não encontrado: ${nomeArquivo} (esperado em ${partialPath})`);
    }
    // Remove só a ÚLTIMA quebra de linha do arquivo: o conteúdo do partial
    // já termina com '\n' (é assim que arquivos de texto normalmente
    // terminam), e a linha do marcador no template TAMBÉM tem seu próprio
    // '\n' depois de ser substituída — sem isso, sobra uma linha em
    // branco extra em cada junção (foi isso que o diff contra o
    // index.html original pegou na 1ª tentativa).
    return fs.readFileSync(partialPath, 'utf8').replace(/\n$/, '');
  });

  fs.writeFileSync(SAIDA_PATH, resultado, 'utf8');
  return resultado;
}

if (require.main === module) {
  montarIndexHtml();
  console.log('public/index.html gerado a partir de index.template.html + partials/.');
}

module.exports = { montarIndexHtml };
