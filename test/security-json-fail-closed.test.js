// ─── test/security-json-fail-closed.test.js ─────────────────────────────────
// Cobre a mudança em lib/auth.js: security.json ausente/corrompido não deve
// mais cair pro hash fixo hardcoded no código (HASH_FALLBACK, removido) —
// ver conversa que motivou isso. Dois cenários bem diferentes:
//
//   1. Arquivo NUNCA existiu (1ª execução) → bootstrap: gera senha
//      ALEATÓRIA por instalação, salva já hasheada, e a mostra uma vez no
//      log do servidor. Continua dando pra logar — só que com uma senha
//      que ninguém mais sabe de antemão (nem quem lê o código-fonte).
//   2. Arquivo EXISTE mas está corrompido (JSON inválido) → falha
//      FECHADA: nenhuma senha funciona, rotas de auth respondem 503, não
//      200/{ok:false} nem um login "silenciosamente aceito".
//
// Como rodar: node --test test/security-json-fail-closed.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

test('1ª execução (sem security.json): boot gera security.json com senha aleatória (não é mais o hash fixo antigo)', async () => {
  // Sem seedSecurityJson — simula instalação nova de verdade, do zero.
  const servidor = await iniciarServidorDeTeste({});
  try {
    // security.json é criado sob demanda, na 1ª vez que lerSecurity() roda
    // — não no boot em si — então uma tentativa de login (mesmo errada)
    // já dispara o bootstrap.
    await fetch(`${servidor.baseUrl}/verificar-senha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: 'gatilho-do-bootstrap' }),
    });

    const securityPath = path.join(servidor.pastaTemp, 'private', 'security.json');
    assert.ok(fs.existsSync(securityPath), 'security.json deveria ter sido criado na 1ª chamada que precisou dele');

    const conteudo = JSON.parse(fs.readFileSync(securityPath, 'utf8'));
    assert.ok(conteudo.passwordHash.startsWith('scrypt:'), 'a senha inicial já nasce no formato forte (scrypt), não SHA-256 puro');

    // O antigo HASH_FALLBACK era o MESMO valor sempre, hardcoded — o novo
    // comportamento gera um hash DIFERENTE a cada instalação (salt
    // aleatório do scrypt sozinho já garante isso, mas o ponto central é
    // que a senha em texto puro também é sorteada por instalação, nunca
    // fixa no código).
    const HASH_FALLBACK_ANTIGO = 'c415e920e0281339d3633ab0c19d3b11c5a70a52ad2e17e405ef66723c51294c';
    assert.notEqual(conteudo.passwordHash, HASH_FALLBACK_ANTIGO);

    // A senha em texto puro só existe no log do servidor — não dá pra
    // prever aqui, então o teste só confirma que ela NÃO é vazia/óbvia via
    // tentativa de login com string vazia ou um valor comum.
    const tentativaObvia = await fetch(`${servidor.baseUrl}/verificar-senha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: 'admin' }),
    });
    const dadosTentativaObvia = await tentativaObvia.json();
    assert.equal(dadosTentativaObvia.ok, false, 'uma senha óbvia/comum não deveria funcionar contra a senha sorteada');
  } finally {
    await servidor.parar();
  }
});

test('security.json corrompido (JSON inválido): /verificar-senha falha FECHADA (503), não aceita nenhuma senha', async () => {
  const servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: 'scrypt:aa:bb', recoveryKeyHash: null },
  });
  try {
    const securityPath = path.join(servidor.pastaTemp, 'private', 'security.json');
    assert.ok(fs.existsSync(securityPath), 'pré-condição: security.json deveria existir (migrado no boot)');

    // Corrompe o arquivo DEPOIS do boot — simula disco com problema,
    // escrita interrompida no meio, etc.
    fs.writeFileSync(securityPath, '{ isso não é json válido ][', 'utf8');

    const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: 'qualquer-coisa' }),
    });
    assert.equal(resp.status, 503, 'deveria responder 503 (autenticação indisponível), nunca 200 com ok:true');

    const dados = await resp.json();
    assert.equal(dados.ok, false);

    // Confirma que NENHUM cookie de sessão foi emitido — a falha fechada
    // vale tanto pro corpo da resposta quanto pra ausência de sessão.
    // (Checa especificamente por lw_admin_sessao, não por "nenhum cookie":
    // o cookie de identidade de dispositivo — lw_device_id, ver
    // lib/dispositivo-cookie.js — é emitido na 1ª visita do navegador
    // independente de login/sessão, então pode legitimamente vir junto.)
    const cookies = typeof resp.headers.getSetCookie === 'function'
      ? resp.headers.getSetCookie()
      : [resp.headers.get('set-cookie') || ''];
    const cookieDeSessao = cookies.find(c => c.startsWith('lw_admin_sessao='));
    assert.ok(!cookieDeSessao, 'não deveria emitir cookie de sessão quando security.json está corrompido');
  } finally {
    await servidor.parar();
  }
});

test('security.json corrompido DEPOIS de uma sessão válida: GET /db/security.json responde 503, não inventa um hash', async () => {
  const SENHA_TESTE = 'senha-valida-pra-este-teste-456';
  const servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: crypto.createHash('sha256').update(SENHA_TESTE, 'utf8').digest('hex'), recoveryKeyHash: null },
  });
  try {
    // 1. Loga normalmente ENQUANTO o arquivo ainda está íntegro — prova
    //    que a sessão em si é legítima, criada ANTES da corrupção.
    const respLogin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: SENHA_TESTE }),
    });
    const cookie = (respLogin.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie, 'pré-condição: login deveria funcionar com o arquivo íntegro');

    // 2. Corrompe o arquivo DEPOIS da sessão já emitida.
    const securityPath = path.join(servidor.pastaTemp, 'private', 'security.json');
    fs.writeFileSync(securityPath, '{ corrompido de propósito', 'utf8');

    // 3. Mesmo com sessão válida (cookie de antes ainda intacto), o
    //    endpoint não deve inventar um hash — deve falhar fechado.
    const resp = await fetch(`${servidor.baseUrl}/db/security.json`, { headers: { Cookie: cookie } });
    assert.equal(resp.status, 503, 'sessão válida não deveria bastar quando o arquivo por trás dela corrompeu');

    const dados = await resp.json();
    assert.equal(dados.ok, false);
  } finally {
    await servidor.parar();
  }
});
