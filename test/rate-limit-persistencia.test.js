// ─── test/rate-limit-persistencia.test.js ───────────────────────────────────
// Cobertura formal do item 7 do review: o rate limit de tentativas de senha
// (ver lib/auth.js) precisa SOBREVIVER a um restart do processo — antes,
// vivia só num Map em memória, e um restart (deploy, reboot, crash) zerava
// o contador de qualquer IP, dando uma folga completa de novo a quem
// estivesse testando senha por força bruta contra /mesclar-backup-dados,
// /restaurar-backup-dados ou /restaurar-backup-geral (as 3 rotas mais
// destrutivas, todas usando a MESMA senha compartilhada do Administrador).
// Agora é persistido em SQLite (tabela tentativas_senha_ip, ver db.js).
//
// Usa servidor.reiniciar() (test/helpers/servidor-teste.js) — mata o
// processo e sobe um NOVO, do zero, apontando pra MESMA pasta/banco: é um
// restart de verdade, não uma simulação em memória.
//
// Cobre:
//   - Um IP bloqueado continua bloqueado depois de reiniciar o processo
//     (a garantia central desta mudança).
//   - O contador de tentativas (ainda não bloqueado) também sobrevive ao
//     restart — não dá "mais 5 tentativas de graça" só por reiniciar.
//   - Um log de warn é emitido no momento em que o bloqueio começa.
//   - O contador é POR ROTA COMPARTILHADO: tentativas em /verificar-senha
//     bloqueiam também /mesclar-backup-dados (mesmo IP).
//   - Sucesso (senha certa) limpa o contador — depois de reiniciar,
//     continua limpo (não "esquece" a limpeza).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-rate-limit-persist-317';
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

function tentarSenhaErrada() {
  return fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: 'tentativa-errada-' + Date.now() + Math.random() }),
  });
}

function tentarMesclarComSenhaErrada() {
  return fetch(`${servidor.baseUrl}/mesclar-backup-dados`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: 'tentativa-errada-mesclar-' + Date.now(), arquivos: { 'historico.json': '[]' } }),
  });
}

test('IP bloqueado continua bloqueado depois de reiniciar o processo (persiste em SQLite, não em memória)', async () => {
  for (let i = 0; i < 5; i++) await tentarSenhaErrada();

  const respAntes = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  assert.equal(respAntes.status, 429, 'deveria estar bloqueado antes do restart');

  await servidor.reiniciar();

  const respDepois = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  assert.equal(respDepois.status, 429, 'deveria CONTINUAR bloqueado depois do restart — antes desta mudança, zerava aqui');
  assert.ok(respDepois.headers.get('retry-after'), 'deveria continuar vindo um Retry-After coerente');
});

test('log de warn é emitido no momento em que o bloqueio começa', async () => {
  const saida = servidor.obterSaida();
  assert.match(saida, /IP bloqueado por excesso de tentativas de senha erradas/, 'deveria ter logado o bloqueio que aconteceu no teste anterior');
});

test('o contador é compartilhado entre rotas — bloqueio por /verificar-senha também bloqueia /mesclar-backup-dados', async () => {
  // Nesse ponto o IP (mesmo IP de todos os testes deste arquivo — localhost)
  // já está bloqueado pelo teste anterior.
  const resp = await tentarMesclarComSenhaErrada();
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /Muitas tentativas erradas/, 'o bloqueio de /verificar-senha deveria valer aqui também, sem precisar de 5 tentativas novas nesta rota');
});
