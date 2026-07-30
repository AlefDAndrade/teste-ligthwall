// eslint.config.js
//
// Configuração básica do ESLint para o projeto Lightwall SC.
//
// Objetivo: pegar erros comuns cedo (variáveis não usadas, comparação
// solta tipo "if (x = 5)", código morto, etc) sem forçar um estilo
// específico de formatação — o foco aqui é achar BUGS, não brigar
// sobre aspas simples vs duplas.
//
// Rodar manualmente:   npx eslint .
// Corrigir automático:  npx eslint . --fix

const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs', // o projeto usa require()/module.exports, não import/export
      globals: {
        // Globais do Node.js (server.js, db.js, lib/, scripts/)
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        global: 'readonly',
        // Disponíveis nativamente a partir do Node 18 (usadas principalmente nos testes)
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
      },
    },
    rules: {
      // Erros que quase sempre indicam um bug de verdade
      'no-unused-vars': ['warn', { args: 'none' }], // avisa, mas não quebra o build por isso
      'no-undef': 'error',
      'no-cond-assign': 'error',       // pega o clássico "if (x = 5)" em vez de "if (x == 5)"
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'error',
      'no-var': 'off', // o projeto usa var/const/let misturado, não vamos forçar migração agora

      // Achados reais no código atual — deixamos como aviso (não quebram o CI)
      // para não travar o time de cara. Vale revisar e corrigir aos poucos.
      'no-prototype-builtins': 'warn',
      'no-empty': 'warn',
    },
  },

  {
    // Testes usam node:test / assert e não precisam de todas as regras acima com o mesmo rigor
    files: ['test/**/*.js'],
    rules: {
      'no-unused-vars': 'off',
    },
  },

  {
    // service-worker.js roda no navegador, não no Node — usa globais como
    // self/caches/Response que não existem no ambiente do servidor.
    files: ['public/service-worker.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        Response: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
      },
    },
  },

  {
    // Pastas que não devem ser analisadas
    ignores: [
      'node_modules/**',
      'public/js/**',      // scripts client-side gerados/vendorizados (ex.: SheetJS)
      'public/db/**',
      'public/index.html',
      'test/helpers/**',
    ],
  },
];
