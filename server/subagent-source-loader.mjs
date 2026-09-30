// Preload only in the source checkout. Detached upstream processes must resolve
// the same linked Pi packages as Panel before importing their runner entrypoint.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
const roots = new Map([
  ["@earendil-works/pi-agent-core", "agent"],
  ["@earendil-works/pi-ai", "ai"],
  ["@earendil-works/pi-telemetry", "telemetry"],
  ["@earendil-works/chord", "chord"],
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    for (const [name, directory] of roots) {
      if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
      const subpath =
        specifier === name ? "index" : specifier.slice(name.length + 1);
      for (const suffix of [".ts", "/index.ts"]) {
        const url = new URL(
          `../pi/packages/${directory}/src/${subpath}${suffix}`,
          import.meta.url,
        );
        if (existsSync(url)) return { url: url.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
