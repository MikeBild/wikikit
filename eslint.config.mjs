// Flat ESLint config for a Bun-native TypeScript codebase.
// WHY typescript-eslint without type-aware rules: type-aware linting would
// re-run the compiler on every lint; `bun run typecheck` (tsc --noEmit) is the
// dedicated gate for that. Lint stays fast and catches structural problems.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

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
  {
    ignores: ['node_modules/', 'dist/', 'docs/', 'src/db/migrations/embedded.ts'],
  },
)
