// Flat ESLint config for a Bun-native TypeScript codebase.
// WHY typescript-eslint without type-aware rules: type-aware linting would
// re-run the compiler on every lint; `bun run typecheck` (tsc --noEmit) is the
// dedicated gate for that. Lint stays fast and catches structural problems.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Underscore-prefixed = intentionally unused (factory-DI signatures often
      // take deps they forward without touching).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // `catch {}` is the house pattern for best-effort reads (.env files etc.).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // zod v4 + pg row shapes make `any` tempting; keep it an explicit choice.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // The cockpit is the one part of this repository that compiles for a browser.
  // It gets browser globals instead of node ones, and the two React rule sets
  // the server has no use for: the hooks rules catch a stale closure that would
  // show an operator last minute's data, and react-refresh catches the mixed
  // export that silently turns hot reload into a full page reload mid-edit.
  {
    files: ['apps/cockpit/**/*.ts', 'apps/cockpit/**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    ignores: [
      'node_modules/',
      'dist/',
      'docs/',
      'src/db/migrations/embedded.ts',
      // Generated, committed, and drift-checked rather than linted. The cockpit
      // bundle is minified Vite output and the embed is base64 of it — linting
      // either would grade a compiler's work against rules written for people.
      'assets/cockpit/',
      'src/cockpit-embedded.ts',
    ],
  },
)
