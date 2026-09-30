import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
  // Resolve Next's plugins from its package under pnpm's strict layout.
  resolvePluginsRelativeTo: dirname(require.resolve("eslint-config-next")),
});

const config = [
  { ignores: [".next/**", "out/**", "build/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  // Destructuring fields away intentionally is not an unused-variable defect.
  { rules: { "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true }] } },
];

export default config;
