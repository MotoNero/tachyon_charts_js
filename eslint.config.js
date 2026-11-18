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
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js', '*.cjs', '*.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Reads from typed arrays in hot loops are written `values[i] as number`; `!` stays forbidden.
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
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
