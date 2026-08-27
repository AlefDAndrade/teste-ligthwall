// ─── lib/google-drive.js — OAuth2 + upload no Google Drive ────────────────
// Passo 3 do plano "Backup Automático no Google Drive" (ver README).
// Conversa toda com o Google fica isolada aqui — nenhuma outra parte do
// sistema sabe como funciona OAuth2 nem a API do Drive, só chama estas
// funções. lib/rotas/backup-drive.js (as rotas HTTP) e o gancho em
// lib/rotas/backup.js (upload automático) são os únicos consumidores.
//
// DE PROPÓSITO sem nenhuma dependência nova (nem `googleapis`, nem
// `google-auth-library`): tudo aqui é feito com `fetch` nativo do Node
// (disponível desde o Node 18, já o mínimo exigido pelo projeto — ver
// "engines" em package.json). A troca de código por token é só um POST
// form-urlencoded, e o upload é um POST multipart — não precisa de
// biblioteca nenhuma pra isso, e evita puxar dezenas de pacotes
// transitivos só pra uma conversa HTTP simples (chegamos a testar
// `google-auth-library` e ela sozinha trouxe ~270 pacotes — descartado por
// destoar do resto do projeto, que hoje tem só 6 dependências, todas
// essenciais).
//
// Escopo pedido na autorização: `drive.file` — o app só enxerga/edita os
// arquivos que ELE MESMO cria, nunca o Drive inteiro da pessoa (mesmo
// raciocínio de permissão mínima já usado em lib/permissoes-area.js).
//
// Credenciais (Client ID/Secret) vêm de variáveis de ambiente
// (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) — nunca hardcoded nem
// commitadas (ver README, passo 1 do plano). GOOGLE_REDIRECT_URI é a URL
// completa que o Google chama de volta depois da pessoa autorizar (ver
// GET /backup-drive/callback, lib/rotas/backup-drive.js).

const logger = require('./logger');

const ESCOPO_DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const URL_AUTORIZACAO = 'https://accounts.google.com/o/oauth2/v2/auth';
const URL_TOKEN = 'https://oauth2.googleapis.com/token';
const URL_REVOGAR = 'https://oauth2.googleapis.com/revoke';
const URL_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
const URL_ARQUIVOS = 'https://www.googleapis.com/drive/v3/files';

// Erro dedicado pra "faltam credenciais no ambiente" — diferente de um
// erro de rede/resposta do Google. As rotas usam `instanceof
// ErroCredenciaisAusentes` pra devolver uma mensagem clara ("Passo 1 do
// plano ainda não foi feito") em vez de um erro genérico de OAuth.
class ErroCredenciaisAusentes extends Error {}

module.exports = function criarGoogleDrive() {

  function credenciais() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      throw new ErroCredenciaisAusentes(
        'GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI não configurados no ambiente — ' +
        'falta o Passo 1 do plano de Backup no Google Drive (ver README).'
      );
    }
    return { clientId, clientSecret, redirectUri };
  }

  function credenciaisConfiguradas() {
    try { credenciais(); return true; } catch (_) { return false; }
  }

  // Monta a URL de consentimento do Google. `state` é um valor aleatório
  // opaco (gerado pela rota /backup-drive/autorizar) que volta junto no
  // callback — usado só pra confirmar que o callback corresponde a um
  // /autorizar disparado por nós mesmos (proteção contra CSRF no fluxo
  // OAuth), nunca guardado como identificador de sessão.
  function gerarUrlAutorizacao(state) {
    const { clientId, redirectUri } = credenciais();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: ESCOPO_DRIVE_FILE,
      access_type: 'offline',   // pede refresh_token, não só access_token
      prompt: 'consent',        // força reemitir refresh_token mesmo se já autorizou antes
      state,
    });
    return `${URL_AUTORIZACAO}?${params.toString()}`;
  }

  // Troca o `code` recebido no callback por { accessToken, refreshToken }.
  // `refreshToken` só vem preenchido na 1ª autorização (ou quando
  // prompt=consent força reemitir, como acima) — é o único dado que
  // precisa ser guardado; accessToken expira em ~1h e é sempre reobtido
  // via obterAccessToken() abaixo.
  async function trocarCodigoPorTokens(code) {
    const { clientId, clientSecret, redirectUri } = credenciais();
    const resp = await fetch(URL_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const dados = await resp.json();
    if (!resp.ok) {
      throw new Error(`Google recusou o código: ${dados.error_description || dados.error || resp.status}`);
    }
    if (!dados.refresh_token) {
      throw new Error('Google não devolveu refresh_token (raro — normalmente acontece se a conta já tinha autorizado antes sem "prompt=consent"). Tente desconectar no Google e autorizar de novo.');
    }
    return { accessToken: dados.access_token, refreshToken: dados.refresh_token };
  }

  // Troca um refreshToken guardado por um accessToken novo — chamado
  // sempre que for preciso falar com a API do Drive (accessToken nunca é
  // guardado entre chamadas, só o refreshToken).
  async function obterAccessToken(refreshToken) {
    const { clientId, clientSecret } = credenciais();
    const resp = await fetch(URL_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
      }),
    });
    const dados = await resp.json();
    if (!resp.ok) {
      throw new Error(`Falha ao renovar acesso ao Google Drive: ${dados.error_description || dados.error || resp.status}`);
    }
    return dados.access_token;
  }

  // Descobre o e-mail da conta que autorizou (só pra exibir em
  // Configurações — "conectado como fulano@gmail.com"). Usa o próprio
  // accessToken recém-emitido no userinfo endpoint padrão do Google.
  async function obterEmailDaConta(accessToken) {
    const resp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    const dados = await resp.json();
    return dados.email || null;
  }

  // Acha (ou cria, na 1ª vez) a pasta fixa "Lightwall — Backups
  // Automáticos" no Drive da conta conectada, devolvendo seu id — pra não
  // ter que procurar de novo a cada upload, esse id fica guardado junto da
  // credencial (ver private/backup-drive.json, lib/backup-drive-json.js).
  async function obterOuCriarPasta(accessToken, pastaIdConhecido) {
    if (pastaIdConhecido) {
      // Confirma que a pasta ainda existe (pode ter sido apagada/movida
      // manualmente pela pessoa) — se sumiu, cai pro fluxo de criar de novo.
      const check = await fetch(`${URL_ARQUIVOS}/${pastaIdConhecido}?fields=id,trashed`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (check.ok) {
        const info = await check.json();
        if (!info.trashed) return pastaIdConhecido;
      }
    }

    const NOME_PASTA = 'Lightwall — Backups Automáticos';
    const busca = new URLSearchParams({
      q: `name = '${NOME_PASTA}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name)',
    });
    const respBusca = await fetch(`${URL_ARQUIVOS}?${busca.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const dadosBusca = await respBusca.json();
    if (respBusca.ok && dadosBusca.files && dadosBusca.files.length) {
      return dadosBusca.files[0].id;
    }

    const respCriar = await fetch(URL_ARQUIVOS, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: NOME_PASTA, mimeType: 'application/vnd.google-apps.folder' }),
    });
    const dadosCriar = await respCriar.json();
    if (!respCriar.ok) {
      throw new Error(`Falha ao criar pasta no Drive: ${dadosCriar.error && dadosCriar.error.message || respCriar.status}`);
    }
    return dadosCriar.id;
  }

  // Envia um arquivo (buffer) pra dentro da pasta, via upload multipart
  // simples (adequado pra arquivos pequenos — os zips de backup deste
  // projeto giram na casa de KB/poucos MB, bem longe do limite de 5MB do
  // upload "simple/multipart" antes de precisar do upload resumível).
  async function enviarArquivo({ refreshToken, pastaId: pastaIdConhecido, nomeArquivo, buffer }) {
    const accessToken = await obterAccessToken(refreshToken);
    const pastaId = await obterOuCriarPasta(accessToken, pastaIdConhecido);

    const boundary = `lightwall-${Date.now()}`;
    const metadata = JSON.stringify({ name: nomeArquivo, parents: [pastaId] });
    const corpo = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: application/zip\r\n\r\n`
      ),
      buffer,
      Buffer.from(`\r\n--${boundary}--`),
    ]);

    const resp = await fetch(URL_UPLOAD, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: corpo,
    });
    const dados = await resp.json();
    if (!resp.ok) {
      throw new Error(`Falha ao enviar arquivo pro Drive: ${dados.error && dados.error.message || resp.status}`);
    }
    return { arquivoId: dados.id, pastaId };
  }

  // Apaga um arquivo já enviado (usado pra manter a mesma retenção de 3
  // backups também no Drive — ver lib/rotas/backup.js).
  async function apagarArquivo({ refreshToken, arquivoId }) {
    const accessToken = await obterAccessToken(refreshToken);
    const resp = await fetch(`${URL_ARQUIVOS}/${arquivoId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // 404 = já não existe (ex: apagado manualmente antes) — não é erro
    // pro nosso propósito, o resultado desejado (arquivo fora do Drive)
    // já está satisfeito.
    if (!resp.ok && resp.status !== 404) {
      const dados = await resp.json().catch(() => ({}));
      throw new Error(`Falha ao apagar arquivo antigo no Drive: ${dados.error && dados.error.message || resp.status}`);
    }
  }

  // Revoga o refreshToken junto ao Google (usado por "Desconectar" —
  // depois disso, mesmo que o refreshToken vazasse de algum jeito, ele já
  // não serviria mais pra nada).
  async function revogarToken(refreshToken) {
    try {
      await fetch(`${URL_REVOGAR}?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' });
    } catch (e) {
      // Best-effort: se o Google estiver fora do ar no momento de
      // desconectar, ainda assim apagamos a credencial local (ver
      // lib/rotas/backup-drive.js) — só loga, não impede a desconexão
      // local de acontecer.
      logger.warn('backup-drive', 'falha ao revogar token junto ao Google (credencial local será removida de todo jeito)', { erro: e.message });
    }
  }

  return {
    ErroCredenciaisAusentes,
    credenciaisConfiguradas,
    gerarUrlAutorizacao,
    trocarCodigoPorTokens,
    obterAccessToken,
    obterEmailDaConta,
    enviarArquivo,
    apagarArquivo,
    revogarToken,
  };
};
