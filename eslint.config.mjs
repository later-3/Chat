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
      // 与.gitignore对齐：真实Provider实验与本地研究捕获不属于仓库源码。
      "**/.artifacts/**",
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
