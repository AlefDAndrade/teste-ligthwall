// ─── test/one-page-comentarios-crud.test.js ─────────────────────────────────
// Cobertura do backend do Módulo de Comentários do One Page Report — Fase 3
// do plano (ver README, "Nova página: One Page Report (planejamento)").
//
// Roda contra o server.js DE VERDADE (não um mock), numa cópia isolada —
// ver test/helpers/servidor-teste.js. Cobre:
//   - GET /db/one-page-comentarios.json sem "mes" (ou mal formatado) é
//     recusado (400).
//   - GET de um mês nunca salvo devolve um esqueleto com todos os campos
//     vazios (nunca null solto) e atualizadoEm: null.
//   - POST /salvar-comentarios-one-page-report sem sessão é recusado (403),
//     nada é gravado.
//   - "mes" ausente/mal formatado e bloco em formato inválido são
//     recusados (400).
//   - Caminho feliz: salva um bloco (Segurança) e ele aparece em GET; salvar
//     outro bloco (Produção) depois NÃO apaga o que já tinha sido salvo
//     (mescla, não sobrescreve o mês inteiro) — mesma preocupação de
//     /salvar-metas não sobrescrever o config.json inteiro.
//   - "Assuntos Gerais" (texto solto, sem comentarios/proximosPassos) é
//     salvo e mesclado do mesmo jeito.
//   - Meses diferentes não se misturam (salvar agosto não mexe em julho).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-one-page-comentarios-644';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
  });
});

after(async () => {
  await servidor.parar();
});

function extrairCookie(resposta) {
  const setCookie = resposta.headers.get('set-cookie') || '';
  return setCookie.split(';')[0] || null;
}

async function logarComoAdminMaster() {
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  return extrairCookie(resp);
}

function buscarComentarios(mes) {
  const qs = mes ? `?mes=${mes}` : '';
  return fetch(`${servidor.baseUrl}/db/one-page-comentarios.json${qs}`);
}

function salvarComentarios(payload, cookie) {
  return fetch(`${servidor.baseUrl}/salvar-comentarios-one-page-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
}

test('GET /db/one-page-comentarios.json sem "mes" é recusado (400)', async () => {
  const resp = await buscarComentarios();
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);
  assert.match(corpo.erro, /mes/i);
});

test('GET /db/one-page-comentarios.json com "mes" mal formatado é recusado (400)', async () => {
  const resp = await buscarComentarios('2026-8');
  assert.equal(resp.status, 400);
});

test('GET de um mês nunca salvo devolve esqueleto com campos vazios, nunca null solto', async () => {
  const resp = await buscarComentarios('2026-08');
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);
  assert.equal(corpo.mes, '2026-08');
  assert.deepEqual(corpo.seguranca, { comentarios: '', proximosPassos: '' });
  assert.deepEqual(corpo.producao, { comentarios: '', proximosPassos: '' });
  assert.deepEqual(corpo.refugo, { comentarios: '', proximosPassos: '' });
  assert.deepEqual(corpo.expedicao, { comentarios: '', proximosPassos: '' });
  assert.deepEqual(corpo.assuntosGerais, { texto: '', fotos: [] });
  assert.equal(corpo.atualizadoEm, null);
});

test('POST /salvar-comentarios-one-page-report sem sessão é recusado (403), nada é gravado', async () => {
  const resp = await salvarComentarios({
    mes: '2026-08',
    seguranca: { comentarios: 'Tentativa sem sessão', proximosPassos: '' },
  }, null);
  assert.equal(resp.status, 403);

  const corpo = await (await buscarComentarios('2026-08')).json();
  assert.equal(corpo.seguranca.comentarios, '');
});

test('"mes" ausente é recusado (400)', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await salvarComentarios({ seguranca: { comentarios: 'x', proximosPassos: '' } }, cookie);
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.match(corpo.erro, /mes/i);
});

test('"mes" mal formatado é recusado (400)', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await salvarComentarios({ mes: 'agosto-2026', seguranca: { comentarios: 'x', proximosPassos: '' } }, cookie);
  assert.equal(resp.status, 400);
});

test('bloco em formato inválido (string em vez de objeto) é recusado (400), sem gravar nada', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await salvarComentarios({ mes: '2026-08', producao: 'não é um objeto' }, cookie);
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.match(corpo.erro, /produ/i);

  const depois = await (await buscarComentarios('2026-08')).json();
  assert.equal(depois.producao.comentarios, '');
});

test('caminho feliz: salva o bloco de Segurança e ele aparece em GET', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await salvarComentarios({
    mes: '2026-08',
    seguranca: { comentarios: 'Nenhuma ocorrência grave no mês.', proximosPassos: 'Reforçar treinamento de EPI.' },
  }, cookie);
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);
  assert.equal(corpo.seguranca.comentarios, 'Nenhuma ocorrência grave no mês.');
  assert.equal(corpo.seguranca.proximosPassos, 'Reforçar treinamento de EPI.');
  assert.ok(corpo.atualizadoEm); // timestamp gerado no servidor

  const lido = await (await buscarComentarios('2026-08')).json();
  assert.equal(lido.seguranca.comentarios, 'Nenhuma ocorrência grave no mês.');
});

test('salvar um bloco diferente (Produção) depois NÃO apaga o que já tinha em Segurança', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await salvarComentarios({
    mes: '2026-08',
    producao: { comentarios: 'Produção estável.', proximosPassos: '' },
  }, cookie);
  assert.equal(resp.status, 200);

  const lido = await (await buscarComentarios('2026-08')).json();
  // Produção foi salvo agora...
  assert.equal(lido.producao.comentarios, 'Produção estável.');
  // ...e Segurança (salvo no teste anterior) continua intacto.
  assert.equal(lido.seguranca.comentarios, 'Nenhuma ocorrência grave no mês.');
  assert.equal(lido.seguranca.proximosPassos, 'Reforçar treinamento de EPI.');
});

test('"Assuntos Gerais" enviado como string solta (compat) é salvo como {texto, fotos: []} e mesclado do mesmo jeito', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await salvarComentarios({ mes: '2026-08', assuntosGerais: 'Reunião geral marcada pra dia 05.' }, cookie);
  assert.equal(resp.status, 200);

  const lido = await (await buscarComentarios('2026-08')).json();
  assert.deepEqual(lido.assuntosGerais, { texto: 'Reunião geral marcada pra dia 05.', fotos: [] });
  // Blocos salvos antes continuam intactos.
  assert.equal(lido.seguranca.comentarios, 'Nenhuma ocorrência grave no mês.');
  assert.equal(lido.producao.comentarios, 'Produção estável.');
});

// Data-URI mínima válida (PNG 1x1 transparente) — só precisa começar com
// "data:image/" pra passar na validação; o conteúdo real não importa aqui.
const FOTO_VALIDA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('"Assuntos Gerais" com fotos: salva tema de cada uma e gera id no servidor', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await salvarComentarios({
    mes: '2026-08',
    assuntosGerais: {
      texto: 'DDS realizado.',
      fotos: [
        { imagem: FOTO_VALIDA, tema: 'DDS com colaboradores' },
        { imagem: FOTO_VALIDA, tema: 'Reparação tela silo' },
      ],
    },
  }, cookie);
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.assuntosGerais.fotos.length, 2);
  assert.equal(corpo.assuntosGerais.fotos[0].tema, 'DDS com colaboradores');
  assert.equal(corpo.assuntosGerais.fotos[1].tema, 'Reparação tela silo');
  // id gerado no servidor pra cada foto nova (front não manda id).
  assert.ok(corpo.assuntosGerais.fotos[0].id);
  assert.ok(corpo.assuntosGerais.fotos[1].id);
  assert.notEqual(corpo.assuntosGerais.fotos[0].id, corpo.assuntosGerais.fotos[1].id);

  const lido = await (await buscarComentarios('2026-08')).json();
  assert.equal(lido.assuntosGerais.fotos.length, 2);
});

test('"Assuntos Gerais" com fotos: id enviado pelo front (foto já existente, só editando o tema) é preservado', async () => {
  const cookie = await logarComoAdminMaster();
  const primeira = await (await salvarComentarios({
    mes: '2026-08',
    assuntosGerais: { texto: '', fotos: [{ imagem: FOTO_VALIDA, tema: 'Tema original' }] },
  }, cookie)).json();
  const idGerado = primeira.assuntosGerais.fotos[0].id;

  const segunda = await (await salvarComentarios({
    mes: '2026-08',
    assuntosGerais: { texto: '', fotos: [{ id: idGerado, imagem: FOTO_VALIDA, tema: 'Tema editado' }] },
  }, cookie)).json();

  assert.equal(segunda.assuntosGerais.fotos.length, 1);
  assert.equal(segunda.assuntosGerais.fotos[0].id, idGerado);
  assert.equal(segunda.assuntosGerais.fotos[0].tema, 'Tema editado');
});

test('"Assuntos Gerais" com mais de 12 fotos é recusado (400), nada é gravado', async () => {
  const cookie = await logarComoAdminMaster();
  const fotos = Array.from({ length: 13 }, () => ({ imagem: FOTO_VALIDA, tema: '' }));
  const resp = await salvarComentarios({ mes: '2026-08', assuntosGerais: { texto: '', fotos } }, cookie);
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);
  assert.match(corpo.erro, /12/);
});

test('"Assuntos Gerais" com foto que não é imagem válida (não começa com data:image/) é recusado (400)', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await salvarComentarios({
    mes: '2026-08',
    assuntosGerais: { texto: '', fotos: [{ imagem: 'data:application/pdf;base64,AAAA', tema: 'não é foto' }] },
  }, cookie);
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);
  assert.match(corpo.erro, /imagem/i);
});

test('meses diferentes não se misturam: salvar agosto não mexe em julho', async () => {
  const cookie = await logarComoAdminMaster();
  await salvarComentarios({
    mes: '2026-07',
    refugo: { comentarios: 'Refugo de julho.', proximosPassos: '' },
  }, cookie);

  const julho = await (await buscarComentarios('2026-07')).json();
  assert.equal(julho.refugo.comentarios, 'Refugo de julho.');
  assert.equal(julho.seguranca.comentarios, ''); // julho nunca teve Segurança salva

  const agosto = await (await buscarComentarios('2026-08')).json();
  assert.equal(agosto.refugo.comentarios, ''); // agosto nunca teve Refugo salvo
  assert.equal(agosto.seguranca.comentarios, 'Nenhuma ocorrência grave no mês.'); // continua intacto
});
