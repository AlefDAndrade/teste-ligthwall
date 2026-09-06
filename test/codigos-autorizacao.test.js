// ─── test/codigos-autorizacao.test.js ──────────────────────────────────────
// Testes do fluxo alternativo de autorização de dispositivo por código +
// arquivo (ver lib/codigos-autorizacao.js, lib/rotas/codigos-autorizacao.js):
// Administrador gera um código com nome, a pessoa no outro computador manda
// o CONTEÚDO de um .txt com esse código (sem sessão nenhuma — rota
// pública), e o dispositivo passa a valer em dispositivoAutorizado()
// exatamente como se tivesse sido autorizado manualmente.
//
// Roda contra o server.js DE VERDADE numa cópia isolada — ver
// test/helpers/servidor-teste.js (mesmo padrão de test/auth.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_TESTE = 'senha-de-teste-codigos-autorizacao';
const HASH_SENHA_TESTE = crypto.createHash('sha256').update(SENHA_TESTE, 'utf8').digest('hex');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_SENHA_TESTE, recoveryKeyHash: HASH_SENHA_TESTE },
  });
});

after(async () => {
  await servidor.parar();
});

function extrairCookie(resposta, nomeCookie) {
  const cookies = typeof resposta.headers.getSetCookie === 'function'
    ? resposta.headers.getSetCookie()
    : [resposta.headers.get('set-cookie') || ''];
  const alvo = cookies.find(c => c.startsWith(nomeCookie + '='));
  return alvo ? alvo.split(';')[0] : null;
}

async function logarComoAdmin() {
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_TESTE }),
  });
  const cookie = extrairCookie(resp, 'lw_admin_sessao');
  assert.ok(cookie, 'login deveria emitir um cookie de sessão de admin');
  return cookie;
}

// Simula uma "visita" de um dispositivo ainda sem cookie de identidade:
// bate numa rota qualquer, sem Cookie nenhum, e captura o lw_device_id
// que o servidor emite sozinho (ver lib/dispositivo-cookie.js).
async function novoDeviceIdDeTeste() {
  const resp = await fetch(`${servidor.baseUrl}/login.html`);
  const cookie = extrairCookie(resp, 'lw_device_id');
  assert.ok(cookie, 'servidor deveria emitir um lw_device_id pra visita sem cookie');
  return cookie; // "lw_device_id=dev_xxx" — pronto pro header Cookie de requests seguintes
}

test('gerar código exige sessão de admin', async () => {
  const resp = await fetch(`${servidor.baseUrl}/gerar-codigo-autorizacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'PC Teste Sem Sessão' }),
  });
  assert.equal(resp.status, 403);
  const data = await resp.json();
  assert.equal(data.ok, false);
});

test('gerar código sem nome é recusado', async () => {
  const cookieAdmin = await logarComoAdmin();
  const resp = await fetch(`${servidor.baseUrl}/gerar-codigo-autorizacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: '  ' }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);
  assert.match(data.erro, /nome/i);
});

test('fluxo completo: gerar código → autorizar por arquivo → dispositivo passa a valer', async () => {
  const cookieAdmin = await logarComoAdmin();

  const respGerar = await fetch(`${servidor.baseUrl}/gerar-codigo-autorizacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'PC Injetora Teste' }),
  });
  assert.equal(respGerar.status, 200);
  const gerado = await respGerar.json();
  assert.equal(gerado.ok, true);
  assert.ok(gerado.entrada.codigo, 'deveria devolver o código gerado');
  assert.equal(gerado.entrada.usado, false);

  // Dispositivo novo, sem sessão nenhuma — só o cookie de identidade.
  const cookieDevice = await novoDeviceIdDeTeste();
  const deviceId = cookieDevice.split('=')[1];

  const respAutorizar = await fetch(
    `${servidor.baseUrl}/autorizar-dispositivo-por-arquivo?deviceId=${deviceId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieDevice },
      // Simula o conteúdo de um .txt salvo com espaço/quebra de linha ao
      // redor — deve ser tolerante (trim + case-insensitive).
      body: JSON.stringify({ conteudo: `  ${gerado.entrada.codigo.toLowerCase()}\n` }),
    }
  );
  assert.equal(respAutorizar.status, 200);
  const autorizado = await respAutorizar.json();
  assert.equal(autorizado.ok, true);
  assert.equal(autorizado.nome, 'PC Injetora Teste');

  // Confirma que o dispositivo passou a valer de verdade na lista principal
  // (a mesma que dispositivoAutorizado()/podeControlarOperacao() usam).
  const respLista = await fetch(`${servidor.baseUrl}/dispositivos-autorizados`, {
    headers: { Cookie: cookieAdmin },
  });
  const lista = (await respLista.json()).lista;
  const entrada = lista.find(d => d.deviceId === deviceId);
  assert.ok(entrada, 'dispositivo deveria aparecer na lista de autorizados');
  assert.equal(entrada.origemCodigo, 'PC Injetora Teste');
});

test('código já usado não pode ser reaproveitado por outro dispositivo', async () => {
  const cookieAdmin = await logarComoAdmin();

  const gerado = await (await fetch(`${servidor.baseUrl}/gerar-codigo-autorizacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'PC Uso Único' }),
  })).json();

  const cookieDevice1 = await novoDeviceIdDeTeste();
  const deviceId1 = cookieDevice1.split('=')[1];
  const primeiraTentativa = await fetch(
    `${servidor.baseUrl}/autorizar-dispositivo-por-arquivo?deviceId=${deviceId1}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieDevice1 },
      body: JSON.stringify({ conteudo: gerado.entrada.codigo }),
    }
  );
  assert.equal((await primeiraTentativa.json()).ok, true);

  const cookieDevice2 = await novoDeviceIdDeTeste();
  const deviceId2 = cookieDevice2.split('=')[1];
  const segundaTentativa = await fetch(
    `${servidor.baseUrl}/autorizar-dispositivo-por-arquivo?deviceId=${deviceId2}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieDevice2 },
      body: JSON.stringify({ conteudo: gerado.entrada.codigo }),
    }
  );
  assert.equal(segundaTentativa.status, 400);
  const dataSegunda = await segundaTentativa.json();
  assert.equal(dataSegunda.ok, false);
  assert.match(dataSegunda.erro, /inválido|usado|revogado/i);
});

test('código inexistente/errado é recusado', async () => {
  const cookieDevice = await novoDeviceIdDeTeste();
  const deviceId = cookieDevice.split('=')[1];
  const resp = await fetch(
    `${servidor.baseUrl}/autorizar-dispositivo-por-arquivo?deviceId=${deviceId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieDevice },
      body: JSON.stringify({ conteudo: 'XXXX-XXXX-XXXX-XXXX' }),
    }
  );
  assert.equal(resp.status, 400);
  assert.equal((await resp.json()).ok, false);
});

test('revogar código PENDENTE impede uso futuro', async () => {
  const cookieAdmin = await logarComoAdmin();
  const gerado = await (await fetch(`${servidor.baseUrl}/gerar-codigo-autorizacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'PC A Revogar Pendente' }),
  })).json();

  const respRevogar = await fetch(`${servidor.baseUrl}/revogar-codigo-autorizacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'PC A Revogar Pendente' }),
  });
  assert.equal(respRevogar.status, 200);
  assert.equal((await respRevogar.json()).ok, true);

  const cookieDevice = await novoDeviceIdDeTeste();
  const deviceId = cookieDevice.split('=')[1];
  const tentativa = await fetch(
    `${servidor.baseUrl}/autorizar-dispositivo-por-arquivo?deviceId=${deviceId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieDevice },
      body: JSON.stringify({ conteudo: gerado.entrada.codigo }),
    }
  );
  assert.equal(tentativa.status, 400);
  assert.equal((await tentativa.json()).ok, false);
});

test('revogar código já USADO remove a autorização do dispositivo na hora', async () => {
  const cookieAdmin = await logarComoAdmin();
  const gerado = await (await fetch(`${servidor.baseUrl}/gerar-codigo-autorizacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'PC A Revogar Depois De Usado' }),
  })).json();

  const cookieDevice = await novoDeviceIdDeTeste();
  const deviceId = cookieDevice.split('=')[1];
  await fetch(`${servidor.baseUrl}/autorizar-dispositivo-por-arquivo?deviceId=${deviceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieDevice },
    body: JSON.stringify({ conteudo: gerado.entrada.codigo }),
  });

  // Confirma que autorizou antes de revogar (evita falso positivo).
  let lista = (await (await fetch(`${servidor.baseUrl}/dispositivos-autorizados`, {
    headers: { Cookie: cookieAdmin },
  })).json()).lista;
  assert.ok(lista.some(d => d.deviceId === deviceId), 'deveria estar autorizado antes da revogação');

  const respRevogar = await fetch(`${servidor.baseUrl}/revogar-codigo-autorizacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'PC A Revogar Depois De Usado' }),
  });
  assert.equal((await respRevogar.json()).ok, true);

  lista = (await (await fetch(`${servidor.baseUrl}/dispositivos-autorizados`, {
    headers: { Cookie: cookieAdmin },
  })).json()).lista;
  assert.ok(!lista.some(d => d.deviceId === deviceId), 'revogar o código deveria remover a autorização do dispositivo');
});

test('revogar código com nome inexistente dá erro claro', async () => {
  const cookieAdmin = await logarComoAdmin();
  const resp = await fetch(`${servidor.baseUrl}/revogar-codigo-autorizacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Nome Que Nunca Existiu' }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);
  assert.match(data.erro, /não encontrado/i);
});

test('gerar dois códigos pendentes com o mesmo nome é recusado', async () => {
  const cookieAdmin = await logarComoAdmin();
  const primeira = await fetch(`${servidor.baseUrl}/gerar-codigo-autorizacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'PC Nome Duplicado' }),
  });
  assert.equal(primeira.status, 200);

  const segunda = await fetch(`${servidor.baseUrl}/gerar-codigo-autorizacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'PC Nome Duplicado' }),
  });
  assert.equal(segunda.status, 400);
  const data = await segunda.json();
  assert.match(data.erro, /já existe/i);
});

test('listar códigos exige sessão de admin', async () => {
  const resp = await fetch(`${servidor.baseUrl}/codigos-autorizacao`);
  assert.equal(resp.status, 403);
});

// Ponto explicitamente pedido: gerar/revogar/listar código é só do
// Administrador MASTER — diferente de Dispositivos Autorizados (essa sim
// aceita master OU perfil "Administrativo", ver lib/rotas/
// dispositivos-autorizados.js). Cria um usuário com perfil Administrativo,
// loga como ele, e confirma que as 3 rotas recusam mesmo assim.
test('perfil "Administrativo" (não-master) NÃO pode gerar/revogar/listar códigos', async () => {
  const cookieAdmin = await logarComoAdmin();

  const respSalvarUsuario = await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([
      { nomeUsuario: 'admin.perfil', senha: 'senhaadmperfil123', perfil: 'Administrativo' },
    ]),
  });
  assert.equal(respSalvarUsuario.status, 200);

  const respLoginUsuario = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'admin.perfil', senha: 'senhaadmperfil123' }),
  });
  assert.equal(respLoginUsuario.status, 200);
  const cookieUsuario = extrairCookie(respLoginUsuario, 'lw_usuario_sessao')
    || (respLoginUsuario.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookieUsuario, 'login do usuário Administrativo deveria emitir algum cookie de sessão');

  // Confirma primeiro que esse mesmo cookie TEM poderes de admin numa rota
  // que aceita "master OU Administrativo" (Dispositivos Autorizados) — só
  // pra provar que o cookie é válido e o teste não estaria passando "à
  // toa" por um cookie quebrado.
  const respDispositivos = await fetch(`${servidor.baseUrl}/dispositivos-autorizados`, {
    headers: { Cookie: cookieUsuario },
  });
  assert.equal(respDispositivos.status, 200, 'perfil Administrativo deveria conseguir ver Dispositivos Autorizados normalmente');

  // Mas nas 3 rotas de Código, deveria ser recusado (só master).
  const respListar = await fetch(`${servidor.baseUrl}/codigos-autorizacao`, {
    headers: { Cookie: cookieUsuario },
  });
  assert.equal(respListar.status, 403, 'perfil Administrativo NÃO deveria conseguir listar códigos');

  const respGerar = await fetch(`${servidor.baseUrl}/gerar-codigo-autorizacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify({ nome: 'PC Tentativa Via Perfil Administrativo' }),
  });
  assert.equal(respGerar.status, 403, 'perfil Administrativo NÃO deveria conseguir gerar código');

  const respRevogar = await fetch(`${servidor.baseUrl}/revogar-codigo-autorizacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify({ nome: 'qualquer' }),
  });
  assert.equal(respRevogar.status, 403, 'perfil Administrativo NÃO deveria conseguir revogar código');
});

test('rota pública de autorização por arquivo é bloqueada por rate limit após muitas tentativas erradas', async () => {
  const cookieDevice = await novoDeviceIdDeTeste();
  const deviceId = cookieDevice.split('=')[1];
  let ultimaResposta;
  // maxTentativas configurado em server.js é 10 — manda 11 erradas.
  for (let i = 0; i < 11; i++) {
    ultimaResposta = await fetch(
      `${servidor.baseUrl}/autorizar-dispositivo-por-arquivo?deviceId=${deviceId}-tentativa${i}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieDevice },
        body: JSON.stringify({ conteudo: 'codigo-errado-de-proposito' }),
      }
    );
  }
  assert.equal(ultimaResposta.status, 429);
  const data = await ultimaResposta.json();
  assert.equal(data.ok, false);
  assert.match(data.erro, /tentativas/i);
});
