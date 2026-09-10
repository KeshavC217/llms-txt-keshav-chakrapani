/**
 * What `node --test` needs in order to import a route handler.
 *
 * The library suites import their modules directly and need none of this. Route
 * handlers are different in two ways that have nothing to do with what they do:
 *
 *  - they import through the `@/` alias, which is a tsconfig `paths` entry that
 *    Next resolves at build time and Node knows nothing about;
 *  - they import `next/server`, and the `next` package ships no `exports` map,
 *    so Node's ESM resolver will not guess the `.js` that CommonJS would.
 *
 * Both are resolution problems rather than behaviour, so they are fixed here
 * with a resolve hook rather than by contorting the routes to suit the test
 * runner. Loaded with `--import ./tests/setup.mjs`; see package.json.
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..") + "/").href;

registerHooks({
  resolve(specifier, context, next) {
    // `@/lib/store` is `<root>/lib/store.ts`. The extension is explicit because
    // Node does not add one, which is the same reason lib modules import each
    // other as `./dom.ts`.
    if (specifier.startsWith("@/")) {
      return next(`${new URL(specifier.slice(2), root).href}.ts`, context);
    }

    try {
      return next(specifier, context);
    } catch (error) {
      // A package with no `exports` map and no extension on the specifier:
      // `next/server` is `next/server.js`. Only retried for a specifier that
      // has no extension, so a genuinely missing module still fails as one.
      if (error?.code === "ERR_MODULE_NOT_FOUND" && !/\.[a-z]+$/i.test(specifier)) {
        return next(`${specifier}.js`, context);
      }
      throw error;
    }
  },
});
