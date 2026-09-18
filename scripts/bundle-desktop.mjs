import { build } from "esbuild";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "build/desktop/app");
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "server"), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["server/index.ts", "server/pi-web-worker.ts"],
  outdir: join(output, "server"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"production"' },
  banner: {
    js: 'import { createRequire as __panelCreateRequire } from "node:module"; const require = __panelCreateRequire(import.meta.url);',
  },
  external: ["vite"],
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
await copyPackage("tsx", root);
await cp(join(root, "dist"), join(output, "dist"), { recursive: true });
await cp(join(root, ".env.example"), join(output, ".env.example"));
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
