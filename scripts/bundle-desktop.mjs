import { build } from "esbuild";
import ts from "typescript";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { release as cuaRelease, runtimeTarget } from "./setup-cua.mjs";
import excludedSubagents from "../server/subagent-exclusions.json" with { type: "json" };
import { adaptNicobailonSource } from "../server/nicobailon-source.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "build/desktop/app");
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "server"), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: [
    "server/index.ts",
    "server/native-web-worker.ts",
    "server/subagent-host-worker.ts",
    "server/subagent-host-factory.ts",
    "server/subagent-host.ts",
    "server/sandbox-worker.ts",
  ],
  outdir: join(output, "server"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  tsconfig: "tsconfig.json",
  // Apply source mappings inside the upstream subagent dependency, too.
  plugins: [
    {
      name: "panel-pi-source",
      setup(builder) {
        // Native discovery, theme assets and extension resolution depend on the
        // original package location, even when their code is inlined.
        builder.onLoad(
          {
            filter:
              /node_modules\/(pi-subagents|@earendil-works\/(pi-coding-agent|pi-tui))\/.*\.js$/,
          },
          async ({ path }) => {
            const source = await readFile(path, "utf8");
            const modulePath = relative(join(root, "node_modules"), path)
              .split(sep)
              .join("/");
            return {
              contents: adaptNicobailonSource(path, source).replaceAll(
                "import.meta.url",
                `new URL(${JSON.stringify("../node_modules/" + modulePath)}, import.meta.url).href`,
              ),
              loader: "js",
            };
          },
        );
        // Pi declares side effects for published .js paths; the desktop build
        // resolves the equivalent source .ts file and must retain registration.
        builder.onResolve(
          { filter: /^\.\/providers\/images\/register-builtins\.ts$/ },
          ({ path, resolveDir }) => ({
            path: resolve(resolveDir, path),
            sideEffects: true,
          }),
        );
        const packages = {
          "pi-agent-core": "agent",
          "pi-ai": "ai",
          "pi-telemetry": "telemetry",
          chord: "chord",
        };
        builder.onResolve(
          {
            filter:
              /^@earendil-works\/(pi-agent-core|pi-ai|pi-telemetry|chord)(\/.*)?$/,
          },
          ({ path }) => {
            const [, name, ...parts] = path.split("/");
            const entry = join(
              root,
              "pi/packages",
              packages[name],
              "src",
              parts.join("/") || "index",
            );
            for (const suffix of [".ts", "/index.ts"]) {
              if (existsSync(entry + suffix)) return { path: entry + suffix };
            }
          },
        );
      },
    },
  ],
  define: { "process.env.NODE_ENV": '"production"' },
  banner: {
    js: 'import { createRequire as __panelCreateRequire } from "node:module"; const require = __panelCreateRequire(import.meta.url);',
  },
  // Jiti lazily requires its sibling Babel transform; preserve that layout.
  external: ["vite", "jiti", "@anthropic-ai/sandbox-runtime"],
  logLevel: "info",
});

// These packages load TS/plugins/PDF assets at runtime. Preserve their actual
// dependency layout, including optional packages installed for this architecture.
const copied = new Set();
async function copyPackage(name, from, optional = false) {
  const require = createRequire(join(from, "package.json"));
  let source;
  for (const directory of require.resolve.paths(name) ?? []) {
    try {
      const candidate = join(directory, name);
      const manifest = JSON.parse(
        await readFile(join(candidate, "package.json"), "utf8"),
      );
      if (manifest.name === name) {
        source = candidate;
        break;
      }
    } catch {
      /* Try the next module resolution directory. */
    }
  }
  if (!source) {
    if (optional) return;
    throw new Error(`Missing desktop runtime dependency: ${name}`);
  }
  const modulePath = relative(join(root, "node_modules"), source);
  if (modulePath.startsWith(`..${sep}`) || modulePath === "..")
    throw new Error(
      `Runtime dependency must be installed in this project: ${name}`,
    );
  const identity = await realpath(source);
  if (copied.has(source)) return;
  copied.add(source);
  const destination = join(output, "node_modules", modulePath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(identity, destination, { recursive: true, dereference: true });
  const manifest = JSON.parse(
    await readFile(join(source, "package.json"), "utf8"),
  );
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    await copyPackage(
      dependency,
      source,
      dependency in (manifest.optionalDependencies ?? {}),
    );
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {}))
    await copyPackage(dependency, source, true);
}
await copyPackage("pi-web-access", root);
await copyPackage("@anthropic-ai/sandbox-runtime", root);
await copyPackage("tsx", root);
await copyPackage("pi-subagents", root);
// Detached upstream runners load the copied package outside the esbuild bundle.
const nativeOutputModule = join(
  output,
  "node_modules/pi-subagents/src/runs/shared/single-output.js",
);
await writeFile(
  nativeOutputModule,
  adaptNicobailonSource(
    nativeOutputModule,
    await readFile(nativeOutputModule, "utf8"),
  ),
);
for (const name of excludedSubagents) {
  await rm(join(output, "node_modules/pi-subagents/agents", `${name}.md`), {
    force: true,
  });
}
await copyPackage("@earendil-works/pi-coding-agent", root);
await copyPackage("@earendil-works/pi-tui", root);
// The workspace links Pi source packages. Ship compiled equivalents as well,
// because user extensions resolve these packages outside the server bundle.
for (const name of ["pi-agent-core", "pi-ai", "pi-telemetry", "chord"]) {
  await copyPackage(`@earendil-works/${name}`, root);
  const packageDir = join(output, "node_modules/@earendil-works", name);
  const { readdir } = await import("node:fs/promises");
  async function compileSource(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await compileSource(path);
      else if (
        entry.name.endsWith(".ts") &&
        !/\.(test|d)\.ts$/.test(entry.name)
      ) {
        const destination = join(
          packageDir,
          "dist",
          relative(join(packageDir, "src"), path),
        ).replace(/\.ts$/, ".js");
        const result = ts.transpileModule(await readFile(path, "utf8"), {
          fileName: path,
          compilerOptions: {
            target: ts.ScriptTarget.ES2023,
            module: ts.ModuleKind.ESNext,
            rewriteRelativeImportExtensions: true,
          },
        });
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, result.outputText);
      }
    }
  }
  await compileSource(join(packageDir, "src"));
}
await build({
  absWorkingDir: root,
  entryPoints: ["desktop/macos/updater.mjs"],
  outfile: join(output, "updater.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: 'import { createRequire as __panelCreateRequire } from "node:module"; const require = __panelCreateRequire(import.meta.url);',
  },
});
await cp(join(root, "dist"), join(output, "dist"), { recursive: true });
await cp(join(root, ".env.example"), join(output, ".env.example"));
// Ship the verified, unmodified official runtime when setup:cua has staged it.
// Preserve app-bundle symlinks verbatim so its Developer ID signature survives.
const cuaTarget = runtimeTarget();
const cuaSource = join(
  root,
  ".panel/cua-driver",
  cuaRelease.version,
  cuaTarget,
);
try {
  const manifest = JSON.parse(
    await readFile(join(cuaSource, "release.json"), "utf8"),
  );
  if (manifest.sha256 !== cuaRelease.assets[cuaTarget].sha256)
    throw new Error(
      "Staged Cua Driver does not match scripts/cua-release.json; run npm run setup:cua.",
    );
  await cp(
    cuaSource,
    join(output, "cua-driver", cuaRelease.version, cuaTarget),
    {
      recursive: true,
      verbatimSymlinks: true,
    },
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.warn(
    "Cua Driver not bundled: run npm run setup:cua before packaging to include computer use.",
  );
}
await writeFile(
  join(output, "package.json"),
  JSON.stringify({ private: true, type: "module" }) + "\n",
);

// Preserve third-party notices even for code inlined by esbuild.
const notices = join(output, "licenses");
await mkdir(notices, { recursive: true });
const { readdir } = await import("node:fs/promises");
async function collectNotices(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      await collectNotices(join(directory, entry.name), entry.name + "--");
      continue;
    }
    const packageRoot = join(directory, entry.name);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    for (const name of await readdir(packageRoot)) {
      if (/^(license|licence|notice|copying)(\.|$)/i.test(name)) {
        await cp(
          join(packageRoot, name),
          join(notices, `${prefix}${entry.name}--${name}`),
          { recursive: true },
        );
      }
    }
  }
}
await collectNotices(join(root, "node_modules"));
await cp(join(root, "pi/LICENSE"), join(notices, "pi-LICENSE"));
console.log(`Desktop service bundled: ${output}`);
