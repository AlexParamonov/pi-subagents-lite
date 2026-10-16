import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        files: ["test/**/*.ts"],
        rules: {
          "typescript/no-explicit-any": "error",
          // Vitest assertions inspect spy methods without invoking them.
          "typescript/unbound-method": "off",
          // Pi UI callbacks are typed as void, but tests await async handlers.
          "typescript/await-thenable": "off",
        },
      },
      {
        files: ["src/ui/agent-widget.ts"],
        // The widget cache compares method identity; it never invokes these refs.
        rules: { "typescript/unbound-method": "off" },
      },
      {
        files: [
          "src/ui/format.ts",
          "test/agent-color.test.ts",
          "test/ui/agent-widget.test.ts",
          "test/ui/conversation-viewer.test.ts",
          "test/ui/format.test.ts",
        ],
        // These patterns intentionally match terminal ANSI escape sequences.
        rules: { "no-control-regex": "off" },
      },
    ],
  },
  test: {
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
  fmt: {
    printWidth: 120,
    singleQuote: false,
    tabWidth: 2,
    useTabs: false,
    sortPackageJson: false,
    ignorePatterns: ["**/*.md", ".github/**", "tasks/**"],
  },
});
