#!/usr/bin/env node
// ─── scripts/diagnosticar-push.js ──────────────────────────────────────────
// Diagnóstico do sistema de notificações push (ver README.md, seção
// "Notificações Push"). Roda DIRETO na pasta do servidor (onde tem
// db.js, private/, public/db/), sem precisar subir o servidor HTTP:
//
//   node scripts/diagnosticar-push.js
//   node scripts/diagnosticar-push.js nome.do.usuario   (foco em 1 pessoa)
//
// Mostra: 1) se as chaves VAPID existem, 2) todas as inscrições push
// salvas (e de quem), 3) o nível de permissão "Notificar Abertura de
// Chamado" de cada usuário cadastrado (a mesma cascata fixo/override/
// customizado usada de verdade na hora de notificar).

const path = require('path');
const fs = require('fs');

const RAIZ = path.join(__dirname, '..');
const filtroUsuario = process.argv[2] || null;

function linha() { console.log('─'.repeat(70)); }

console.log('DIAGNÓSTICO — Notificações Push (Lightwall SC)');
linha();

// 1) Chaves VAPID
const VAPID_PATH = path.join(RAIZ, 'private', 'vapid-keys.json');
if (fs.existsSync(VAPID_PATH)) {
  const chaves = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
  console.log('✅ Chaves VAPID existem em private/vapid-keys.json');
  console.log('   Chave pública atual:', chaves.publicKey);
  console.log('   ⚠️  Se essa pasta foi apagada/recriada DEPOIS que alguém já tinha');
  console.log('      ativado notificações no celular, a inscrição antiga ficou');
  console.log('      inválida — a pessoa precisa clicar no sino de novo.');
} else {
  console.log('❌ private/vapid-keys.json NÃO existe ainda — será criado na próxima');
  console.log('   subida do servidor (node server.js). Se o servidor já rodou pelo');
  console.log('   menos uma vez, isso é estranho — confira se "private/" está');
  console.log('   mesmo sendo persistida entre reinícios/deploys.');
}
linha();

// 2) Usuários cadastrados + perfil
const USUARIOS_PATH = path.join(RAIZ, 'private', 'usuarios.json');
let usuarios = [];
try {
  usuarios = JSON.parse(fs.readFileSync(USUARIOS_PATH, 'utf8'));
} catch (e) {
  console.log('❌ Não consegui ler private/usuarios.json:', e.message);
  process.exit(1);
}

// 3) Resolve a permissão de notificação de cada usuário — mesma cascata
// de lib/notificacoes-push.js (fixo -> override -> customizado).
const perfis = require(path.join(RAIZ, 'lib', 'perfis.js'));
const itensPermissao = require(path.join(RAIZ, 'lib', 'itens-permissao.js'));
const perfisCustomizados = require(path.join(RAIZ, 'lib', 'perfis-customizados.js'))({
  fs, path, PRIVATE_DIR: path.join(RAIZ, 'private'), perfis, itensPermissao,
});
const perfisFixosOverrides = require(path.join(RAIZ, 'lib', 'perfis-fixos-overrides.js'))({
  fs, path, PRIVATE_DIR: path.join(RAIZ, 'private'), itensPermissao,
});
const ITEM_ID = itensPermissao.ITEM_NOTIFICACAO_ABERTURA_CHAMADO;

function nivelNotificacaoDoPerfil(perfilId) {
  if (perfis.PERFIS_CADASTRAVEIS.includes(perfilId)) {
    const override = perfisFixosOverrides.obter(perfilId);
    if (override) return { nivel: perfisCustomizados.nivelDoItem({ permissoes: override }, ITEM_ID), origem: 'override do perfil fixo' };
    const padrao = perfis.permissoesPadraoDoPerfilFixo(perfilId);
    return { nivel: padrao ? padrao[ITEM_ID] : 'ocultar', origem: 'padrão do perfil fixo' };
  }
  const customizado = perfisCustomizados.obter(perfilId);
  if (!customizado) return { nivel: 'ocultar', origem: 'perfil customizado não encontrado (!)' };
  return { nivel: perfisCustomizados.nivelDoItem(customizado, ITEM_ID), origem: 'perfil customizado' };
}

// 4) Inscrições push salvas — lê direto do banco (db.js já cria/abre o
// arquivo em data/lightwall.sqlite ou onde estiver configurado).
const db = require(path.join(RAIZ, 'db.js'));
let todasInscricoes = [];
try {
  todasInscricoes = db.listarPushSubscriptionsDosUsuarios(usuarios.map(u => u.nomeUsuario));
} catch (e) {
  console.log('❌ Não consegui ler push_subscriptions do banco:', e.message);
}

console.log(`Usuários cadastrados: ${usuarios.length} | Inscrições push salvas: ${todasInscricoes.length}`);
linha();

const lista = filtroUsuario
  ? usuarios.filter(u => u.nomeUsuario.toLowerCase().includes(filtroUsuario.toLowerCase()))
  : usuarios;

if (filtroUsuario && lista.length === 0) {
  console.log(`⚠️  Nenhum usuário cadastrado com nome contendo "${filtroUsuario}".`);
}

for (const u of lista) {
  const { nivel, origem } = nivelNotificacaoDoPerfil(u.perfil);
  const recebe = nivel === 'total';
  const inscricoes = todasInscricoes.filter(s => s.usuario_nome === u.nomeUsuario);

  console.log(`👤 ${u.nomeUsuario}  (perfil: ${u.perfil})`);
  console.log(`   Permissão de notificação: ${nivel}  [${recebe ? 'RECEBE' : 'NÃO RECEBE'}]  (fonte: ${origem})`);
  if (!recebe) {
    console.log('   ⚠️  Esse perfil não tem "Notificar Abertura de Chamado" = Acesso Total.');
    console.log('       Ajuste em Configurações → Usuários → engrenagem do perfil.');
  }
  if (inscricoes.length === 0) {
    console.log('   ⚠️  NENHUM dispositivo inscrito pra este usuário — o sino nunca');
    console.log('       foi ativado com sucesso (ou a inscrição não chegou a salvar).');
  } else {
    for (const s of inscricoes) {
      console.log(`   📱 inscrito em: ${s.criado_em}  |  endpoint: ${s.endpoint.slice(0, 60)}...`);
      console.log(`      user-agent: ${s.user_agent || '(não informado)'}`);
    }
  }
  console.log('');
}

linha();
console.log('Dica: se tudo acima parece OK (permissão = total, inscrição existe),');
console.log('o próximo passo é olhar o console do servidor (stdout/stderr) no exato');
console.log('momento em que o chamado foi aberto — qualquer falha de ENVIO real');
console.log('aparece como "[notificacoes-push] Falha ao enviar: ...".');
