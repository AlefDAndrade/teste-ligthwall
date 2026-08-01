// ─── lib/contador-tracos-estado.js — Modo de Teste + Contador de Traços do Dia (estado) ──
// Fase 18 do fatiamento de server.js (ver README, "Fatiamento de server.js"
// → "Plano de continuidade"). CUIDADO pra não confundir com
// lib/rotas/contador-tracos.js (que já existe — é a ROTA HTTP GET; isso aqui
// é o estado que ela e lib/rotas/registro-operacao.js compartilham, além de
// lib/rotas/sobra.js, lib/rotas/leitura-e-ajustes.js e lib/rotas/backup.js,
// que também usam dirParaModoTeste/lerContadorTracosHoje).

module.exports = function criarContadorTracosEstado({ fs, path, DB_DIR, db, todayBrasiliaServer }) {

  // ─── MODO DE TESTE (Registrar Operação) ──────────────────────────────────
  // Toggle na tela "Registrar Operação" — quando ativo, a operação inteira
  // (historico, relatório de injeção, contador de traços, ajustes, sobra) é
  // salva em public/db/teste/ em vez de public/db/, pra treinar/testar o
  // fluxo sem misturar com dados reais de produção. Nunca toca nos arquivos
  // normais. Pasta criada na hora (mkdirSync) na primeira escrita.
  const DB_TESTE_DIR = path.join(DB_DIR, 'teste');

  function dirParaModoTeste(modoTesteFlag) {
    if (!modoTesteFlag) return DB_DIR;
    fs.mkdirSync(DB_TESTE_DIR, { recursive: true });
    return DB_TESTE_DIR;
  }

  // Lê o contador de traços do dia, resetando automaticamente se a data mudou
  // (Brasília). NÃO incrementa — apenas garante que o objeto retornado é válido
  // para o dia de hoje. Quem chama decide se quer ler ou incrementar.
  // Lê o contador de traços do dia — Modo de Teste continua em JSON
  // (arquivo isolado de sempre); o caminho real lê da tabela contador_tracos
  // (uma query simples, sem o reset manual de "novo dia" — cada dia já é
  // uma linha própria, então um dia novo simplesmente ainda não tem linha).
  function lerContadorTracosHoje(modoTesteFlag = false) {
    const hoje = todayBrasiliaServer();
    if (modoTesteFlag) {
      const contadorPath = path.join(dirParaModoTeste(true), 'contador_tracos.json');
      let contador = { data: hoje, total: 0 };
      try {
        contador = JSON.parse(fs.readFileSync(contadorPath, 'utf8'));
      } catch (_) { /* arquivo ainda não existe — usa o default acima */ }
      if (contador.data !== hoje) {
        contador = { data: hoje, total: 0 }; // novo dia: reinicia a contagem
      }
      return contador;
    }
    const row = db.prepare('SELECT total FROM contador_tracos WHERE data = ?').get(hoje);
    return { data: hoje, total: row ? row.total : 0 };
  }

  // Incrementa o contador de traços do dia em "quantidade" — Modo de Teste
  // continua fazendo ler-tudo-somar-escrever-tudo (arquivo isolado, sem
  // concorrência real pra se preocupar); o caminho real faz a soma DENTRO
  // do banco, numa query só — sem isso, dois "/confirmar-tracos-hoje" quase
  // simultâneos podiam ler o mesmo total, somar separado, e um incremento
  // se perder (o último a escrever "ganha", sem nunca somar os dois juntos).
  function incrementarContadorTracosHoje(quantidade, modoTesteFlag = false) {
    const hoje = todayBrasiliaServer();
    if (modoTesteFlag) {
      const contador = lerContadorTracosHoje(true);
      contador.total += quantidade;
      const contadorPath = path.join(dirParaModoTeste(true), 'contador_tracos.json');
      fs.writeFileSync(contadorPath, JSON.stringify(contador, null, 2), 'utf8');
      return contador;
    }
    db.prepare(`
      INSERT INTO contador_tracos (data, total) VALUES (?, ?)
      ON CONFLICT(data) DO UPDATE SET total = total + ?
    `).run(hoje, quantidade, quantidade);
    return lerContadorTracosHoje(false);
  }

  return {
    dirParaModoTeste,
    lerContadorTracosHoje,
    incrementarContadorTracosHoje,
  };
};
