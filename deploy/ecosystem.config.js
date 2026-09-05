// ─── deploy/ecosystem.config.js ─────────────────────────────────────────────
// Modelo de configuração do PM2 pro Lightwall SC — usado quando o processo
// já roda via PM2 (`pm2 start server.js --name testes`, por exemplo) em vez
// de systemd (ver deploy/lightwall.service, alternativa equivalente).
//
// Por que isto existe: um `pm2 start server.js` direto (sem este arquivo)
// não tem onde guardar variáveis de ambiente de forma persistente — cada
// `pm2 restart` perde qualquer coisa que não seja exportada de novo na hora,
// na mesma sessão de terminal. Rodar `pm2 start` A PARTIR deste arquivo faz
// o PM2 guardar as variáveis junto com o processo, sobrevivendo a
// `pm2 restart`/reinício da VM (com `pm2 save` + `pm2 startup` configurados).
//
// ⚠️ NUNCA COMMITAR ESTE ARQUIVO COM VALORES REAIS PREENCHIDOS — é só um
// MODELO (os "cole-aqui-..." abaixo não são segredos de verdade). Depois de
// copiar e preencher na sua VM, deixe o arquivo real fora do controle de
// versão (já está listado em .gitignore, mas se copiar pra fora de deploy/
// com outro nome, confira de novo).
//
// COMO USAR (na VM, via SSH — nunca aqui no repositório de desenvolvimento):
//
//   1. Copie este arquivo pra um novo, com os valores reais. IMPORTANTE:
//      o nome do arquivo TEM que terminar exatamente em ".config.js" —
//      é assim que o PM2 reconhece "isto é um arquivo de configuração
//      com várias apps", não um script comum. Terminar em qualquer outra
//      coisa (ex: "ecosystem.config.real.js", que termina em ".real.js")
//      faz o PM2 tentar RODAR o próprio arquivo de config como se fosse
//      o servidor — bug real, já pego numa conversa.
//        cp deploy/ecosystem.config.js deploy/producao.config.js
//
//   2. Edite deploy/producao.config.js preenchendo GOOGLE_CLIENT_ID/
//      GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI com os valores reais do
//      Google Cloud Console (ver README.md, "Backup Automático no Google
//      Drive").
//
//   3. Se o app "testes" já existir no PM2 (ver `pm2 list`), remova antes
//      de recriar a partir do arquivo — o PM2 não atualiza variáveis de
//      ambiente de um processo já rodando só com `pm2 restart`:
//        pm2 delete testes
//        pm2 start deploy/producao.config.js
//
//   4. Confirme que o "script path" aponta pro server.js (não pro
//      próprio arquivo de config!) antes de seguir:
//        pm2 show testes
//
//   5. Salve a lista atual do PM2, pra sobreviver a um reboot da VM:
//        pm2 save
//
//   6. Confirme que as variáveis foram lidas:
//        pm2 env testes   (procure por GOOGLE_CLIENT_ID na lista)

module.exports = {
  apps: [
    {
      // Mesmo nome já usado hoje (`pm2 list` mostra "testes") — troque
      // pra outro nome se quiser, mas aí é `pm2 delete testes` antes,
      // não só `pm2 restart`.
      name: 'testes',
      script: 'server.js',
      cwd: __dirname + '/..', // raiz do projeto (deploy/ está 1 nível abaixo)
      env: {
        GOOGLE_CLIENT_ID: 'cole-aqui-o-client-id-do-google-cloud-console',
        GOOGLE_CLIENT_SECRET: 'cole-aqui-o-client-secret-do-google-cloud-console',
        GOOGLE_REDIRECT_URI: 'https://SEU-DOMINIO-OU-IP/backup-drive/callback',
        // PORT/HOST são opcionais — sem eles, server.js usa os padrões
        // 5000/127.0.0.1 (ver README.md, "Como rodar"). Só descomente se
        // precisar de outro valor:
        // PORT: '5000',
        // HOST: '127.0.0.1',
      },
    },
  ],
};
