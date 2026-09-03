// ─── lib/certificado-dispositivo.js — Certificado de Autorização de Dispositivo (mTLS) ──
// Camada ADICIONAL de reconhecimento de dispositivo, em paralelo ao que já
// existia (cookie HttpOnly + fallback por IP, ver lib/dispositivo-cookie.js
// e lib/dispositivo-autorizado.js) — não substitui nada, só resolve o ponto
// que os outros dois não resolviam: sobreviver a limpar TODOS os dados do
// navegador. O README já previa isso ("Ideia futura... mTLS", seção
// "Identidade do dispositivo (deviceId)") — este módulo é essa ideia
// implementada.
//
// COMO FUNCIONA: um certificado de cliente TLS é uma identidade que vive na
// camada de REDE, não em cookie/localStorage — instalado uma vez no
// navegador/SO da máquina (arquivo .p12, duplo-clique no Windows), fica lá
// até alguém remover manualmente. Não é apagado limpando dados do
// navegador e não dá pra forjar via DevTools (diferente do deviceId
// antigo). O Caddy (já na frente do Node pra HTTPS, ver
// deploy/instalar-https.sh) passa a pedir esse certificado no handshake
// TLS (modo OPCIONAL — deploy/ativar-mtls-caddy.sh, "mode request", nunca
// bloqueia quem não tem certificado) e repassa o número de série pro Node
// via header `X-Client-Cert-Serial` — é esse serial que
// lib/dispositivo-autorizado.js compara contra a lista abaixo.
//
// CA PRÓPRIA: pra assinar certificados de dispositivo sem depender de
// nenhuma autoridade externa (Let's Encrypt não emite certificado de
// CLIENTE), o próprio sistema gera e guarda uma CA (par de chaves) na
// primeira vez que um certificado é emitido — fica em
// private/ca-dispositivos/ (PRIVATE_DIR, fora de public/, nunca servida
// pela web — mesmo motivo de segurança de security.json/usuarios.json, ver
// lib/security-json.js). A CHAVE PRIVADA da CA nunca sai da VM; só o
// certificado PÚBLICO dela (ca-cert.pem) precisa ser copiado pro Caddy
// confiar nele (ver deploy/ativar-mtls-caddy.sh) — perder ou vazar só o
// ca-cert.pem não compromete nada, é informação pública por natureza (todo
// certificado já expõe o certificado do emissor no handshake).
//
// LISTA DE AUTORIZADOS: guardada em config.json (mesmo arquivo de
// dispositivosAutorizados, ver lib/dispositivo-autorizado.js), campo
// `certificadosAutorizados: [{ serial, nome, emitidoEm }]`. Só o SERIAL (já
// público por natureza — vai em todo handshake TLS) — nunca a senha do
// .p12 nem a chave privada do dispositivo, que não ficam guardadas em
// lugar nenhum depois da emissão (só existem na hora do download, ver
// emitirCertificado()). Revogar é só remover desta lista — sem
// infraestrutura de CRL/OCSP, mesma UX de "Remover" que
// dispositivosAutorizados já tinha.
//
// LISTA VAZIA = nenhum certificado emitido ainda, não afeta em nada quem já
// usa cookie/IP — esta é só mais uma via de reconhecimento, opcional desde
// o primeiro dia.

const forge = require('node-forge');

module.exports = function criarCertificadoDispositivo({ fs, path, DB_DIR, PRIVATE_DIR }) {

  const CA_DIR = path.join(PRIVATE_DIR, 'ca-dispositivos');
  const CA_KEY_PATH = path.join(CA_DIR, 'ca-key.pem');
  const CA_CERT_PATH = path.join(CA_DIR, 'ca-cert.pem');
  const CONFIG_PATH = path.join(DB_DIR, 'config.json'); // reaproveita o mesmo arquivo de dispositivosAutorizados

  function lerConfig() {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (_) {
      return {};
    }
  }

  function salvarConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  }

  function listaCertificados(cfg) {
    return Array.isArray(cfg.certificadosAutorizados) ? cfg.certificadosAutorizados : [];
  }

  // Serial em hex — forge exige que o primeiro byte não tenha o bit mais
  // alto ligado (senão o ASN.1 leria como número negativo); prefixa "00"
  // nesse caso em vez de gerar de novo, mais simples e igualmente
  // aleatório no restante.
  function gerarSerialHex() {
    let hex = forge.util.bytesToHex(forge.random.getBytesSync(16));
    if (parseInt(hex[0], 16) >= 8) hex = '00' + hex;
    return hex;
  }

  // Carrega a CA do disco se já existir; senão gera uma nova (só acontece
  // uma vez, na primeira emissão de certificado desta instalação). 20 anos
  // de validade — não é uma sessão, é uma raiz de confiança de chão de
  // fábrica (mesmo raciocínio de duração do cookie de dispositivo, ver
  // lib/dispositivo-cookie.js); certificados de dispositivo (15 anos, ver
  // emitirCertificado) sempre vencem antes dela.
  function garantirCA() {
    if (fs.existsSync(CA_KEY_PATH) && fs.existsSync(CA_CERT_PATH)) {
      return {
        caKey: forge.pki.privateKeyFromPem(fs.readFileSync(CA_KEY_PATH, 'utf8')),
        caCert: forge.pki.certificateFromPem(fs.readFileSync(CA_CERT_PATH, 'utf8')),
      };
    }

    fs.mkdirSync(CA_DIR, { recursive: true, mode: 0o700 });

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = gerarSerialHex();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 20);

    const attrsCA = [
      { name: 'commonName', value: 'Lightwall SC - CA de Dispositivos' },
      { name: 'organizationName', value: 'Lightwall SC' },
    ];
    cert.setSubject(attrsCA);
    cert.setIssuer(attrsCA); // auto-assinada: emissor = ela mesma
    cert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
      { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    // Chave privada da CA: 0o600 (só o dono/processo do Node lê) — é o
    // segredo mais sensível deste módulo, quem tiver acesso a ela consegue
    // emitir certificados aceitos por qualquer instalação que confie nesta
    // CA. Certificado público: leitura liberada, precisa ser copiado pro
    // Caddy (ver deploy/ativar-mtls-caddy.sh).
    fs.writeFileSync(CA_KEY_PATH, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
    fs.writeFileSync(CA_CERT_PATH, forge.pki.certificateToPem(cert), { mode: 0o644 });

    return { caKey: keys.privateKey, caCert: cert };
  }

  // Gera um novo certificado de dispositivo assinado pela CA própria,
  // empacota num .p12 protegido por senha aleatória, e registra o serial
  // na lista de autorizados. Devolve o .p12 pronto (Buffer) e a senha —
  // NENHUM dos dois fica guardado em disco depois desta chamada retornar;
  // se a senha for perdida antes de instalar, a única saída é gerar um
  // certificado novo e revogar este (ver removerCertificado).
  function emitirCertificado(nomeBruto) {
    const nome = (typeof nomeBruto === 'string' && nomeBruto.trim()) ? nomeBruto.trim() : 'Dispositivo Lightwall';
    const { caKey, caCert } = garantirCA();

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    const serial = gerarSerialHex();
    cert.serialNumber = serial;
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 15);

    cert.setSubject([
      { name: 'commonName', value: nome },
      { name: 'organizationName', value: 'Lightwall SC' },
    ]);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', clientAuth: true },
      { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(caKey, forge.md.sha256.create());

    // Senha do .p12 — só protege o arquivo em trânsito (ex: se for mandado
    // por e-mail/rede interna); 8 bytes aleatórios em hex é suficiente pra
    // isso, sem ficar longa demais pra digitar na hora de importar no
    // Windows.
    const senha = forge.util.bytesToHex(forge.random.getBytesSync(8));
    const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert, caCert], senha, { friendlyName: nome });
    const p12Buffer = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');

    const emitidoEm = new Date().toISOString();
    const cfg = lerConfig();
    const lista = listaCertificados(cfg);
    lista.push({ serial, nome, emitidoEm });
    cfg.certificadosAutorizados = lista;
    salvarConfig(cfg);

    return { p12Buffer, senha, serial, nome, emitidoEm };
  }

  // Único ponto usado por dispositivoAutorizado() (lib/dispositivo-autorizado.js)
  // pra decidir se um serial apresentado no request autoriza o dispositivo.
  function certificadoAutorizado(serial) {
    if (!serial) return false;
    return listaCertificados(lerConfig()).some(c => c && c.serial === serial);
  }

  // Revoga (remove da lista de aceitos) — não invalida o certificado em si
  // (sem CRL/OCSP, ver comentário no topo do arquivo), só faz
  // certificadoAutorizado() parar de reconhecer este serial a partir de
  // agora.
  function removerCertificado(serial) {
    const cfg = lerConfig();
    const lista = listaCertificados(cfg).filter(c => c && c.serial !== serial);
    cfg.certificadosAutorizados = lista;
    salvarConfig(cfg);
    return lista;
  }

  function listarCertificados() {
    return listaCertificados(lerConfig());
  }

  return {
    emitirCertificado,
    certificadoAutorizado,
    removerCertificado,
    listarCertificados,
  };
};
