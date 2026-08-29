import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

/**
 * Production TypeScript imports local files with their emitted `.js` names.
 * Node's type-stripping test mode does not emit those files, so tests resolve a
 * missing local `.js` target to its checked-in `.ts` source when one exists.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.startsWith("file:")
      && (specifier.startsWith("./") || specifier.startsWith("../"))
      && specifier.endsWith(".js")
    ) {
      const sourceUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (fs.existsSync(fileURLToPath(sourceUrl))) {
        return { shortCircuit: true, url: sourceUrl.href };
      }
    }
    return nextResolve(specifier, context);
  },
});
