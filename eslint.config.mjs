// One flat config for the whole workspace. Every package's `eslint src/`
// script finds it by walking up from the package directory, so there is
// exactly one place where a lint rule is decided — the same reasoning that
// puts every integration operation behind one command service.
//
// **The baseline is kept green.** A rule only lives here if the repository
// passes it today, which means a lint failure always points at a real defect
// rather than at accumulated debt. Anything the type-checker already catches
// is deliberately off. To tighten, add one rule, fix what it finds, commit.
//
// Not yet covered, in rough order of value: test files (`eslint src/` only
// reaches `src/`), type-aware rules (need `projectService`, which makes lint
// depend on a build), and the Next.js plugin for `apps/web`.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
    ],
  },

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: { ...globals.node, ...globals.es2021 },
    },
    linterOptions: {
      // The baseline rule set is deliberately narrow, so an existing
      // eslint-disable comment for a rule that is not switched on yet reads
      // as "unused". Those comments are not stale — they are waiting for the
      // ratchet. Switch this back on once the rule set is wide enough for the
      // signal to mean something.
      reportUnusedDisableDirectives: 'off',
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...js.configs.recommended.rules,

      // tsconfig.base.json already sets noUnusedLocals and noUnusedParameters,
      // and tsc understands type-only imports; this rule does not.
      'no-unused-vars': 'off',
      // TypeScript resolves identifiers itself. On .ts files no-undef reports
      // nothing but false positives — types, enums, ambient declarations.
      'no-undef': 'off',
      // `catch {}` and `if (x) {}` are used deliberately in a few places;
      // an empty *block* is a style question, an empty catch is not.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Expressions that cannot mean what they look like.
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      // Loops that cannot terminate, or that run at most once.
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',

      // TS-only shapes that compile cleanly and are almost always mistakes.
      '@typescript-eslint/no-misused-new': 'error',
      '@typescript-eslint/no-unsafe-declaration-merging': 'error',
    },
  },

  {
    // Sanitizers for attacker-controlled text. These regexes match control
    // characters deliberately — stripping them before the text can reach a
    // prompt or an EvidencePackage is the entire job — so no-control-regex
    // finds here only the pattern it was written to flag. Listed one file at
    // a time, so that a sixth sanitizer is a deliberate addition and not a
    // silent exemption.
    files: [
      'packages/core/src/evidence-builder.ts',
      'packages/tools/src/tools/csv-analyzer.ts',
      'packages/tools/src/tools/document-analyzer.ts',
      'packages/tools/src/tools/pdf-generator.ts',
      'packages/tools/src/tools/web-research.ts',
    ],
    rules: { 'no-control-regex': 'off' },
  },

  {
    // The dashboard runs in the browser, not in Node.
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // A hook behind a condition breaks React's state ordering at runtime
      // and the type-checker cannot see it.
      'react-hooks/rules-of-hooks': 'error',
    },
  },
);

