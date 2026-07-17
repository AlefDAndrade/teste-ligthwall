// ─── test/manutencao-backend.test.js ────────────────────────────────────────
// Testa o backend real do Setor de Manutenção (Fase 2 — ver conversa que
// motivou a migração): antes tudo vivia em localStorage do navegador (Fase
// 1), sem sincronizar entre computadores nem entrar em backup. Agora é
// SQLite via HTTP (ver lib/rotas/manutencao.js, db.js — "SETOR DE
// MANUTENÇÃO — Fase 2").

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

// Rotas de ESCRITA de Manutenção agora exigem a área 'manutencao'/
// 'manutencao-chamado' de edição (modelo novo, ver lib/perfis.js) — a
// sessão de Administrador Master sempre passa em qualquer área, então os
// testes deste arquivo (que só querem exercitar o CRUD em si, não a
// matriz de permissões — essa já está coberta em
// test/manutencao-permissoes.test.js) logam como master uma vez e anexam
// o cookie em toda chamada de escrita.
const SENHA_ADMIN = 'senha-admin-manutencao-backend-999';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let cookieAdmin;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
  const respAdmin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  cookieAdmin = (respAdmin.headers.get('set-cookie') || '').split(';')[0];
});

after(async () => {
  await servidor.parar();
});

// ═══════════════════════════════════════════════════════════════════════
// Manutenção Corretiva
// ═══════════════════════════════════════════════════════════════════════

test('criar, listar e excluir um chamado de manutencao corretiva', async () => {
  const id = 'MAN-' + Date.now();
  const respCriar = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({
      id, data: '2026-07-12', setor: 'Producao', maquina: 'Injetora 1',
      observador: 'Carlos', prioridade: 'Alta', anomalia: 'Vazamento de oleo',
      tipoManutencao: 'Mecanica', autorNome: 'carlos.teste',
    }),
  });
  assert.equal(respCriar.status, 200);
  const dataCriar = await respCriar.json();
  assert.equal(dataCriar.ok, true);
  assert.equal(dataCriar.chamado.situacao, 'Aguardando');
  assert.equal(dataCriar.chamado.autorNome, 'carlos.teste');

  const respListar = await fetch(`${servidor.baseUrl}/manutencao/corretiva`);
  const dataListar = await respListar.json();
  assert.ok(dataListar.chamados.some(c => c.id === id));

  const respExcluir = await fetch(`${servidor.baseUrl}/manutencao/excluir-corretiva`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ id }),
  });
  assert.equal(respExcluir.status, 200);

  const respListarDepois = await fetch(`${servidor.baseUrl}/manutencao/corretiva`);
  const dataListarDepois = await respListarDepois.json();
  assert.ok(!dataListarDepois.chamados.some(c => c.id === id));
});

test('POST /manutencao/corretiva com upsert (mesmo id) atualiza em vez de duplicar', async () => {
  const id = 'MAN-upsert-' + Date.now();
  const base = {
    id, data: '2026-07-12', setor: 'Producao', maquina: 'Injetora 2',
    observador: 'Ana', prioridade: 'Baixa', anomalia: 'Ruido estranho',
    tipoManutencao: 'Eletrica',
  };
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin }, body: JSON.stringify(base),
  });
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ ...base, situacao: 'Concluido' }),
  });

  const resp = await fetch(`${servidor.baseUrl}/manutencao/corretiva`);
  const data = await resp.json();
  const ocorrencias = data.chamados.filter(c => c.id === id);
  assert.equal(ocorrencias.length, 1, 'upsert pelo mesmo id nao deveria duplicar a linha');
  assert.equal(ocorrencias[0].situacao, 'Concluido');
});

test('POST /manutencao/corretiva recusa sem campos obrigatorios', async () => {
  const resp = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ id: 'MAN-invalido' }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════
// Manutenção Programada (agendamentos)
// ═══════════════════════════════════════════════════════════════════════

test('criar, listar e excluir um agendamento de manutencao programada', async () => {
  const id = 'PRG-' + Date.now();
  const respCriar = await fetch(`${servidor.baseUrl}/manutencao/programada`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ id, data: '2026-07-20', setor: 'Producao', maquina: 'Injetora 3', solicitante: 'Maria' }),
  });
  assert.equal(respCriar.status, 200);
  const dataCriar = await respCriar.json();
  assert.equal(dataCriar.agendamento.status, 'Pendente');

  const respListar = await fetch(`${servidor.baseUrl}/manutencao/programada`);
  assert.ok((await respListar.json()).agendamentos.some(a => a.id === id));

  const respExcluir = await fetch(`${servidor.baseUrl}/manutencao/excluir-programada`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin }, body: JSON.stringify({ id }),
  });
  assert.equal(respExcluir.status, 200);
});

test('agendamento guarda o objeto execucao (JSON) corretamente', async () => {
  const id = 'PRG-exec-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/programada`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ id, data: '2026-07-20', setor: 'Producao', maquina: 'Injetora 4', solicitante: 'Maria' }),
  });

  const execucao = {
    dataInicio: '2026-07-20', horaInicio: '08:00', dataFim: '2026-07-20', horaFim: '09:30',
    tempoGasto: 90, executado: 'Sim', tecnicoResponsavel: 'Joao', tipoExecucao: 'Interno',
  };
  await fetch(`${servidor.baseUrl}/manutencao/programada`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ id, data: '2026-07-20', setor: 'Producao', maquina: 'Injetora 4', solicitante: 'Maria', status: 'Concluido', execucao }),
  });

  const resp = await fetch(`${servidor.baseUrl}/manutencao/programada`);
  const data = await resp.json();
  const agendamento = data.agendamentos.find(a => a.id === id);
  assert.deepEqual(agendamento.execucao, execucao);
});

// ═══════════════════════════════════════════════════════════════════════
// Backup e Restauração das tabelas de Manutenção
// ═══════════════════════════════════════════════════════════════════════

test('Backup de Dados inclui as tabelas de manutencao com os dados corretos', async () => {
  const JSZip = require('jszip');
  const crypto = require('crypto');
  const SENHA = 'senha-backup-manutencao-teste-777';
  const HASH = crypto.createHash('sha256').update(SENHA, 'utf8').digest('hex');

  const servidorLocal = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH, recoveryKeyHash: null },
  });
  try {
    const respAdmin = await fetch(`${servidorLocal.baseUrl}/verificar-senha`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: SENHA }),
    });
    const cookieAdmin = (respAdmin.headers.get('set-cookie') || '').split(';')[0];

    const idChamado = 'MAN-bkp-' + Date.now();
    await fetch(`${servidorLocal.baseUrl}/manutencao/corretiva`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
      body: JSON.stringify({ id: idChamado, data: '2026-07-12', setor: 'Produção', maquina: 'M1', observador: 'X', prioridade: 'Alta', anomalia: 'Y', tipoManutencao: 'Mecânica' }),
    });

    const respBackup = await fetch(`${servidorLocal.baseUrl}/backup-dados`, { headers: { Cookie: cookieAdmin } });
    assert.equal(respBackup.status, 200);
    const buffer = Buffer.from(await respBackup.arrayBuffer());
    const zip = await JSZip.loadAsync(buffer);
    const arquivos = Object.keys(zip.files);

    assert.ok(arquivos.includes('manutencao_corretiva.json'));
    assert.ok(arquivos.includes('manutencao_programada.json'));

    const chamadosNoZip = JSON.parse(await zip.file('manutencao_corretiva.json').async('string'));
    assert.ok(chamadosNoZip.some(c => c.id === idChamado));
  } finally {
    await servidorLocal.parar();
  }
});

test('restaurar Backup de Dados restaura manutencao corretamente', async () => {
  const JSZip = require('jszip');
  const crypto = require('crypto');
  const SENHA = 'senha-restaurar-manutencao-teste-888';
  const HASH = crypto.createHash('sha256').update(SENHA, 'utf8').digest('hex');

  const servidorLocal = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH, recoveryKeyHash: null },
  });
  try {
    const respAdmin = await fetch(`${servidorLocal.baseUrl}/verificar-senha`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: SENHA }),
    });
    const cookieAdmin = (respAdmin.headers.get('set-cookie') || '').split(';')[0];

    const idChamado = 'MAN-restaurar-' + Date.now();
    await fetch(`${servidorLocal.baseUrl}/manutencao/corretiva`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
      body: JSON.stringify({ id: idChamado, data: '2026-07-12', setor: 'Produção', maquina: 'M2', observador: 'X', prioridade: 'Alta', anomalia: 'Y', tipoManutencao: 'Elétrica' }),
    });

    const respBackup = await fetch(`${servidorLocal.baseUrl}/backup-dados`, { headers: { Cookie: cookieAdmin } });
    const buffer = Buffer.from(await respBackup.arrayBuffer());
    const zip = await JSZip.loadAsync(buffer);

    const arquivosParaRestaurar = {};
    for (const nome of Object.keys(zip.files)) {
      arquivosParaRestaurar[nome] = await zip.file(nome).async('string');
    }

    const respRestaurar = await fetch(`${servidorLocal.baseUrl}/restaurar-backup-dados`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
      body: JSON.stringify({ senha: SENHA, arquivos: arquivosParaRestaurar }),
    });
    assert.equal(respRestaurar.status, 200);

    const respCorretiva = await fetch(`${servidorLocal.baseUrl}/manutencao/corretiva`);
    const dataCorretiva = await respCorretiva.json();
    assert.ok(dataCorretiva.chamados.some(c => c.id === idChamado), 'chamado restaurado deveria estar presente');
  } finally {
    await servidorLocal.parar();
  }
});
