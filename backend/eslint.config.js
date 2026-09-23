const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

/**
 * Lint rules, chosen for what they prevent rather than for style.
 *
 * Formatting is Prettier's job and is checked separately, so nothing here
 * argues about whitespace. These rules exist to catch the classes of mistake
 * that a compiler will not: a promise nobody awaited, an `any` that erases a
 * contract, a value-import that survives into the emitted JavaScript and
 * silently drags a module across a boundary the architecture forbids.
 *
 * Boundary enforcement itself lives in .dependency-cruiser.cjs.
 */
module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'drizzle/**'],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'drizzle.config.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs['recommended-type-checked'].rules,

      // A dropped promise in a use case means an audit entry or a provider call
      // that silently never happened. This is the single most valuable rule here.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // `any` at a module boundary defeats the contracts entirely.
      '@typescript-eslint/no-explicit-any': 'error',

      // `import type` is erased at compile time. Using it for types keeps the
      // runtime dependency graph honest — dependency-cruiser reads the emitted
      // graph, so a stray value-import is a real edge, not a notational one.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // An adapter that implements an async port but has nothing to await —
      // every in-memory repository and every fake — is correct, not lazy. The
      // port's return type is the contract, and TypeScript already checks it.
      '@typescript-eslint/require-await': 'off',

      // Nest's DI decorators and the `interface Foo {}` port style trip these
      // without indicating a defect.
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    // Test doubles legitimately return loosely-typed fixtures.
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
];
