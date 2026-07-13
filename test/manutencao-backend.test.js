// ─── test/manutencao-backend.test.js ────────────────────────────────────────
// Testa o backend real do Setor de Manutenção (Fase 2 — ver conversa que
// motivou a migração): antes tudo vivia em localStorage do navegador (Fase
// 1), sem sincronizar entre computadores nem entrar em backup. Agora é
// SQLite via HTTP (ver lib/rotas/manutencao.js, db.js — "SETOR DE
// MANUTENÇÃO — Fase 2").

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste();
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
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base),
  });
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, data: '2026-07-20', setor: 'Producao', maquina: 'Injetora 3', solicitante: 'Maria' }),
  });
  assert.equal(respCriar.status, 200);
  const dataCriar = await respCriar.json();
  assert.equal(dataCriar.agendamento.status, 'Pendente');

  const respListar = await fetch(`${servidor.baseUrl}/manutencao/programada`);
  assert.ok((await respListar.json()).agendamentos.some(a => a.id === id));

  const respExcluir = await fetch(`${servidor.baseUrl}/manutencao/excluir-programada`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  });
  assert.equal(respExcluir.status, 200);
});

test('agendamento guarda o objeto execucao (JSON) corretamente', async () => {
  const id = 'PRG-exec-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/programada`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, data: '2026-07-20', setor: 'Producao', maquina: 'Injetora 4', solicitante: 'Maria' }),
  });

  const execucao = {
    dataInicio: '2026-07-20', horaInicio: '08:00', dataFim: '2026-07-20', horaFim: '09:30',
    tempoGasto: 90, executado: 'Sim', tecnicoResponsavel: 'Joao', tipoExecucao: 'Interno',
  };
  await fetch(`${servidor.baseUrl}/manutencao/programada`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, data: '2026-07-20', setor: 'Producao', maquina: 'Injetora 4', solicitante: 'Maria', status: 'Concluido', execucao }),
  });

  const resp = await fetch(`${servidor.baseUrl}/manutencao/programada`);
  const data = await resp.json();
  const agendamento = data.agendamentos.find(a => a.id === id);
  assert.deepEqual(agendamento.execucao, execucao);
});

// ═══════════════════════════════════════════════════════════════════════
// Almoxarifado (estoque + movimentações)
// ═══════════════════════════════════════════════════════════════════════

test('criar peca com quantidade inicial NAO duplica o saldo (bug encontrado e corrigido durante a implementacao)', async () => {
  const id = 'PEC-' + Date.now();
  const respCriar = await fetch(`${servidor.baseUrl}/manutencao/estoque`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, codigo: 'C-' + Date.now(), nome: 'Rolamento', quantidade: 10 }),
  });
  const dataCriar = await respCriar.json();
  assert.equal(dataCriar.item.quantidade, 10, 'quantidade inicial nao deveria ser somada em duplicidade');

  const respMov = await fetch(`${servidor.baseUrl}/manutencao/movimentacoes`);
  const dataMov = await respMov.json();
  const movimentacoesDaPeca = dataMov.movimentacoes.filter(m => m.pecaId === id);
  assert.equal(movimentacoesDaPeca.length, 1, 'deveria ter registrado exatamente 1 movimentacao de "Estoque inicial"');
  assert.equal(movimentacoesDaPeca[0].motivo, 'Estoque inicial');
});

test('movimentacao de Entrada/Saida ajusta o saldo corretamente', async () => {
  const id = 'PEC-mov-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/estoque`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, codigo: 'C-mov-' + Date.now(), nome: 'Parafuso', quantidade: 10 }),
  });

  const respSaida = await fetch(`${servidor.baseUrl}/manutencao/movimentacoes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'MOV-' + Date.now(), pecaId: id, tipo: 'Saída', quantidade: 3, motivo: 'Uso em reparo' }),
  });
  const dataSaida = await respSaida.json();
  assert.equal(dataSaida.novoSaldo, 7);

  const respEntrada = await fetch(`${servidor.baseUrl}/manutencao/movimentacoes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'MOV-' + Date.now() + '-2', pecaId: id, tipo: 'Entrada', quantidade: 5, motivo: 'Compra' }),
  });
  const dataEntrada = await respEntrada.json();
  assert.equal(dataEntrada.novoSaldo, 12);
});

test('movimentacao de Saida maior que o saldo e recusada, sem alterar o estoque', async () => {
  const id = 'PEC-excesso-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/estoque`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, codigo: 'C-excesso-' + Date.now(), nome: 'Correia', quantidade: 5 }),
  });

  const resp = await fetch(`${servidor.baseUrl}/manutencao/movimentacoes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'MOV-excesso-' + Date.now(), pecaId: id, tipo: 'Saída', quantidade: 1000, motivo: 'teste' }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /insuficiente/i);

  const respEstoque = await fetch(`${servidor.baseUrl}/manutencao/estoque`);
  const item = (await respEstoque.json()).itens.find(p => p.id === id);
  assert.equal(item.quantidade, 5, 'saldo nao deveria ter sido alterado pela movimentacao recusada');
});

test('editar dados cadastrais de uma peca NAO altera a quantidade', async () => {
  const id = 'PEC-editar-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/estoque`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, codigo: 'C-editar-' + Date.now(), nome: 'Mangueira', quantidade: 8 }),
  });

  const resp = await fetch(`${servidor.baseUrl}/manutencao/editar-estoque`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, codigo: 'C-editada', nome: 'Mangueira Hidraulica', estoqueMinimo: 3 }),
  });
  const data = await resp.json();
  assert.equal(data.item.codigo, 'C-editada');
  assert.equal(data.item.nome, 'Mangueira Hidraulica');
  assert.equal(data.item.quantidade, 8, 'quantidade nao deveria mudar ao editar so dados cadastrais');
});

test('excluir uma peca remove tambem suas movimentacoes (cascata)', async () => {
  const id = 'PEC-cascata-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/estoque`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, codigo: 'C-cascata-' + Date.now(), nome: 'Filtro', quantidade: 4 }),
  });

  const respAntes = await fetch(`${servidor.baseUrl}/manutencao/movimentacoes`);
  const totalAntes = (await respAntes.json()).movimentacoes.filter(m => m.pecaId === id).length;
  assert.equal(totalAntes, 1, 'deveria ter 1 movimentacao de estoque inicial antes de excluir');

  await fetch(`${servidor.baseUrl}/manutencao/excluir-estoque`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  });

  const respDepois = await fetch(`${servidor.baseUrl}/manutencao/movimentacoes`);
  const totalDepois = (await respDepois.json()).movimentacoes.filter(m => m.pecaId === id).length;
  assert.equal(totalDepois, 0, 'movimentacoes da peca excluida deveriam ter sido removidas em cascata');
});

test('movimentacao recusa peca inexistente', async () => {
  const resp = await fetch(`${servidor.baseUrl}/manutencao/movimentacoes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'MOV-inexistente', pecaId: 'PEC-nao-existe', tipo: 'Entrada', quantidade: 1 }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /não encontrada/i);
});

// ═══════════════════════════════════════════════════════════════════════
// Backup e Restauração incluindo as 4 tabelas de Manutenção
// ═══════════════════════════════════════════════════════════════════════

test('Backup de Dados inclui as 4 tabelas de manutencao com os dados corretos', async () => {
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: idChamado, data: '2026-07-12', setor: 'Produção', maquina: 'M1', observador: 'X', prioridade: 'Alta', anomalia: 'Y', tipoManutencao: 'Mecânica' }),
    });
    const idPeca = 'PEC-bkp-' + Date.now();
    await fetch(`${servidorLocal.baseUrl}/manutencao/estoque`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: idPeca, codigo: 'C-BKP', nome: 'Peça Backup', quantidade: 12 }),
    });

    const respBackup = await fetch(`${servidorLocal.baseUrl}/backup-dados`, { headers: { Cookie: cookieAdmin } });
    assert.equal(respBackup.status, 200);
    const buffer = Buffer.from(await respBackup.arrayBuffer());
    const zip = await JSZip.loadAsync(buffer);
    const arquivos = Object.keys(zip.files);

    assert.ok(arquivos.includes('manutencao_corretiva.json'));
    assert.ok(arquivos.includes('manutencao_programada.json'));
    assert.ok(arquivos.includes('manutencao_estoque.json'));
    assert.ok(arquivos.includes('manutencao_movimentacoes.json'));

    const chamadosNoZip = JSON.parse(await zip.file('manutencao_corretiva.json').async('string'));
    assert.ok(chamadosNoZip.some(c => c.id === idChamado));

    const estoqueNoZip = JSON.parse(await zip.file('manutencao_estoque.json').async('string'));
    const pecaNoZip = estoqueNoZip.find(p => p.id === idPeca);
    assert.ok(pecaNoZip);
    assert.equal(pecaNoZip.quantidade, 12, 'quantidade exportada deveria bater com o saldo real, sem duplicar');
  } finally {
    await servidorLocal.parar();
  }
});

test('restaurar Backup de Dados restaura manutencao corretamente, sem duplicar quantidade de estoque', async () => {
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

    const idPeca = 'PEC-restaurar-' + Date.now();
    await fetch(`${servidorLocal.baseUrl}/manutencao/estoque`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: idPeca, codigo: 'C-REST', nome: 'Peça Restaurar', quantidade: 25 }),
    });

    const respBackup = await fetch(`${servidorLocal.baseUrl}/backup-dados`, { headers: { Cookie: cookieAdmin } });
    const buffer = Buffer.from(await respBackup.arrayBuffer());
    const zip = await JSZip.loadAsync(buffer);

    const arquivosParaRestaurar = {};
    for (const nome of Object.keys(zip.files)) {
      arquivosParaRestaurar[nome] = await zip.file(nome).async('string');
    }

    const respRestaurar = await fetch(`${servidorLocal.baseUrl}/restaurar-backup-dados`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: SENHA, arquivos: arquivosParaRestaurar }),
    });
    assert.equal(respRestaurar.status, 200);

    const respEstoque = await fetch(`${servidorLocal.baseUrl}/manutencao/estoque`);
    const dataEstoque = await respEstoque.json();
    const pecaRestaurada = dataEstoque.itens.find(p => p.id === idPeca);
    assert.ok(pecaRestaurada);
    assert.equal(pecaRestaurada.quantidade, 25, 'quantidade restaurada não deveria duplicar');
  } finally {
    await servidorLocal.parar();
  }
});
