import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.vite/**",
      "**/.workflow-bundle/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "**/.data/**",
      // 与.gitignore对齐：本地测试产物不参与lint
      "**/.test-artifacts/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
