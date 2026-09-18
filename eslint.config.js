// config eslint flat (ESLint 10 / flat config) — base typescript-eslint RECOMMANDÉE,
// SANS règles stylistiques (le style est régi par une convention à part, pas
// par ESLint) — portée src/ + tests/, src/runtime exclu (code COMPILÉ CoffeeScript,
// déjà exclu du typecheck par tsconfig.json, jamais du TS écrit à la main)

import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // `**/*.mjs` — ce sont des COMPOSANTS ModularJS (balises, `@directives`, SASS), pas du
    // JavaScript : le parseur d'ESLint ne peut que s'y casser les dents (« Unexpected token < »)
    ignores: ['dist/**', 'node_modules/**', 'src/runtime/**', 'tests/snapshots/**', 'public/**', 'app/**', 'bench/**', '**/*.mjs']
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    extends: [tseslint.configs.recommended],
    linterOptions: {
      // commentaires eslint-disable hérités d'une config antérieure (no-console,
      // no-implied-eval, no-new-func — jamais activés ici) : ne pas les signaler
      reportUnusedDisableDirectives: 'off'
    },
    rules: {
      // typage intentionnellement LÂCHE (tsconfig strict:false, noImplicitAny:false) —
      // compilateur/AST/µschema manipulent des formes non typées par conception, pas
      // par oubli ; ~3750 sites, contredirait un choix de design assumé du projet
      '@typescript-eslint/no-explicit-any': 'off',
      // même rationale que no-explicit-any : `Function` en type large sert dans les
      // mocks de tests (callbacks d'événements non typés à dessein)
      '@typescript-eslint/no-unsafe-function-type': 'off',
      // idiome répété du projet `cond && call()` pour l'invocation conditionnelle de
      // handlers optionnels (mocks WS/DOM) — pas un oubli, allowShortCircuit couvre
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      // ~100 sites hérités (imports/vars morts épars) non traités ici —
      // abaissé en avertissement (pas éteint) + convention `_préfixe` déjà ignorée
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['tests/contract-types.test.ts'],
    rules: {
      // fonctions `_typeChecks*` jamais exécutées : expressions volontairement « mortes »
      // pour forcer tsc à TYPE-CHECKER le contrat (cf. en-tête du fichier) — pas des oublis
      '@typescript-eslint/no-unused-expressions': 'off'
    }
  }
)
