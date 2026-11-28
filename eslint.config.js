import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'tests/architecture/fixtures/**',
      '**/dist/**',
      '**/build/**',
      '**/bin/**',
      '**/obj/**',
      // Declarations of the tool scripts; the tests check them with the compiler.
      'tools/*.d.mts',
      '**/node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'demo/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Files outside of the packages, such as the configs at the root, are checked with the options of the tests.
        projectService: { allowDefaultProject: ['*.js', '*.cjs', '*.ts'], defaultProject: 'tests/tsconfig.json' },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Reads from typed arrays in hot loops are written `values[i] as number`; `!` stays forbidden.
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      // Hooks of a base class that do nothing name their parameters with a leading underscore.
      '@typescript-eslint/no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  prettier,
];
