import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      /*
       * Node runs these files by stripping types, and a constructor parameter
       * property is not a type to strip - it generates an assignment, which
       * strip-only mode refuses at runtime. tsc compiles it happily, so the
       * failure only appears when the tests import the file. It has cost two
       * debugging detours; this makes it a lint error instead.
       */
      "@typescript-eslint/parameter-properties": ["error", { prefer: "class-property" }],
    },
  },
]);

export default eslintConfig;
