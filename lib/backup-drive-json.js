// ─── lib/backup-drive-json.js — private/backup-drive.json ─────────────────
// Passo 4 do plano "Backup Automático no Google Drive" (ver README).
// Guarda a credencial da conta Google conectada (uma só por instalação,
// não por usuário do sistema — mesmo modelo de security.json: uma
// credencial de administração). Mora em private/ (irmã de public/, nunca
// servida como estático), mesmo raciocínio de security.json/
// usuarios.json (ver lib/security-json.js) — um arquivo assim dentro de
// public/db/ seria servido cru pra qualquer um que soubesse a URL.
//
// Formato do arquivo:
//   {
//     "conectado": true,
//     "email": "fabrica@gmail.com",
//     "refreshToken": "...",
//     "pastaId": "...",
//     "ativo": true,
//     "conectadoEm": "2026-08-26T12:00:00.000Z"
//   }
//
// `refreshToken` é o único dado sensível aqui (diferente de
// security.json/usuarios.json, que só guardam HASH — este precisa ser
// reversível, é assim que a API do Google funciona). Por isso este
// arquivo entra na lista de exclusões do Backup Geral (ver
// VALIDADORES_BACKUP_GERAL, lib/rotas/backup.js) — um backup não deve
// virar um vetor de vazamento de credencial de uma conta Google externa.
//
// `ativo` é o toggle liga/desliga (POST /backup-drive/toggle) — permite
// pausar o envio automático sem precisar desconectar a conta de novo.

const ESTADO_INICIAL = Object.freeze({
  conectado: false,
  email: null,
  refreshToken: null,
  pastaId: null,
  ativo: false,
  conectadoEm: null,
});

module.exports = function criarBackupDriveJson({ fs, path, PRIVATE_DIR }) {

  const BACKUP_DRIVE_PATH = path.join(PRIVATE_DIR, 'backup-drive.json');

  function ler() {
    try {
      const bruto = fs.readFileSync(BACKUP_DRIVE_PATH, 'utf8');
      return { ...ESTADO_INICIAL, ...JSON.parse(bruto) };
    } catch (_) {
      return { ...ESTADO_INICIAL };
    }
  }

  function salvar(estado) {
    fs.mkdirSync(PRIVATE_DIR, { recursive: true });
    fs.writeFileSync(BACKUP_DRIVE_PATH, JSON.stringify(estado, null, 2), 'utf8');
    return estado;
  }

  // Grava a conexão feita agora (chamado pelo callback OAuth) —
  // sobrescreve qualquer conexão anterior (autorizar de novo troca a
  // conta conectada, não soma duas contas).
  function salvarConexao({ email, refreshToken }) {
    return salvar({
      conectado: true,
      email,
      refreshToken,
      pastaId: null, // resolvida (achada/criada) no 1º upload — ver lib/google-drive.js
      ativo: true,
      conectadoEm: new Date().toISOString(),
    });
  }

  function definirPastaId(pastaId) {
    const estado = ler();
    if (!estado.conectado) return estado; // nada a fazer se já foi desconectado nesse meio-tempo
    return salvar({ ...estado, pastaId });
  }

  function definirAtivo(ativo) {
    const estado = ler();
    return salvar({ ...estado, ativo: !!ativo });
  }

  function desconectar() {
    return salvar({ ...ESTADO_INICIAL });
  }

  return {
    BACKUP_DRIVE_PATH,
    ler,
    salvarConexao,
    definirPastaId,
    definirAtivo,
    desconectar,
  };
};
