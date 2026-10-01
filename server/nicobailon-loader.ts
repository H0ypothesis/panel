import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { adaptNicobailonSource } from "./nicobailon-source.mjs";

let engine: Promise<typeof import("./nicobailon-engine.ts")> | undefined;

export function loadNicobailon() {
  return (engine ??= (async () => {
    // tsx deliberately skips tsconfig aliases inside node_modules. Resolve the
    // linked Pi source packages for upstream imports in development as well.
    // Desktop bundles inline the executor and need no source resolver.
    if (import.meta.url.endsWith(".ts")) {
      const roots = new Map([
        ["@earendil-works/pi-agent-core", "agent"],
        ["@earendil-works/pi-ai", "ai"],
        ["@earendil-works/pi-telemetry", "telemetry"],
        ["@earendil-works/chord", "chord"],
      ]);
      registerHooks({
        load(url, context, nextLoad) {
          const result = nextLoad(url, context);
          if (
            url.endsWith("pi-subagents/src/runs/shared/single-output.js") &&
            result.source
          )
            return {
              ...result,
              source: adaptNicobailonSource(
                url,
                typeof result.source === "string"
                  ? result.source
                  : new TextDecoder().decode(result.source),
              ),
            };
          return result;
        },
        resolve(specifier, context, nextResolve) {
          for (const [name, directory] of roots) {
            if (specifier !== name && !specifier.startsWith(`${name}/`))
              continue;
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
    }
    return import("./nicobailon-engine.ts");
  })());
}
