// ─── test/operacao-offline-placas-8mm.test.js ───────────────────────────────
// Validar uma operação offline recalcula placas_cimenticia_8mm NO SERVIDOR a
// partir de bercos_dimensoes (nunca confia no número mandado pelo aparelho),
// e item antigo da fila (sem bercos_dimensoes) fica com 0 placas de 8 mm.
// Mesmo esqueleto de test/operacao-offline-validar.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-operacao-offline-8mm-377';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');
let servidor;
let cookieAdmin;

before(async () => {
  servidor = await iniciarServidorDeTeste({ seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null } });
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  cookieAdmin = (resp.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookieAdmin);
});
after(async () => { await servidor.parar(); });

const comAdmin = () => ({ Cookie: cookieAdmin });

function payload(idTemp, overrides) {
  return {
    idTemp,
    formRecord: {
      turno: '1° TURNO', dimensao: '9 cm', capacidade: 4, id_bateria: 'B-8mm-teste', tipo_montagem: '2/P',
      inicio: '2026-08-19T08:00:00.000Z', fim: '2026-08-19T09:00:00.000Z', desemplaque: 'NAO', tempo_min: 60,
      houve_atraso: 'NAO', motivo_atraso: '', qtd_tracos: 1, total_paineis: 8, m2_total: 14.64,
      placas_cimenticia: 16, paineis_por_tipo: { '2p': 8 }, m2_por_tipo: { '2p': 14.64 },
      ...overrides,
    },
    tracos: [{
      id: 'traco_off_' + idTemp, num: 1, berco_ini: '1', berco_fim: '4',
      cimento_real: { original: 100, ajustes: [] }, agua_real: { original: 50, ajustes: [] },
      eps_real: { original: 2, ajustes: [] }, superplast_real: { original: 1, ajustes: [] },
      incorporador_real: { original: 0.5, ajustes: [] }, tempo_batida: { original: 5, ajustes: [] },
      densidade_insumo: { original: 300, ajustes: [] }, flow_insumo: { original: 200, ajustes: [] },
      obs: '', silo: 'Silo 1', expansao: '1ª expansão', densidadeEPS: 16,
    }],
    pausas: [],
  };
}

async function enviarEValidar(p) {
  const env = await fetch(`${servidor.baseUrl}/operacao-offline/enviar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
  });
  assert.equal(env.status, 200);
  const td = await (await fetch(`${servidor.baseUrl}/operacao-offline/tracos-do-dia?idTemp=${encodeURIComponent(p.idTemp)}`, { headers: comAdmin() })).json();
  assert.equal(td.ok, true, td.erro);
  const usados = new Set(td.existentes.map(t => t.num_traco));
  let prox = td.existentes.reduce((m, t) => Math.max(m, t.num_traco || 0), 0) + 1;
  const renumeracao = td.existentes.map(t => ({ id_traco: t.id_traco, num_traco: t.num_traco }));
  td.pendentes.forEach(t => { while (usados.has(prox)) prox++; renumeracao.push({ id_traco: t.id_traco, num_traco: prox }); usados.add(prox); prox++; });
  const val = await fetch(`${servidor.baseUrl}/operacao-offline/validar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...comAdmin() }, body: JSON.stringify({ idTemp: p.idTemp, renumeracao }),
  });
  const corpo = await val.json();
  assert.equal(corpo.ok, true, corpo.erro);
  const historico = await (await fetch(`${servidor.baseUrl}/db/historico.json`)).json();
  return historico.find(o => o.id === corpo.idOperacao);
}

test('validar offline: servidor recalcula as placas de 8 mm (2 berços de 9,5 cm × 2 painéis × 2 placas = 8), ignorando o valor do aparelho', async () => {
  const op = await enviarEValidar(payload('OFF-8mm-mista-' + Date.now(), {
    bercos_dimensoes: ['9,5 cm', '9,5 cm', null, null],
    placas_cimenticia_8mm: 999, // valor bogus do aparelho — não pode valer
  }));
  assert.ok(op);
  assert.equal(op.placas_cimenticia, 16);
  assert.equal(op.placas_cimenticia_8mm, 8);
  assert.deepEqual(op.bercos_dimensoes, ['9,5 cm', '9,5 cm', null, null]);
});

test('validar offline: bateria toda de 9,5 cm (dimensão padrão) = todas as placas em 8 mm', async () => {
  const op = await enviarEValidar(payload('OFF-8mm-toda-' + Date.now(), { dimensao: '9,5 cm' }));
  assert.equal(op.placas_cimenticia_8mm, 16);
});

test('validar offline: item antigo (sem bercos_dimensoes, 9 cm) fica com 0 placas de 8 mm', async () => {
  const op = await enviarEValidar(payload('OFF-8mm-antigo-' + Date.now(), {}));
  assert.equal(op.placas_cimenticia_8mm, 0);
});
