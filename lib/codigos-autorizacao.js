// ─── lib/codigos-autorizacao.js — Autorização de Dispositivo por Código/Arquivo ──
// Forma alternativa de autorizar um computador (complementa, não substitui,
// o que já existe em lib/dispositivo-autorizado.js / lib/rotas/
// dispositivos-autorizados.js: "Autorizar este dispositivo" e "Autorizar
// outro dispositivo pelo código [deviceId]", ambos exigindo sessão de admin
// NO PRÓPRIO dispositivo sendo autorizado).
//
// Fluxo (ver conversa que motivou isto):
//   1. Administrador Master gera um código aleatório pelo painel, dando um
//      NOME pra ele (ex: "PC Injetora 2") — fica pendente, sem expiração
//      (válido até ser usado OU revogado pelo nome).
//   2. O código é repassado (verbalmente, chat, etc.) pra quem está no
//      computador a autorizar — SEM precisar de sessão de admin ali.
//   3. Essa pessoa salva o código num arquivo .txt (em qualquer pasta do
//      próprio computador) e o ENVIA pelo botão de upload que aparece no
//      aviso de "dispositivo não autorizado" (ver public/js/operacao.js).
//   4. O servidor lê o CONTEÚDO do arquivo (nunca o caminho/pasta em si —
//      o navegador não tem acesso livre ao sistema de arquivos do cliente,
//      só ao que a própria pessoa seleciona), compara com os códigos
//      pendentes, e autoriza o deviceId (cookie HttpOnly, ver
//      lib/dispositivo-cookie.js) automaticamente se bater.
//
// Guardado em config.json (mesmo arquivo de dispositivosAutorizados), chave
// `codigosAutorizacao`: [{ nome, codigo, criadoEm, usado, usadoEm,
// deviceIdAutorizado, revogado, revogadoEm }]. Lido do disco a cada
// operação (sem cache em memória), mesmo raciocínio de
// lib/dispositivo-autorizado.js: uma revogação feita em Configurações
// precisa valer na hora, sem restart.
//
// SEGURANÇA: o código em si é a única credencial desta rota pública (ver
// lib/rotas/codigos-autorizacao.js, POST /autorizar-dispositivo-por-arquivo
// — sem sessão nenhuma, de propósito, pra funcionar em qualquer computador
// que ainda não tem acesso a nada). Por isso: (a) alta entropia (32
// símbolos de alfabeto sem caracteres ambíguos, 16 úteis = 80 bits), (b)
// uso único (marca `usado` na primeira vez que bate, nunca mais serve),
// (c) rate limit por IP na rota (ver server.js) contra tentativas de força
// bruta, (d) nome único por vez entre os pendentes, pra evitar confusão
// sobre qual código pertence a qual computador.

const crypto = require('crypto');

// Sem caracteres ambíguos (0/O, 1/I/L) — o código é lido/copiado por
// humanos (o de origem copia pro .txt, o de destino não reprecisa
// digitar nada, mas evita erro de leitura visual em qualquer conferência
// manual, ex: "confere no chat que mandou o código certo?").
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function gerarCodigoAleatorio() {
  const grupos = [];
  for (let g = 0; g < 4; g++) {
    let grupo = '';
    for (let i = 0; i < 4; i++) {
      grupo += ALFABETO[crypto.randomInt(ALFABETO.length)];
    }
    grupos.push(grupo);
  }
  return grupos.join('-'); // ex: "X7K9-P2M4-QW3L-8N5R"
}

function normalizar(texto) {
  return String(texto || '').trim().toUpperCase();
}

module.exports = function criarCodigosAutorizacao({
  fs, path, DB_DIR, lerDispositivosAutorizados, salvarDispositivosAutorizados,
}) {

  const CONFIG_PATH = path.join(DB_DIR, 'config.json');

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

  function listaCodigos(cfg) {
    return Array.isArray(cfg.codigosAutorizacao) ? cfg.codigosAutorizacao : [];
  }

  /** Lista completa (Configurações → Dispositivos Autorizados → Por Código). */
  function listar() {
    return listaCodigos(lerConfig());
  }

  /**
   * Gera um novo código pendente com o `nome` dado. Recusa se já existir
   * um código PENDENTE (não usado, não revogado) com o mesmo nome — evita
   * dois códigos "vivos" com o mesmo rótulo confundindo quem gerencia a
   * lista depois.
   */
  function gerarCodigo(nome) {
    const nomeLimpo = (nome || '').trim();
    if (!nomeLimpo) {
      throw new Error('Dê um nome para identificar este código (ex: "PC Injetora 2").');
    }
    const cfg = lerConfig();
    const lista = listaCodigos(cfg);
    if (lista.some(c => c && c.nome === nomeLimpo && !c.revogado && !c.usado)) {
      throw new Error('Já existe um código pendente com esse nome. Revogue-o antes, ou use um nome diferente.');
    }
    const entrada = {
      nome: nomeLimpo,
      codigo: gerarCodigoAleatorio(),
      criadoEm: new Date().toISOString(),
      usado: false,
      usadoEm: null,
      deviceIdAutorizado: null,
      revogado: false,
      revogadoEm: null,
    };
    lista.push(entrada);
    cfg.codigosAutorizacao = lista;
    salvarConfig(cfg);
    return entrada;
  }

  /**
   * Revoga um código pelo nome — sempre que possível (pendente OU já
   * usado). Se o código já tinha sido usado pra autorizar um dispositivo,
   * revogar TAMBÉM remove essa autorização na hora (trava imediata: o
   * nome vira o "controle remoto" único pra desfazer os dois efeitos de
   * uma vez, sem precisar ir separadamente em Dispositivos Autorizados
   * procurar qual deviceId era).
   */
  function revogar(nome) {
    const nomeLimpo = (nome || '').trim();
    const cfg = lerConfig();
    const lista = listaCodigos(cfg);
    const entrada = lista.find(c => c && c.nome === nomeLimpo && !c.revogado);
    if (!entrada) {
      throw new Error('Código não encontrado (ou já revogado).');
    }
    entrada.revogado = true;
    entrada.revogadoEm = new Date().toISOString();
    cfg.codigosAutorizacao = lista;
    salvarConfig(cfg);

    if (entrada.usado && entrada.deviceIdAutorizado) {
      const dispositivos = lerDispositivosAutorizados()
        .filter(d => d && d.deviceId !== entrada.deviceIdAutorizado);
      salvarDispositivosAutorizados(dispositivos);
    }
    return entrada;
  }

  /**
   * Confere o CONTEÚDO de um arquivo enviado contra os códigos pendentes.
   * Se bater com algum (não usado, não revogado): marca esse código como
   * usado (uso único) e autoriza `deviceId` de verdade, reaproveitando a
   * MESMA lista de lib/dispositivo-autorizado.js (dispositivosAutorizados)
   * — a partir daqui, esse deviceId passa a valer normalmente em
   * dispositivoAutorizado()/podeControlarOperacao(), sem nenhuma
   * diferença de tratamento por ter vindo deste fluxo.
   */
  function validarConteudoEAutorizar(conteudo, deviceId, ip) {
    if (!deviceId) {
      throw new Error('Não foi possível identificar este dispositivo (cookie ausente).');
    }
    const digitado = normalizar(conteudo);
    if (!digitado) {
      throw new Error('Arquivo vazio, ou sem um código válido dentro.');
    }
    const cfg = lerConfig();
    const lista = listaCodigos(cfg);
    const entrada = lista.find(c => c && !c.revogado && !c.usado && normalizar(c.codigo) === digitado);
    if (!entrada) {
      throw new Error('Código inválido, já usado, ou revogado. Peça um código novo ao Administrador.');
    }
    entrada.usado = true;
    entrada.usadoEm = new Date().toISOString();
    entrada.deviceIdAutorizado = deviceId;
    cfg.codigosAutorizacao = lista;
    salvarConfig(cfg);

    const dispositivos = lerDispositivosAutorizados();
    const existente = dispositivos.find(d => d && d.deviceId === deviceId);
    if (existente) {
      existente.ip = ip || existente.ip || null;
      existente.origemCodigo = entrada.nome;
    } else {
      dispositivos.push({
        deviceId,
        nome: `Autorizado via código "${entrada.nome}"`,
        ip: ip || null,
        autorizadoEm: new Date().toISOString(),
        origemCodigo: entrada.nome,
      });
    }
    salvarDispositivosAutorizados(dispositivos);
    return entrada;
  }

  return { listar, gerarCodigo, revogar, validarConteudoEAutorizar };
};
