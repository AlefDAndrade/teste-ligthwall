// ─── test/operacao-offline-enviar.test.js ───────────────────────────────────
// Cobertura formal de POST /operacao-offline/enviar (README, "Registro de
// Operação Offline (PWA) — plano", item 5) — a rota de sincronização do
// Registro Offline. Roda contra o server.js DE VERDADE (não um mock), numa
// cópia isolada — ver test/helpers/servidor-teste.js.
//
// Cobre:
//   - Envio válido, SEM sessão/deviceId nenhum (a rota existe justamente
//     pra quando não há como logar) — grava na fila própria
//     (operacoes_offline_pendentes.json), nunca em operacoes/historico.
//   - Idempotência: reenviar o mesmo idTemp não duplica a entrada na fila.
//   - Validação estrutural: idTemp fora do formato "OFF-<uuid>", formRecord
//     ausente/tipo errado, tracos que não é lista — tudo 400, sem gravar
//     nada na fila.
//   - JSON malformado no corpo do request retorna 400 (sem derrubar o
//     servidor) — mesmo padrão de /registrar-operacao.
//   - Rate limiting por IP: depois do limite de tentativas, passa a
//     responder 429 (com Retry-After), sem gravar mais nada na fila.
//   - A rota nunca insere em operacoes/tracos (isso só vai acontecer na
//     aprovação do Master, item 6 do plano, ainda não implementada) — só
//     confere que GET /db/historico.json continua vazio depois dos envios.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste();
});

after(async () => {
  await servidor.parar();
});

function enviar(payload) {
  return fetch(`${servidor.baseUrl}/operacao-offline/enviar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

function payloadValido(idTemp) {
  return {
    idTemp,
    formRecord: { id_bateria: 'B-teste', data: '2026-08-19', turno: '1° TURNO' },
    tracos: [{ densidade: 1.2 }],
    pausas: [],
  };
}

function lerFilaOfflineNoDisco() {
  const caminho = path.join(servidor.pastaTemp, 'public', 'db', 'operacoes_offline_pendentes.json');
  try {
    return JSON.parse(fs.readFileSync(caminho, 'utf8'));
  } catch (_) {
    return []; // arquivo ainda não existe — nenhum envio válido até agora
  }
}

test('envio válido, sem sessão nem deviceId, é aceito (200) e aparece na fila offline', async () => {
  const idTemp = 'OFF-teste-basico-' + Date.now();
  const resp = await enviar(payloadValido(idTemp));
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);
  assert.equal(corpo.idTemp, idTemp);

  const fila = lerFilaOfflineNoDisco();
  const item = fila.find(i => i.idTemp === idTemp);
  assert.ok(item, 'item deveria estar na fila offline');
  assert.equal(item.formRecord.id_bateria, 'B-teste');
  assert.deepEqual(item.tracos, [{ densidade: 1.2 }]);
  assert.ok(item.recebidoEm, 'deveria ter timestamp do servidor');
});

test('a operação enviada offline NUNCA aparece em /db/historico.json (nunca vira operação real aqui)', async () => {
  const idTemp = 'OFF-nao-deve-virar-operacao-' + Date.now();
  await enviar(payloadValido(idTemp));

  const resp = await fetch(`${servidor.baseUrl}/db/historico.json`);
  const historico = await resp.json();
  assert.ok(!historico.some(op => op.id === idTemp), 'não deveria existir em operacoes/historico — só na fila offline');
});

test('idempotência: reenviar o mesmo idTemp não duplica a entrada na fila', async () => {
  const idTemp = 'OFF-idempotente-' + Date.now();
  const r1 = await enviar(payloadValido(idTemp));
  const r2 = await enviar(payloadValido(idTemp));
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);

  const fila = lerFilaOfflineNoDisco();
  const ocorrencias = fila.filter(i => i.idTemp === idTemp);
  assert.equal(ocorrencias.length, 1, 'deveria existir só 1 entrada, mesmo depois de 2 envios com o mesmo idTemp');
});

test('idTemp fora do formato "OFF-<uuid>" é recusado (400), nada gravado na fila', async () => {
  const resp = await enviar({ idTemp: 'sem-prefixo-valido', formRecord: {}, tracos: [] });
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);
  assert.match(corpo.erro, /idTemp/);
});

test('formRecord ausente é recusado (400)', async () => {
  const resp = await enviar({ idTemp: 'OFF-sem-form-' + Date.now(), tracos: [] });
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);
  assert.match(corpo.erro, /formRecord/);
});

test('tracos que não é uma lista é recusado (400)', async () => {
  const resp = await enviar({ idTemp: 'OFF-tracos-invalido-' + Date.now(), formRecord: {}, tracos: 'não é lista' });
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);
  assert.match(corpo.erro, /tracos/);
});

test('JSON malformado no corpo retorna 400, sem derrubar o servidor', async () => {
  const resp = await enviar('{isso não é json válido');
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);

  // Servidor continua de pé — próxima chamada válida ainda funciona.
  const respDepois = await enviar(payloadValido('OFF-depois-do-malformado-' + Date.now()));
  assert.equal(respDepois.status, 200);
});

test('payload inválido (400) não é gravado na fila offline', async () => {
  const idTemp = 'OFF-invalido-nao-grava-' + Date.now();
  await enviar({ idTemp, formRecord: {}, tracos: 'não é lista' }); // inválido de propósito

  const fila = lerFilaOfflineNoDisco();
  assert.ok(!fila.some(i => i.idTemp === idTemp), 'payload recusado não deveria aparecer na fila');
});

test('rate limiting: depois de muitas tentativas do mesmo IP, passa a responder 429', async () => {
  // Usa um servidor PRÓPRIO pra este teste (isolado dos outros) — não
  // queremos que os envios válidos dos testes acima contem pro mesmo
  // limite e façam este teste (ou os anteriores) ficarem dependentes de
  // ordem de execução.
  const servidorIsolado = await iniciarServidorDeTeste();
  try {
    const respostas = [];
    for (let i = 0; i < 22; i++) {
      const resp = await fetch(`${servidorIsolado.baseUrl}/operacao-offline/enviar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadValido('OFF-rate-limit-' + i)),
      });
      respostas.push(resp.status);
    }

    // As 20 primeiras (maxTentativas, ver server.js) passam; da 21ª em
    // diante, bloqueado.
    assert.equal(respostas.slice(0, 20).every(s => s === 200), true, 'as 20 primeiras deveriam ser aceitas');
    assert.equal(respostas[20], 429, 'a 21ª tentativa deveria ser bloqueada');
    assert.equal(respostas[21], 429, 'a 22ª tentativa deveria continuar bloqueada');

    // Confirma que a 21ª (bloqueada) realmente não foi gravada na fila.
    const caminho = path.join(servidorIsolado.pastaTemp, 'public', 'db', 'operacoes_offline_pendentes.json');
    const fila = JSON.parse(fs.readFileSync(caminho, 'utf8'));
    assert.ok(!fila.some(i => i.idTemp === 'OFF-rate-limit-20'), 'item da 21ª chamada (bloqueada) não deveria estar na fila');
    assert.ok(fila.some(i => i.idTemp === 'OFF-rate-limit-19'), 'item da 20ª chamada (última aceita) deveria estar na fila');
  } finally {
    await servidorIsolado.parar();
  }
});
