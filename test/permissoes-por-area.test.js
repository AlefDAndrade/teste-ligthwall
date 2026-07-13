// ─── test/permissoes-por-area.test.js ───────────────────────────────────────
// Testa a matriz de permissões do modelo NOVO (ver lib/perfis.js): toda
// página é aberta pra VISUALIZAÇÃO a qualquer perfil; o que muda por perfil
// é a área de EDIÇÃO — 'injetora', 'paradas', 'qualidade', 'manutencao',
// 'manutencao-chamado'. Cada perfil:
//
//   OperadorInjetora ..... injetora, paradas
//   AssistenteQualidade .. qualidade, paradas
//   Encarregado .......... injetora, qualidade, paradas, manutencao-chamado
//   Manutencao ........... manutencao (completa), paradas
//   Supervisao ........... injetora, qualidade, paradas, manutencao (completa)
//   Administrativo ....... tudo (igual ao Administrador Master)
//
// Testa as rotas de ESCRITA de cada domínio (paradas, setor de qualidade,
// histórico de injetora, manutenção) via HTTP direto contra o servidor
// real — mesmo padrão de test/permissao-controlar-operacao.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-permissoes-area-741';
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

async function cadastrarELogar(nomeUsuario, perfil) {
  const cookieAdmin = await logarComoAdminMaster();
  const respAtuais = await fetch(`${servidor.baseUrl}/usuarios`);
  const { usuarios: atuais } = await respAtuais.json();
  const listaParaEnviar = [
    ...atuais.map(u => ({ id: u.id, nomeUsuario: u.nomeUsuario, perfil: u.perfil, podeIniciarOperacao: u.podeIniciarOperacao })),
    { nomeUsuario, senha: 'senhateste1234', perfil },
  ];
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify(listaParaEnviar),
  });
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario, senha: 'senhateste1234' }),
  });
  return extrairCookie(respLogin);
}

// ═══════════════════════════════════════════════════════════════════════
// Área 'paradas' — hoje todo perfil cadastrável tem, mas a rota exige
// pelo menos UMA sessão de usuário válida (sem sessão nenhuma, recusa).
// ═══════════════════════════════════════════════════════════════════════

test('sem sessão nenhuma, POST /salvar-parada é recusado', async () => {
  const resp = await fetch(`${servidor.baseUrl}/salvar-parada`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'parada-sem-sessao-' + Date.now(), inicio: '2026-07-12T08:00', motivo: 'Teste' }),
  });
  assert.equal(resp.status, 403);
});

test('OperadorInjetora consegue salvar e excluir uma parada', async () => {
  const cookie = await cadastrarELogar('rafael.paradas', 'OperadorInjetora');
  const id = 'parada-rafael-' + Date.now();
  const respSalvar = await fetch(`${servidor.baseUrl}/salvar-parada`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id, inicio: '2026-07-12T08:00', fim: '2026-07-12T08:10', motivo: 'Teste', classificacao: 'Planejada' }),
  });
  assert.equal(respSalvar.status, 200);

  const respExcluir = await fetch(`${servidor.baseUrl}/excluir-parada`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id }),
  });
  assert.equal(respExcluir.status, 200);
});

// ═══════════════════════════════════════════════════════════════════════
// Área 'qualidade' — Assistente de Qualidade, Encarregado, Supervisão,
// Administrador podem; Operador de Injetora e Manutenção não.
// ═══════════════════════════════════════════════════════════════════════

test('OperadorInjetora (sem área qualidade) é recusado em POST /marcar-operacao-avaliada', async () => {
  const cookie = await cadastrarELogar('igor.operador.qual', 'OperadorInjetora');
  const resp = await fetch(`${servidor.baseUrl}/marcar-operacao-avaliada`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: 'op-qualquer' }),
  });
  assert.equal(resp.status, 403);
  const data = await resp.json();
  assert.match(data.erro, /qualidade/i);
});

test('Manutencao (sem área qualidade) é recusado em POST /registrar-avaliacao-qualidade', async () => {
  const cookie = await cadastrarELogar('marcos.manut.qual', 'Manutencao');
  const resp = await fetch(`${servidor.baseUrl}/registrar-avaliacao-qualidade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: 'ev-recusado', batteryId: 'B1', turno: '1° TURNO', paineis: [] }),
  });
  assert.equal(resp.status, 403);
});

test('AssistenteQualidade consegue registrar uma avaliação de qualidade', async () => {
  const cookie = await cadastrarELogar('bianca.qualidade', 'AssistenteQualidade');
  const idOp = 'op-bianca-' + Date.now();
  await fetch(`${servidor.baseUrl}/registrar-operacao?modoTeste=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: idOp, data: '2026-07-12', turno: '1° TURNO', dimensao: 9, capacidade: 20, id_bateria: 'B5' }),
  });
  const resp = await fetch(`${servidor.baseUrl}/registrar-avaliacao-qualidade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: 'ev-bianca-' + Date.now(), batteryId: 'B5', linkedOperacaoId: idOp, turno: '1° TURNO', paineis: [] }),
  });
  // Pode falhar por regra de negócio (ex: vínculo com operação real via
  // modoTeste), mas NUNCA por falta de permissão de área (403).
  assert.notEqual(resp.status, 403);
});

test('Encarregado e Supervisao têm área qualidade (não são recusados por permissão)', async () => {
  for (const perfil of ['Encarregado', 'Supervisao']) {
    const cookie = await cadastrarELogar('teste.' + perfil.toLowerCase(), perfil);
    const resp = await fetch(`${servidor.baseUrl}/marcar-operacao-avaliada`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ id: 'op-inexistente-' + perfil }),
    });
    assert.notEqual(resp.status, 403, `${perfil} deveria ter área qualidade de edição`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Área 'injetora' — editar histórico (operação/traço) exige a área
// 'injetora', não mais exclusivamente a sessão de Admin Master.
// ═══════════════════════════════════════════════════════════════════════

test('AssistenteQualidade (sem área injetora) é recusada em POST /editar-operacao', async () => {
  const cookie = await cadastrarELogar('paula.qual.editar', 'AssistenteQualidade');
  const resp = await fetch(`${servidor.baseUrl}/editar-operacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: 'op-qualquer', novosValores: {}, diff: [] }),
  });
  assert.equal(resp.status, 403);
});

test('OperadorInjetora (tem área injetora) não é recusado por permissão em POST /editar-operacao', async () => {
  const cookie = await cadastrarELogar('otavio.editor', 'OperadorInjetora');
  const resp = await fetch(`${servidor.baseUrl}/editar-operacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: 'op-inexistente-otavio', novosValores: {}, diff: [] }),
  });
  // Pode falhar por não achar o registro (400), mas não por permissão (403).
  assert.notEqual(resp.status, 403);
});

// ═══════════════════════════════════════════════════════════════════════
// Área 'manutencao' vs 'manutencao-chamado' — Encarregado só abre chamado
// (não fecha, não mexe em programada/almoxarifado); Manutencao/Supervisao/
// Administrador têm acesso completo.
// ═══════════════════════════════════════════════════════════════════════

test('Encarregado consegue abrir um chamado corretivo novo', async () => {
  const cookie = await cadastrarELogar('elisa.encarregada', 'Encarregado');
  const id = 'MAN-encarregado-' + Date.now();
  const resp = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id, data: '2026-07-12', setor: 'Producao', maquina: 'Injetora 9',
      observador: 'Elisa', prioridade: 'Alta', anomalia: 'Teste', tipoManutencao: 'Mecanica',
    }),
  });
  assert.equal(resp.status, 200);
});

test('Encarregado NÃO consegue fechar um chamado (etiquetaFechada), só abrir', async () => {
  const cookie = await cadastrarELogar('felipe.encarregado', 'Encarregado');
  const id = 'MAN-fechar-encarregado-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id, data: '2026-07-12', setor: 'Producao', maquina: 'Injetora 8',
      observador: 'Felipe', prioridade: 'Alta', anomalia: 'Teste', tipoManutencao: 'Mecanica',
    }),
  });

  const respFechar = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id, data: '2026-07-12', setor: 'Producao', maquina: 'Injetora 8',
      observador: 'Felipe', prioridade: 'Alta', anomalia: 'Teste', tipoManutencao: 'Mecanica',
      situacao: 'Concluido', etiquetaFechada: true,
    }),
  });
  assert.equal(respFechar.status, 403);
});

test('Encarregado é recusado em POST /manutencao/programada (não tem área manutencao completa)', async () => {
  const cookie = await cadastrarELogar('gustavo.encarregado', 'Encarregado');
  const resp = await fetch(`${servidor.baseUrl}/manutencao/programada`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: 'PRG-encarregado', data: '2026-07-20', setor: 'Producao', maquina: 'Injetora 7', solicitante: 'Gustavo' }),
  });
  assert.equal(resp.status, 403);
});

test('Manutencao consegue fechar um chamado corretivo (área manutencao completa)', async () => {
  const cookie = await cadastrarELogar('helena.manutencao', 'Manutencao');
  const id = 'MAN-fechar-manut-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id, data: '2026-07-12', setor: 'Producao', maquina: 'Injetora 6',
      observador: 'Helena', prioridade: 'Alta', anomalia: 'Teste', tipoManutencao: 'Mecanica',
    }),
  });

  const respFechar = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id, data: '2026-07-12', setor: 'Producao', maquina: 'Injetora 6',
      observador: 'Helena', prioridade: 'Alta', anomalia: 'Teste', tipoManutencao: 'Mecanica',
      situacao: 'Concluido', etiquetaFechada: true,
    }),
  });
  assert.equal(respFechar.status, 200);
});

test('Supervisao tem acesso completo à manutenção (programada, estoque, movimentações)', async () => {
  const cookie = await cadastrarELogar('ivo.supervisor', 'Supervisao');
  const respProg = await fetch(`${servidor.baseUrl}/manutencao/programada`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: 'PRG-supervisao-' + Date.now(), data: '2026-07-20', setor: 'Producao', maquina: 'Injetora 5', solicitante: 'Ivo' }),
  });
  assert.equal(respProg.status, 200);
});

test('Administrativo tem acesso completo à manutenção, igual ao master', async () => {
  const cookie = await cadastrarELogar('julia.admin', 'Administrativo');
  const id = 'MAN-admin-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id, data: '2026-07-12', setor: 'Producao', maquina: 'Injetora 4',
      observador: 'Julia', prioridade: 'Alta', anomalia: 'Teste', tipoManutencao: 'Mecanica',
    }),
  });
  const respFechar = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id, data: '2026-07-12', setor: 'Producao', maquina: 'Injetora 4',
      observador: 'Julia', prioridade: 'Alta', anomalia: 'Teste', tipoManutencao: 'Mecanica',
      situacao: 'Concluido', etiquetaFechada: true,
    }),
  });
  assert.equal(respFechar.status, 200);
});

// ═══════════════════════════════════════════════════════════════════════
// Configurações — só master e Administrativo têm poderes de admin
// (backup, SQL, importação, gerenciar usuários).
// ═══════════════════════════════════════════════════════════════════════

test('Supervisao (não é admin) é recusada em GET /db/usuarios.json', async () => {
  const cookie = await cadastrarELogar('karina.supervisao', 'Supervisao');
  const resp = await fetch(`${servidor.baseUrl}/db/usuarios.json`, { headers: { Cookie: cookie } });
  assert.equal(resp.status, 403);
});

test('Administrativo (perfil "Administrador" cadastrado) consegue acessar GET /db/usuarios.json, igual ao master', async () => {
  const cookie = await cadastrarELogar('leandro.admin', 'Administrativo');
  const resp = await fetch(`${servidor.baseUrl}/db/usuarios.json`, { headers: { Cookie: cookie } });
  assert.equal(resp.status, 200);
});

test('Administrativo consegue gerenciar usuários via POST /salvar-usuarios, igual ao master', async () => {
  const cookie = await cadastrarELogar('marina.admin2', 'Administrativo');
  const resp = await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify([
      { nomeUsuario: 'marina.admin2', senha: 'senhateste1234', perfil: 'Administrativo' },
      { nomeUsuario: 'novo.cadastrado.por.admin', senha: 'senhanova1234', perfil: 'OperadorInjetora' },
    ]),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
  assert.ok(data.usuarios.some(u => u.nomeUsuario === 'novo.cadastrado.por.admin'));
});
