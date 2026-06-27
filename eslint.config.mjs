// ESLint flat config — covers renderer (src/), electron main, tests, bin, scripts.
// Uses typescript-eslint for non-type-aware linting (fast, no project service).
// Focuses on catchable code-smell rules that `tsc --noEmit` can't find:
// unused vars, no-var, prefer-const, eqeqeq, trailing whitespace, etc.
//
// NOTE: this lints the main app only. The claw-bridge/ VS Code extension is a
// separate sub-project (its own package.json + tsconfig + build) and is ignored
// here; add a dedicated lint setup under claw-bridge/ if it ever needs one.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  // ---- base: recommended JS + TS rules ----
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---- global ignores ----
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "dist-electron/**",
      "dist-installer/**",
      "dist-installer*/**",
      "staging-source/**",
      "claw-bridge/**", // separate sub-project with its own build
      "docs/fusion/oracleJdk-*/**",
      "certs/**",
      "src/lib/scanner.js", // checked-in JS mirror of scanner.ts
    ],
  },

  // ---- TypeScript source (renderer + electron + tests) ----
  {
    files: ["src/**/*.{ts,tsx}", "electron/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      // Renderer touches browser globals; electron main touches node. Providing
      // both is harmless (a single shared tsconfig already pulls in both type sets).
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // --- catchable correctness rules ---
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off", // this codebase uses `any` deliberately at IPC boundaries
      "@typescript-eslint/no-empty-object-type": "off",
      // electron main compiles to CommonJS (electron/tsconfig.json module=CommonJS),
      // so `require()` for optional/native deps with try-catch fallback is intentional.
      "@typescript-eslint/no-require-imports": "off",
      // short-circuit / optional-chaining calls used as statements are a deliberate pattern here.
      "@typescript-eslint/no-unused-expressions": [
        "warn",
        {
          allowShortCircuit: true,
          allowTernary: true,
          allowTaggedTemplates: true,
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      "no-debugger": "warn",
      "prefer-const": "warn",
      "no-var": "error",
      "no-empty": ["warn", { allowEmptyCatch: true }], // empty catch blocks are an intentional pattern here
      "no-useless-assignment": "off", // newer rule, noisy on intentional reset-before-use
      "no-throw-literal": "off", // codebase throws strings in places; tsc catches these

      // --- style (non-blocking, keep the codebase tidy) ---
      eqeqeq: ["warn", "always", { null: "ignore" }],
      "no-multi-spaces": "off", // aligned trailing comments are intentional throughout
      "no-trailing-spaces": "warn",
      "no-irregular-whitespace": [
        "warn",
        { skipComments: true, skipStrings: true, skipTemplates: true },
      ],
      "no-multiple-empty-lines": ["warn", { max: 2, maxEOF: 1, maxBOF: 0 }],
    },
  },

  // ---- React renderer: hooks + fast-refresh rules ----
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },

  // ---- tests: relax some rules ----
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off", // assertion-style expressions in tests
      // triple-slash <reference path> pulls in a local .d.ts for node:sqlite ambient types.
      "@typescript-eslint/triple-slash-reference": [
        "warn",
        { path: "always", types: "prefer-import" },
      ],
      "no-console": "off",
    },
  },

  // ---- bin/ headless CLI (CommonJS) ----
  {
    files: ["bin/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "no-console": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },

  // ---- scripts/ build helpers (ESM) ----
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-console": "off",
    },
  },
);
