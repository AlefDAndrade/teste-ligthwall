// ─── lib/rotas/one-page-report.js — One Page Report ─────────────────────────
// Fase 3 do plano do One Page Report (ver README, "Nova página: One Page
// Report (planejamento)"): rotas do Módulo de Comentários. Mesmo padrão
// factory + tentar(req, res, urlPath, queryParams) do resto de lib/rotas/.
// Rotas cobertas nesta fase: GET /db/one-page-comentarios.json, POST
// /salvar-comentarios-one-page-report.
//
// `db.lerComentariosDoMes`/`db.salvarComentariosDoMes` vêm de lib/db/
// one-page-comentarios.js (já concluído) — note que este `db` é o wrapper
// de comentários (JSON simples), NÃO o `db` de SQLite (db.js) usado por
// seguranca.js/expedicao.js; foi nomeado igual só pra manter a mesma
// convenção de parâmetro do resto de lib/rotas/.
//
// PERMISSÃO DE ESCRITA — mesma decisão das Fases 1-2 (ver comentário
// equivalente em lib/rotas/seguranca.js/expedicao.js): 'one-page-report'
// AINDA NÃO é uma área cadastrada em AREAS_DE_EDICAO (lib/perfis.js) — até
// a Fase 5 (frontend/menu) decidir quais perfis editam a tela, a rota de
// ESCRITA exige `sessaoOuAdmin` (mesmo padrão de /salvar-metas,
// lib/rotas/autenticacao.js — outro "JSON simples" editável). A LEITURA
// (GET) continua livre, mesmo modelo do resto do sistema.
//
// ── FASE 4: GET /db/one-page-report.json (endpoint de agregação) ──────────
// Vive NESTE MESMO ARQUIVO (é a localização que o próprio README já
// reservava pra ela), logo abaixo das rotas da Fase 3. Junta num payload
// só, por mês:
//   - Segurança/Expedição (Fases 1-2, `dbSql`/SQLite) + Comentários
//     (Fase 3, `comentarios`, JSON simples — rotas acima);
//   - Produção (tabela "operacoes") e Refugo (tabela "avaliacao_paineis" +
//     "traco_usos") — dado que já existia antes do One Page Report, sem
//     nenhuma tabela/coluna nova (ver README, "Levantamento: o que já
//     existe vs. o que falta").
// Precisa de uma 2ª dependência (`dbSql`) além de `comentarios` — daí o
// nome diferente: `comentarios` continua sendo o wrapper JSON (mesmo de
// antes), `dbSql` é o `db` de SQLite (db.js), igual ao usado por
// seguranca.js/expedicao.js. Não exige sessão pra LER, mesmo modelo do
// resto do sistema (só a escrita de comentários, acima, exige).
//
// Conversão comentários (string) -> array (linhas): o Módulo de
// Comentários (Fase 3) guarda "comentarios"/"proximosPassos" como texto
// livre (1 string por bloco); a tela (Fase 5, public/js/one-page-
// report.js) espera um ARRAY de linhas (usa `.map` pra montar uma lista
// com marcadores). Este endpoint é quem faz essa ponte — quebra o texto
// por linha (\n), descarta linhas em branco.
//
// "Linha de produção" (L1/L2): nenhuma tabela guarda esse conceito hoje —
// a planta roda com uma única linha. Enquanto isso não mudar, todo o m²/
// refugo apurado entra em "L1"; "L2" fica com valor 0 (mesmo critério já
// usado no MOCK_DADOS que este endpoint substitui).

module.exports = function criarRotasOnePageReport({ comentarios, sessao, dbSql, todayBrasiliaServer }) {

  const crypto = require('crypto');
  const BLOCOS_VALIDOS = require('../db/one-page-comentarios.js').BLOCOS_VALIDOS;

  // Limites das fotos de "Assuntos Gerais" — defesa em profundidade: o
  // navegador já comprime antes de enviar (ver _oprComprimirFoto,
  // public/js/one-page-report.js, mesma técnica de _comprimirFotoDefeito
  // em setor-qualidade.js: redimensiona pra no máx. 1000px + JPEG .75,
  // o que normalmente fica bem abaixo de 1MB por foto), mas nunca confia
  // só nisso — um POST direto (fora da tela) poderia mandar qualquer
  // coisa. MAX_BODY_BYTES_PADRAO (server.js, 50MB) já barra um payload
  // absurdo antes de chegar aqui; isto aqui é o limite POR FOTO/POR MÊS.
  const MAX_FOTOS_ASSUNTOS_GERAIS = 12;
  const MAX_BYTES_POR_FOTO = 4 * 1024 * 1024; // 4MB de data-URI (string), não do arquivo original

  function semSessao(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
  }

  function mesValido(mes) {
    return typeof mes === 'string' && /^\d{4}-\d{2}$/.test(mes);
  }

  /**
   * Valida e normaliza o array de fotos de "Assuntos Gerais" vindo do
   * POST — cada item precisa ser `{ imagem, tema? , id? }`, `imagem` uma
   * data-URI de imagem (`data:image/...`) dentro do limite
   * (MAX_BYTES_POR_FOTO). Gera `id` no servidor quando a foto é nova (o
   * front não manda id pra foto recém-adicionada) — mesmo padrão de
   * `'prefix_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex')`
   * já usado por seguranca.js/expedicao.js/tracos-descartados.js. Lança
   * com mensagem descritiva em qualquer formato inválido — nunca salva
   * "o que der" silenciosamente.
   */
  function validarFotosAssuntosGerais(fotos) {
    if (fotos === undefined) return undefined;
    if (!Array.isArray(fotos)) throw new Error('"assuntosGerais.fotos" precisa ser uma lista.');
    if (fotos.length > MAX_FOTOS_ASSUNTOS_GERAIS) {
      throw new Error(`No máximo ${MAX_FOTOS_ASSUNTOS_GERAIS} fotos em Assuntos Gerais.`);
    }
    return fotos.map((f, i) => {
      if (!f || typeof f !== 'object') throw new Error(`Foto #${i + 1} inválida.`);
      if (typeof f.imagem !== 'string' || !f.imagem.startsWith('data:image/')) {
        throw new Error(`Foto #${i + 1} não é uma imagem válida.`);
      }
      if (f.imagem.length > MAX_BYTES_POR_FOTO) {
        throw new Error(`Foto #${i + 1} é grande demais (máx. ${Math.round(MAX_BYTES_POR_FOTO / 1024 / 1024)}MB).`);
      }
      const id = (typeof f.id === 'string' && f.id.trim())
        ? f.id.trim()
        : 'foto_assuntos_gerais_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
      return { id, imagem: f.imagem, tema: typeof f.tema === 'string' ? f.tema.slice(0, 200) : '' };
    });
  }

  // ── Helpers da Fase 4 (agregação) ─────────────────────────────────────

  const NOMES_MES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  function labelMes(mesISO) {
    const [ano, mes] = mesISO.split('-').map(Number);
    return `${NOMES_MES[mes - 1]}/${ano}`;
  }

  /** Último dia do mês (mesma técnica de agregacaoSemanalExpedicao, lib/db/expedicao.js). */
  function diasDoMes(mesISO) {
    const [ano, mes] = mesISO.split('-').map(Number);
    return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  }

  /** "Comentários"/"Próximos passos" (Fase 3) são 1 string por bloco — a tela (Fase 5) espera um array de linhas. */
  function linhasDoTexto(texto) {
    return String(texto || '').split('\n').map(l => l.trim()).filter(Boolean);
  }

  function comentariosDoBloco(comentariosDoMes, nomeBloco) {
    const bloco = comentariosDoMes && comentariosDoMes[nomeBloco];
    return {
      comentarios: linhasDoTexto(bloco && bloco.comentarios),
      proximosPassos: linhasDoTexto(bloco && bloco.proximosPassos),
    };
  }

  /**
   * Bloco Segurança (Fase 1): ocorrências do mês dia a dia + "dias sem
   * acidentes" (este último sempre GLOBAL, não só do mês — é "há quantos
   * dias não acontece uma ocorrência", contado a partir de hoje).
   */
  function montarBlocoSeguranca(mesISO, hojeISO) {
    const totalDias = diasDoMes(mesISO);
    const labels = Array.from({ length: totalDias }, (_, i) => String(i + 1));
    const values = labels.map(() => 0);
    const ocorrenciasDoMes = dbSql.listarOcorrenciasSeguranca()
      .filter(o => o.data.slice(0, 7) === mesISO);
    ocorrenciasDoMes.forEach(o => {
      const dia = Number(o.data.split('-')[2]);
      if (dia >= 1 && dia <= totalDias) values[dia - 1]++;
    });
    const { dias } = dbSql.diasSemAcidentes(hojeISO);
    return {
      // "Disponível" aqui é GLOBAL (existe alguma ocorrência já registrada
      // alguma vez, não necessariamente neste mês) — um mês sem NENHUMA
      // ocorrência é justamente o resultado bom que a tela quer mostrar
      // (acumuladoMes: 0), não um "dado indisponível".
      disponivel: dias !== null,
      acumuladoMes: ocorrenciasDoMes.length,
      diasSemAcidentes: dias,
      ocorrenciasPorDia: { labels, values },
    };
  }

  /**
   * Bloco Produção: baterias/dia + m² total do mês, a partir da tabela
   * "operacoes" (1 linha = 1 bateria). Sem dado real de "linha de
   * produção" ainda — ver comentário no topo do arquivo.
   */
  function montarBlocoProducao(mesISO) {
    const totalDias = diasDoMes(mesISO);
    const rows = dbSql.prepare(
      'SELECT data, COUNT(*) AS baterias, SUM(m2_total) AS m2 FROM operacoes WHERE SUBSTR(data, 1, 7) = ? GROUP BY data'
    ).all(mesISO);
    if (rows.length === 0) return { disponivel: false };

    const labels = Array.from({ length: totalDias }, (_, i) => String(i + 1));
    const values = labels.map(() => 0);
    let totalM2 = 0;
    rows.forEach(r => {
      const dia = Number(r.data.split('-')[2]);
      if (dia >= 1 && dia <= totalDias) values[dia - 1] = r.baterias;
      totalM2 += r.m2 || 0;
    });
    totalM2 = Math.round(totalM2 * 100) / 100;

    return {
      disponivel: true,
      bateriasPorDia: { labels, values },
      distribuicaoLinha: [
        { label: 'L1', value: totalM2, color: 'var(--opr-blue)' },
        { label: 'L2', value: 0, color: 'var(--opr-border)' },
      ],
      totalM2,
    };
  }

  /**
   * Bloco Refugo: % de refugo dia a dia + refugo por "linha de produção"
   * (ver ressalva acima), a partir de "avaliacao_paineis" (Setor de
   * Qualidade) — cada painel tem `resultado` ('aprovado'/'reprovado', ver
   * lib/db/operacoes-qualidade.js, _normalizarPaineisParaSql). Datado por
   * `registrado_em` (não existe outra data no domínio de avaliação de
   * painéis). "tracosPorLinha" = refugos ÷ nº de traços distintos usados
   * nas operações avaliadas do mês (traco_usos) — só L1 hoje.
   */
  function montarBlocoRefugo(mesISO) {
    const totalDias = diasDoMes(mesISO);
    const rows = dbSql.prepare(
      'SELECT id_operacao, registrado_em, paineis FROM avaliacao_paineis WHERE SUBSTR(registrado_em, 1, 7) = ?'
    ).all(mesISO);
    if (rows.length === 0) return { disponivel: false };

    const labels = Array.from({ length: totalDias }, (_, i) => String(i + 1));
    const totalPorDia = labels.map(() => 0);
    const reprovadosPorDia = labels.map(() => 0);
    let totalPaineis = 0, totalReprovados = 0;
    const idsOperacao = new Set();

    rows.forEach(r => {
      const dia = Number(r.registrado_em.slice(8, 10));
      if (r.id_operacao) idsOperacao.add(r.id_operacao);
      let paineis;
      try { paineis = JSON.parse(r.paineis); } catch (_) { paineis = []; }
      paineis.forEach(p => {
        totalPaineis++;
        if (dia >= 1 && dia <= totalDias) totalPorDia[dia - 1]++;
        if (p.resultado === 'reprovado') {
          totalReprovados++;
          if (dia >= 1 && dia <= totalDias) reprovadosPorDia[dia - 1]++;
        }
      });
    });

    const values = labels.map((_, i) => totalPorDia[i]
      ? Math.round((reprovadosPorDia[i] / totalPorDia[i]) * 1000) / 10
      : 0);
    const totalPct = totalPaineis ? Math.round((totalReprovados / totalPaineis) * 1000) / 10 : 0;

    let valorL1 = 0;
    if (idsOperacao.size > 0) {
      const ids = [...idsOperacao];
      const placeholders = ids.map(() => '?').join(',');
      const distintos = dbSql.prepare(
        `SELECT COUNT(DISTINCT id_traco) AS n FROM traco_usos WHERE id_operacao IN (${placeholders})`
      ).get(...ids);
      const nTracos = (distintos && distintos.n) || 0;
      valorL1 = nTracos ? Math.round((totalReprovados / nTracos) * 100) / 100 : 0;
    }

    return {
      disponivel: true,
      refugoDiarioPct: { labels, values },
      totalPct,
      tracosPorLinha: [{ linha: 'L1', valor: valorL1 }],
    };
  }

  /**
   * Bloco Expedição (Fase 2): m²/dia + cargas/semana (contagem, não m² —
   * ver lib/db/expedicao.js, agregacaoSemanalExpedicao, que já dá o m²
   * semanal via `semanas`; aqui é só a CONTAGEM de cargas por faixa,
   * mesmas faixas S1-S4 de `faixasSemanais`, reaplicadas localmente pra
   * não precisar exportar aquela função interna) + acumulado/forecast do
   * mês, que já vêm prontos de `agregacaoSemanalExpedicao`.
   */
  function montarBlocoExpedicao(mesISO, hojeISO) {
    const agregacao = dbSql.agregacaoSemanalExpedicao(mesISO, hojeISO);
    if (!agregacao) return { disponivel: false };

    const totalDias = diasDoMes(mesISO);
    const labels = Array.from({ length: totalDias }, (_, i) => String(i + 1));
    const values = labels.map(() => 0);
    const cargasDoMes = dbSql.listarCargasExpedicao(mesISO);
    const cargasPorSemana = [0, 0, 0, 0]; // S1-S4, mesmas faixas de faixasSemanais (lib/db/expedicao.js)

    function indiceSemana(dia) {
      if (dia <= 7) return 0;
      if (dia <= 14) return 1;
      if (dia <= 21) return 2;
      return 3; // S4 absorve os dias extras do mês (22 até o fim), igual a faixasSemanais
    }

    cargasDoMes.forEach(c => {
      const dia = Number(c.data.split('-')[2]);
      if (dia >= 1 && dia <= totalDias) values[dia - 1] += c.m2;
      cargasPorSemana[indiceSemana(dia)]++;
    });

    return {
      disponivel: true,
      expedicaoPorDia: { labels, values: values.map(v => Math.round(v * 100) / 100) },
      cargasPorSemana: { labels: ['S1', 'S2', 'S3', 'S4'], values: cargasPorSemana },
      acumuladoM2: agregacao.acumuladoMes,
      acumuladoCargas: cargasDoMes.length,
    };
  }

  return function tentar(req, res, urlPath, queryParams) {

    // ── GET /db/one-page-report.json?mes=YYYY-MM (Fase 4): endpoint único
    // de agregação da tela — ver comentário de FASE 4, topo do arquivo.
    // `mes` é OPCIONAL aqui (diferente de /db/one-page-comentarios.json,
    // acima) — sem ele, cai no mês corrente (todayBrasiliaServer), que é
    // o que a tela abre por padrão.
    if (req.method === 'GET' && urlPath === '/db/one-page-report.json') {
      try {
        const mesParam = queryParams && queryParams.get ? queryParams.get('mes') : null;
        const hojeISO = todayBrasiliaServer();
        const mes = mesValido(mesParam) ? mesParam : hojeISO.slice(0, 7);

        const comentariosDoMes = comentarios.lerComentariosDoMes(mes);

        const resposta = {
          mes,
          mesReferencia: labelMes(mes),
          seguranca: { ...montarBlocoSeguranca(mes, hojeISO), ...comentariosDoBloco(comentariosDoMes, 'seguranca') },
          producao: { ...montarBlocoProducao(mes), ...comentariosDoBloco(comentariosDoMes, 'producao') },
          refugo: { ...montarBlocoRefugo(mes), ...comentariosDoBloco(comentariosDoMes, 'refugo') },
          expedicao: { ...montarBlocoExpedicao(mes, hojeISO), ...comentariosDoBloco(comentariosDoMes, 'expedicao') },
          assuntosGerais: comentarios.normalizarAssuntosGerais(comentariosDoMes && comentariosDoMes.assuntosGerais),
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resposta));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── GET /db/one-page-comentarios.json?mes=YYYY-MM: leitura livre —
    // devolve os comentários salvos daquele mês, ou um esqueleto com todos
    // os campos vazios se o mês nunca foi salvo (nunca `null` puro pro
    // frontend: ver comentário "NÃO tem noção de Dado indisponível", topo
    // de lib/db/one-page-comentarios.js — texto vazio é estado normal, o
    // frontend da Fase 5 só precisa dos campos existirem pra popular o
    // formulário). `mes` é obrigatório.
    if (req.method === 'GET' && urlPath === '/db/one-page-comentarios.json') {
      try {
        const mes = queryParams && queryParams.get ? queryParams.get('mes') : null;
        if (!mesValido(mes)) throw new Error('Parâmetro "mes" inválido — use o formato YYYY-MM.');
        const registro = comentarios.lerComentariosDoMes(mes) || {
          seguranca: { comentarios: '', proximosPassos: '' },
          producao: { comentarios: '', proximosPassos: '' },
          refugo: { comentarios: '', proximosPassos: '' },
          expedicao: { comentarios: '', proximosPassos: '' },
          assuntosGerais: { texto: '', fotos: [] },
          atualizadoEm: null,
        };
        // Normaliza assuntosGerais pro registro poder ser tanto um NOVO
        // ({texto, fotos}) quanto um ANTIGO (string solta, de antes das
        // fotos existirem) — ver normalizarAssuntosGerais, lib/db/
        // one-page-comentarios.js.
        registro.assuntosGerais = comentarios.normalizarAssuntosGerais(registro.assuntosGerais);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mes, ...registro }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── POST /salvar-comentarios-one-page-report: grava (substitui por
    // completo) os comentários de 1 mês — ver comentário de PERMISSÃO DE
    // ESCRITA, topo do arquivo.
    if (req.method === 'POST' && urlPath === '/salvar-comentarios-one-page-report') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (!payload || typeof payload !== 'object') throw new Error('Payload inválido.');
          const mes = payload.mes;
          if (!mesValido(mes)) throw new Error('Parâmetro "mes" inválido — use o formato YYYY-MM.');

          // Cada bloco (Segurança/Produção/Refugo/Expedição) é opcional no
          // payload (a tela pode salvar 1 bloco de cada vez, sem precisar
          // reenviar os outros 3) — mas se vier, precisa ser um objeto com
          // só string em comentarios/proximosPassos, nunca outro tipo
          // solto sendo gravado sem querer.
          const blocosValidados = {};
          for (const nomeBloco of BLOCOS_VALIDOS) {
            const bloco = payload[nomeBloco];
            if (bloco === undefined) continue;
            if (!bloco || typeof bloco !== 'object' || Array.isArray(bloco)) {
              throw new Error(`Bloco "${nomeBloco}" inválido — esperado um objeto com comentarios/proximosPassos.`);
            }
            blocosValidados[nomeBloco] = {
              comentarios: typeof bloco.comentarios === 'string' ? bloco.comentarios : '',
              proximosPassos: typeof bloco.proximosPassos === 'string' ? bloco.proximosPassos : '',
            };
          }
          const assuntosGerais = payload.assuntosGerais !== undefined
            ? {
                texto: typeof payload.assuntosGerais === 'string'
                  ? payload.assuntosGerais
                  : (typeof payload.assuntosGerais.texto === 'string' ? payload.assuntosGerais.texto : ''),
                fotos: validarFotosAssuntosGerais(
                  typeof payload.assuntosGerais === 'object' ? payload.assuntosGerais.fotos : undefined
                ) || [],
              }
            : undefined;

          // Mescla com o que já existia pro mês (salvar só Segurança não
          // deve apagar Produção/Refugo/Expedição/Assuntos Gerais já
          // salvos antes) — mesma preocupação de /salvar-metas não
          // sobrescrever o resto do config.json à toa.
          const existente = comentarios.lerComentariosDoMes(mes) || {};
          const registro = comentarios.salvarComentariosDoMes(mes, {
            ...existente,
            ...blocosValidados,
            assuntosGerais: assuntosGerais !== undefined ? assuntosGerais : existente.assuntosGerais,
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mes, ...registro }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    return false;
  };
};
