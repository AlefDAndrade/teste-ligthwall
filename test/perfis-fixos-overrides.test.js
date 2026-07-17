// ─── test/perfis-fixos-overrides.test.js ────────────────────────────────────
// Testa a engrenagem ⚙️ ao lado do campo "Perfil" em Configurações →
// Usuários (voltou — ver conversa que motivou a mudança): agora dá pra
// editar as permissões item-a-item (Acesso Total / Apenas Visualizar /
// Ocultar) de um dos 6 perfis FIXOS do sistema, não só criar perfis
// CUSTOMIZADOS do zero. Rotas: GET /permissoes-perfil-fixo,
// POST /salvar-permissoes-perfil-fixo, POST /restaurar-permissoes-perfil-fixo
// (ver lib/rotas/usuarios.js, lib/perfis-fixos-overrides.js).
//
// Sem override salvo = comportamento hardcoded de sempre (lib/perfis.js);
// com override, o mapa salvo manda de verdade nas rotas de escrita — ver
// podeEditarArea()/podeControlarOperacao(), server.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-perfis-fixos-753';
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

async function cadastrarECriarSessao(nomeUsuario, perfil, podeIniciarOperacao) {
  const cookieAdmin = await logarComoAdminMaster();
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario, senha: 'senhateste1234', perfil, podeIniciarOperacao }]),
  });
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario, senha: 'senhateste1234' }),
  });
  return extrairCookie(respLogin);
}

test('GET /permissoes-perfil-fixo sem override devolve o padrão computado, sem exigir sessão', async () => {
  const resp = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=OperadorInjetora`);
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
  assert.equal(data.temOverride, false);
  // OperadorInjetora tem 'injetora' e 'paradas' de edição (lib/perfis.js)
  // — "Registrar Operação" (area: injetora) deve vir 'total'.
  assert.equal(data.permissoes.operacao, 'total');
  // 'qualidade' NÃO está na lista de áreas de OperadorInjetora — o item
  // ligado a essa área deve vir só 'visualizar' (visualização aberta),
  // nunca 'total'.
  assert.equal(data.permissoes['qualidade-avaliacao'], 'visualizar');
});

test('GET /permissoes-perfil-fixo com perfil inválido (não é um dos 6 fixos) devolve 400', async () => {
  const resp = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=NaoExiste`);
  assert.equal(resp.status, 400);
});

test('POST /salvar-permissoes-perfil-fixo exige sessão de administrador', async () => {
  const resp = await fetch(`${servidor.baseUrl}/salvar-permissoes-perfil-fixo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ perfil: 'OperadorInjetora', permissoes: {} }),
  });
  assert.equal(resp.status, 403);
});

test('Administrador concede "qualidade" pra OperadorInjetora via override — passa a valer de verdade numa rota de escrita', async () => {
  const cookieAdmin = await logarComoAdminMaster();

  // Confere a régua ANTES: sem override, OperadorInjetora não edita
  // qualidade — POST /registrar-avaliacao-qualidade tem que recusar.
  const cookieOperador = await cadastrarECriarSessao('joao.override.antes', 'OperadorInjetora', false);
  const respAntes = await fetch(`${servidor.baseUrl}/registrar-avaliacao-qualidade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOperador },
    body: JSON.stringify({ id: 'op-override-' + Date.now(), avaliacao: 'aprovado' }),
  });
  assert.equal(respAntes.status, 403);

  // Busca o mapa padrão atual (pra não perder o resto das permissões ao
  // salvar) e liga "Avaliação" (setor de qualidade, area: qualidade) pra
  // 'total'.
  const respPadrao = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=OperadorInjetora`);
  const { permissoes } = await respPadrao.json();
  const novasPermissoes = { ...permissoes, 'qualidade-avaliacao': 'total' };

  const respSalvar = await fetch(`${servidor.baseUrl}/salvar-permissoes-perfil-fixo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ perfil: 'OperadorInjetora', permissoes: novasPermissoes }),
  });
  assert.equal(respSalvar.status, 200);
  const dataSalvar = await respSalvar.json();
  assert.equal(dataSalvar.ok, true);
  assert.equal(dataSalvar.permissoes['qualidade-avaliacao'], 'total');

  // GET /permissoes-perfil-fixo agora reporta temOverride:true e o novo mapa.
  const respDepoisGet = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=OperadorInjetora`);
  const dataDepoisGet = await respDepoisGet.json();
  assert.equal(dataDepoisGet.temOverride, true);
  assert.equal(dataDepoisGet.permissoes['qualidade-avaliacao'], 'total');

  // GET /perfis também reflete a área de edição concedida agora.
  const respPerfis = await fetch(`${servidor.baseUrl}/perfis`);
  const dataPerfis = await respPerfis.json();
  assert.ok(dataPerfis.areasEdicaoPorPerfil.OperadorInjetora.includes('qualidade'));

  // Depois do override, um usuário NOVO com esse perfil consegue de fato
  // registrar uma avaliação de qualidade (a régua real mudou).
  const cookieOperadorDepois = await cadastrarECriarSessao('joao.override.depois', 'OperadorInjetora', false);
  const respDepois = await fetch(`${servidor.baseUrl}/registrar-avaliacao-qualidade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOperadorDepois },
    body: JSON.stringify({ id: 'op-override-' + Date.now(), avaliacao: 'aprovado' }),
  });
  assert.notEqual(respDepois.status, 403);

  // Restaura o padrão — a régua volta a barrar.
  const respRestaurar = await fetch(`${servidor.baseUrl}/restaurar-permissoes-perfil-fixo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ perfil: 'OperadorInjetora' }),
  });
  assert.equal(respRestaurar.status, 200);

  const respGetFinal = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=OperadorInjetora`);
  const dataGetFinal = await respGetFinal.json();
  assert.equal(dataGetFinal.temOverride, false);
  assert.equal(dataGetFinal.permissoes['qualidade-avaliacao'], 'visualizar');

  const cookieOperadorRestaurado = await cadastrarECriarSessao('joao.override.restaurado', 'OperadorInjetora', false);
  const respRestauradoTeste = await fetch(`${servidor.baseUrl}/registrar-avaliacao-qualidade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOperadorRestaurado },
    body: JSON.stringify({ id: 'op-override-' + Date.now(), avaliacao: 'aprovado' }),
  });
  assert.equal(respRestauradoTeste.status, 403);
});

test('override não afeta outros perfis fixos que não foram customizados', async () => {
  const resp = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=AssistenteQualidade`);
  const data = await resp.json();
  assert.equal(data.temOverride, false);
  // AssistenteQualidade continua com 'qualidade' de edição normalmente,
  // independente do que foi feito com OperadorInjetora no teste anterior.
  assert.equal(data.permissoes['qualidade-avaliacao'], 'total');
});

test('POST /salvar-permissoes-perfil-fixo recusa perfil que não é um dos 6 fixos', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/salvar-permissoes-perfil-fixo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ perfil: 'NaoExiste', permissoes: {} }),
  });
  assert.equal(resp.status, 400);
});
