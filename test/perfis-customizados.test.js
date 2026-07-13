// ─── test/perfis-customizados.test.js ───────────────────────────────────────
// Testa a criação de "Novo Tipo de Perfil" (Configurações → Usuários → "+
// Criar novo tipo de perfil" — ver lib/itens-permissao.js,
// lib/perfis-customizados.js, lib/rotas/perfis-customizados.js).
//
// Cobre: GET /catalogo-permissoes, CRUD via POST /criar-perfil-customizado,
// /editar-perfil-customizado, /excluir-perfil-customizado, a mesclagem com
// os 6 perfis fixos em GET /perfis, login/cadastro aceitando perfis
// customizados, e a PONTE entre o nível granular ("Acesso Total" num item)
// e as 5 áreas de edição já validadas de verdade no servidor
// (podeEditarArea/podeControlarOperacao, server.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-perfis-customizados-159';
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

// ═══════════════════════════════════════════════════════════════════════
// Catálogo
// ═══════════════════════════════════════════════════════════════════════

test('GET /catalogo-permissoes é público e lista os itens', async () => {
  const resp = await fetch(`${servidor.baseUrl}/catalogo-permissoes`);
  const data = await resp.json();
  assert.equal(resp.status, 200);
  assert.equal(data.ok, true);
  assert.deepEqual(data.niveis, ['total', 'visualizar', 'ocultar']);
  assert.ok(data.catalogo.some(i => i.id === 'operacao'));
  assert.ok(data.catalogo.some(i => i.id === 'manutencao-abertura' && i.pai === 'manutencao-corretiva'));
  assert.ok(data.catalogo.some(i => i.id === 'qualidade-avaliacao' && i.pai === 'setor-qualidade'));
});

// ═══════════════════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════════════════

test('POST /criar-perfil-customizado exige poderes de administrador', async () => {
  const resp = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'Sem Sessão', permissoes: {} }),
  });
  assert.equal(resp.status, 403);
});

test('criar um perfil customizado, listar e ver refletido em GET /perfis', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respCriar = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({
      nome: 'Líder de Turno',
      permissoes: { operacao: 'total', paradas: 'total', turnos: 'visualizar' },
    }),
  });
  const dataCriar = await respCriar.json();
  assert.equal(respCriar.status, 200);
  assert.equal(dataCriar.ok, true);
  assert.equal(dataCriar.perfil.nome, 'Líder de Turno');
  assert.equal(dataCriar.perfil.permissoes.operacao, 'total');
  // Item não mencionado no payload (ex: 'metas') fica oculto por padrão.
  assert.equal(dataCriar.perfil.permissoes.metas, 'ocultar');

  const idCriado = dataCriar.perfil.id;

  const respListar = await fetch(`${servidor.baseUrl}/perfis-customizados`);
  const dataListar = await respListar.json();
  assert.ok(dataListar.perfis.some(p => p.id === idCriado), 'GET /perfis-customizados é público e deveria listar o novo perfil');

  const respPerfis = await fetch(`${servidor.baseUrl}/perfis`);
  const dataPerfis = await respPerfis.json();
  assert.ok(dataPerfis.perfisCadastraveis.includes(idCriado), 'o perfil customizado deveria aparecer em perfisCadastraveis');
  assert.equal(dataPerfis.rotulosPorPerfil[idCriado], 'Líder de Turno');
  // paginasPorPerfil: só os itens != 'ocultar' aparecem.
  assert.ok(dataPerfis.paginasPorPerfil[idCriado].includes('operacao'));
  assert.ok(dataPerfis.paginasPorPerfil[idCriado].includes('turnos'));
  assert.ok(!dataPerfis.paginasPorPerfil[idCriado].includes('metas'), '"metas" não foi marcado, deveria estar oculto');
  // areasEdicaoPorPerfil: só os itens 'total' concedem a área.
  assert.ok(dataPerfis.areasEdicaoPorPerfil[idCriado].includes('injetora'), '"operacao" total concede a área injetora');
  assert.ok(dataPerfis.areasEdicaoPorPerfil[idCriado].includes('paradas'));
  assert.ok(!dataPerfis.areasEdicaoPorPerfil[idCriado].includes('qualidade'));
});

test('nome de perfil customizado duplicado é recusado', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Líder de Turno', permissoes: {} }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /já existe/i);
});

test('nome reservado (igual a um perfil fixo) é recusado', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Supervisao', permissoes: {} }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /reservado/i);
});

test('item de permissão desconhecido é recusado', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Perfil Item Invalido', permissoes: { 'item-que-nao-existe': 'total' } }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /não existe no catálogo/i);
});

test('nível de permissão inválido é recusado', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Perfil Nivel Invalido', permissoes: { operacao: 'super-total' } }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /nível/i);
});

test('editar um perfil customizado (nome e permissões)', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respCriar = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Perfil Editavel', permissoes: { operacao: 'visualizar' } }),
  });
  const { perfil } = await respCriar.json();

  const respEditar = await fetch(`${servidor.baseUrl}/editar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ id: perfil.id, nome: 'Perfil Editado', permissoes: { operacao: 'total' } }),
  });
  const dataEditar = await respEditar.json();
  assert.equal(respEditar.status, 200);
  assert.equal(dataEditar.perfil.nome, 'Perfil Editado');
  assert.equal(dataEditar.perfil.permissoes.operacao, 'total');
});

test('excluir um perfil customizado sem usuários vinculados funciona', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respCriar = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Perfil Descartavel', permissoes: {} }),
  });
  const { perfil } = await respCriar.json();

  const respExcluir = await fetch(`${servidor.baseUrl}/excluir-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ id: perfil.id }),
  });
  assert.equal(respExcluir.status, 200);

  const respListar = await fetch(`${servidor.baseUrl}/perfis-customizados`);
  const dataListar = await respListar.json();
  assert.ok(!dataListar.perfis.some(p => p.id === perfil.id));
});

test('excluir um perfil customizado EM USO por um usuário cadastrado é bloqueado', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respCriar = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Perfil Em Uso', permissoes: { paradas: 'total' } }),
  });
  const { perfil } = await respCriar.json();

  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'usuario.perfil.customizado', senha: 'senhateste1234', perfil: perfil.id }]),
  });

  const respExcluir = await fetch(`${servidor.baseUrl}/excluir-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ id: perfil.id }),
  });
  assert.equal(respExcluir.status, 400);
  const data = await respExcluir.json();
  assert.match(data.erro, /usuário.*cadastrado/i);
});

// ═══════════════════════════════════════════════════════════════════════
// Login e uso real de um usuário com perfil customizado
// ═══════════════════════════════════════════════════════════════════════

test('usuário com perfil customizado consegue logar e a sessão reflete o perfil', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respCriar = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Perfil Login Teste', permissoes: { paradas: 'total' } }),
  });
  const { perfil } = await respCriar.json();

  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'ana.perfil.custom', senha: 'senhateste1234', perfil: perfil.id }]),
  });

  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'ana.perfil.custom', senha: 'senhateste1234' }),
  });
  const dataLogin = await respLogin.json();
  assert.equal(respLogin.status, 200);
  assert.equal(dataLogin.perfil, perfil.id);
});

test('perfil customizado com item "paradas" total consegue de fato salvar uma parada (ponte área funciona)', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respCriar = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Perfil Paradas Total', permissoes: { paradas: 'total' } }),
  });
  const { perfil } = await respCriar.json();

  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'bruno.paradas.custom', senha: 'senhateste1234', perfil: perfil.id }]),
  });
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'bruno.paradas.custom', senha: 'senhateste1234' }),
  });
  const cookieUsuario = extrairCookie(respLogin);

  const respParada = await fetch(`${servidor.baseUrl}/salvar-parada`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify({ id: 'parada-custom-' + Date.now(), inicio: '2026-07-12T08:00', fim: '2026-07-12T08:10', motivo: 'Teste' }),
  });
  assert.equal(respParada.status, 200);
});

test('perfil customizado SEM o item "paradas" total é recusado em POST /salvar-parada', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respCriar = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Perfil Sem Paradas', permissoes: { paradas: 'visualizar', turnos: 'total' } }),
  });
  const { perfil } = await respCriar.json();

  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'carla.sem.paradas', senha: 'senhateste1234', perfil: perfil.id }]),
  });
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'carla.sem.paradas', senha: 'senhateste1234' }),
  });
  const cookieUsuario = extrairCookie(respLogin);

  const respParada = await fetch(`${servidor.baseUrl}/salvar-parada`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify({ id: 'parada-recusada-' + Date.now(), inicio: '2026-07-12T08:00', fim: '2026-07-12T08:10', motivo: 'Teste' }),
  });
  assert.equal(respParada.status, 403);
});

test('perfil customizado com "operacao" total + podeIniciarOperacao consegue controlar a operação', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respCriar = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Perfil Injetora Total', permissoes: { operacao: 'total' } }),
  });
  const { perfil } = await respCriar.json();

  // Perfil customizado com área injetora deveria aparecer em
  // perfisComControleDeOperacao (o checkbox "pode iniciar operações" só
  // faz sentido pra ele).
  const respPerfis = await fetch(`${servidor.baseUrl}/perfis`);
  const dataPerfis = await respPerfis.json();
  assert.ok(dataPerfis.perfisComControleDeOperacao.includes(perfil.id));

  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'diego.injetora.custom', senha: 'senhateste1234', perfil: perfil.id, podeIniciarOperacao: true }]),
  });
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'diego.injetora.custom', senha: 'senhateste1234' }),
  });
  const dataLogin = await respLogin.json();
  assert.equal(dataLogin.podeIniciarOperacao, true, 'perfil customizado com área injetora deveria poder marcar podeIniciarOperacao');
  const cookieUsuario = extrairCookie(respLogin);

  const respControle = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(respControle.status, 200);
});

test('perfil descontinuado não colide: perfil customizado com nome de um perfil fixo antigo ainda é recusado', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Administrador', permissoes: {} }),
  });
  assert.equal(resp.status, 400);
});
