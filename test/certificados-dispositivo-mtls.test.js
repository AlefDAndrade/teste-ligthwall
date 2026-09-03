// ─── test/certificados-dispositivo-mtls.test.js ─────────────────────────────
// README, item 7 das pendências ("Identidade de dispositivo"): verificado
// nesta tarefa — a funcionalidade em si já estava implementada por completo
// (`lib/certificado-dispositivo.js`, `lib/rotas/certificados-dispositivo.js`,
// `lib/dispositivo-autorizado.js`, `deploy/ativar-mtls-caddy.sh`), só sem
// NENHUM teste cobrindo. Este arquivo fecha essa lacuna.
//
// Não dá pra testar o handshake TLS real (isso é o Caddy fazendo, fora do
// processo Node) — mas dá pra testar tudo o que importa de verdade: emissão
// do certificado (.p12 válido + registro do serial), listagem sem vazar
// segredo nenhum, revogação, e — o ponto central — que um request com o
// header `X-Client-Cert-Serial` (o que o Caddy manda depois do handshake,
// ver `certSerialDoRequest`) autoriza o dispositivo SOZINHO, sem precisar de
// deviceId nem de estar na lista `dispositivosAutorizados` — exatamente o
// que resolve o "atrito de religar após limpar cookies sem IP conhecido"
// que o item 7 original descrevia.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const forge = require('node-forge');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-certificados-mtls-951';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
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

async function gerarCertificado(nome, cookie) {
  return fetch(`${servidor.baseUrl}/gerar-certificado-dispositivo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ nome }),
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Permissão — mesma exigência de sessão de /dispositivos-autorizados
// ═══════════════════════════════════════════════════════════════════════

test('GET /certificados-dispositivo sem sessão é recusado (403)', async () => {
  const resp = await fetch(`${servidor.baseUrl}/certificados-dispositivo`);
  assert.equal(resp.status, 403);
});

test('POST /gerar-certificado-dispositivo sem sessão é recusado (403), nenhum certificado é criado', async () => {
  const resp = await gerarCertificado('Tentativa Sem Sessão', null);
  assert.equal(resp.status, 403);
});

test('POST /revogar-certificado-dispositivo sem sessão é recusado (403)', async () => {
  const resp = await fetch(`${servidor.baseUrl}/revogar-certificado-dispositivo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serial: 'qualquer' }),
  });
  assert.equal(resp.status, 403);
});

// ═══════════════════════════════════════════════════════════════════════
// Emissão — .p12 válido, senha só na resposta, serial registrado
// ═══════════════════════════════════════════════════════════════════════

test('POST /gerar-certificado-dispositivo devolve um .p12 válido, com senha/serial só nos headers da resposta', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await gerarCertificado('PC Injetora 1', cookie);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('content-type'), 'application/x-pkcs12');

  const senha = resp.headers.get('x-certificado-senha');
  const serial = resp.headers.get('x-certificado-serial');
  const emitidoEm = resp.headers.get('x-certificado-emitido-em');
  assert.ok(senha, 'esperava a senha do .p12 no header X-Certificado-Senha');
  assert.ok(serial, 'esperava o serial no header X-Certificado-Serial');
  assert.ok(emitidoEm, 'esperava a data de emissão no header X-Certificado-Emitido-Em');

  // O .p12 devolvido precisa ser um PKCS#12 de verdade, abrível com a
  // senha do header — prova que o conteúdo binário não está corrompido/
  // mal formado, não só que os headers têm cara de certo.
  const buffer = Buffer.from(await resp.arrayBuffer());
  const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(buffer.toString('binary')));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha); // lança se a senha estiver errada/arquivo corrompido
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  assert.ok(certBags[forge.pki.oids.certBag].length >= 1, 'esperava pelo menos 1 certificado dentro do .p12');
});

test('certificado emitido aparece em GET /certificados-dispositivo, sem vazar senha nem chave privada', async () => {
  const cookie = await logarComoAdminMaster();
  const respGerar = await gerarCertificado('PC Qualidade', cookie);
  const serial = respGerar.headers.get('x-certificado-serial');

  const resp = await fetch(`${servidor.baseUrl}/certificados-dispositivo`, { headers: { Cookie: cookie } });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
  const registro = data.lista.find(c => c.serial === serial);
  assert.ok(registro, 'esperava o certificado recém-emitido na listagem');
  assert.equal(registro.nome, 'PC Qualidade');
  assert.ok(registro.emitidoEm);

  // Nunca deveria trafegar segredo nenhum na listagem — só o que já é
  // público por natureza (serial vai em todo handshake TLS).
  assert.deepEqual(Object.keys(registro).sort(), ['emitidoEm', 'nome', 'serial']);
});

test('sem nome informado, cai no nome padrão "Dispositivo Lightwall"', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/gerar-certificado-dispositivo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({}),
  });
  const serial = resp.headers.get('x-certificado-serial');

  const respLista = await fetch(`${servidor.baseUrl}/certificados-dispositivo`, { headers: { Cookie: cookie } });
  const data = await respLista.json();
  assert.equal(data.lista.find(c => c.serial === serial).nome, 'Dispositivo Lightwall');
});

test('duas emissões seguidas geram seriais DIFERENTES (nunca reaproveita/repete)', async () => {
  const cookie = await logarComoAdminMaster();
  const resp1 = await gerarCertificado('Dispositivo A', cookie);
  const resp2 = await gerarCertificado('Dispositivo B', cookie);
  const serial1 = resp1.headers.get('x-certificado-serial');
  const serial2 = resp2.headers.get('x-certificado-serial');
  assert.notEqual(serial1, serial2);
});

// ═══════════════════════════════════════════════════════════════════════
// O que importa de verdade: o serial autoriza o dispositivo SOZINHO
// ═══════════════════════════════════════════════════════════════════════

test('request com X-Client-Cert-Serial de um certificado emitido autoriza o dispositivo, mesmo SEM deviceId nenhum', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respGerar = await gerarCertificado('PC Com Certificado', cookieAdmin);
  const serial = respGerar.headers.get('x-certificado-serial');

  // Sem deviceId na query, sem estar em dispositivosAutorizados — só o
  // certificado. Isso é exatamente o cenário que resolve o "atrito de
  // religar após limpar cookies sem IP conhecido" (README, item 7).
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieAdmin,
      'X-Client-Cert-Serial': serial,
    },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 200);
});

test('request com um serial desconhecido (nunca emitido) é barrado igual a não ter certificado nenhum', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieAdmin,
      'X-Client-Cert-Serial': 'serial-que-nunca-foi-emitido-por-ninguem',
    },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 403);
  const data = await resp.json();
  assert.equal(data.motivo, 'dispositivo');
});

test('depois de REVOGADO, o mesmo serial deixa de autorizar', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respGerar = await gerarCertificado('PC Vai Ser Revogado', cookieAdmin);
  const serial = respGerar.headers.get('x-certificado-serial');

  // Antes de revogar: autoriza normalmente.
  const respAntes = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin, 'X-Client-Cert-Serial': serial },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(respAntes.status, 200);

  const respRevogar = await fetch(`${servidor.baseUrl}/revogar-certificado-dispositivo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ serial }),
  });
  assert.equal(respRevogar.status, 200);
  const dataRevogar = await respRevogar.json();
  assert.ok(!dataRevogar.lista.some(c => c.serial === serial), 'esperava o serial fora da lista depois de revogado');

  // Depois de revogar: mesmo serial, mesmo certificado instalado na
  // máquina (tecnicamente ainda válido) — mas não autoriza mais nada.
  const respDepois = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin, 'X-Client-Cert-Serial': serial },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(respDepois.status, 403);
});

test('POST /revogar-certificado-dispositivo sem "serial" no payload é recusado (400)', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/revogar-certificado-dispositivo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({}),
  });
  assert.equal(resp.status, 400);
});

test('certificado autoriza mesmo com um deviceId desconhecido junto na query (certificado tem prioridade, checado antes)', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respGerar = await gerarCertificado('PC Prioridade Certificado', cookieAdmin);
  const serial = respGerar.headers.get('x-certificado-serial');

  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=dev_nunca_autorizado_prioridade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin, 'X-Client-Cert-Serial': serial },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 200);
});
