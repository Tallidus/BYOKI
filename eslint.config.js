import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "examples/next-app/next-env.d.ts",
      "examples/next-app/lib/generated/**",
      "examples/next-app/public/artifacts/**",
    ],
  },
  {
    files: ["scripts/**/*.mjs", "kits/**/*.js"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        URL: "readonly",
        Request: "readonly",
        console: "readonly",
        process: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
);
