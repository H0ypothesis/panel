import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGeneratedModelData } from "../pi/packages/ai/scripts/model-data.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// npm's lockfile verifies the release archive. Setup only copies its model
// metadata, so it never needs live catalog services or provider credentials.
export function setupPi({
  sourcePackage = join(root, "pi/packages/ai"),
  releasePackage = dirname(
    dirname(fileURLToPath(import.meta.resolve("@panel/pi-model-data"))),
  ),
} = {}) {
  const source = JSON.parse(
    readFileSync(join(sourcePackage, "package.json"), "utf8"),
  );
  const release = JSON.parse(
    readFileSync(join(releasePackage, "package.json"), "utf8"),
  );
  if (
    source.name !== "@earendil-works/pi-ai" ||
    release.name !== source.name ||
    release.version !== source.version
  ) {
    throw new Error(
      `Pi source (${source.name}@${source.version}) and model data (${release.name}@${release.version}) must match. Update @panel/pi-model-data with the Pi submodule, then run npm install --ignore-scripts.`,
    );
  }

  const providers = join(sourcePackage, "src/providers");
  // Keep staging on the destination filesystem for atomic directory renames.
  const staging = mkdtempSync(join(providers, ".panel-model-data-"));
  const stagedProviders = join(staging, "src/providers");
  const stagedData = join(stagedProviders, "data");
  const destination = join(providers, "data");
  const previous = join(staging, "previous-data");
  try {
    mkdirSync(stagedProviders, { recursive: true });
    copyFileSync(
      join(sourcePackage, "src/models.generated.ts"),
      join(staging, "src/models.generated.ts"),
    );
    for (const name of readdirSync(providers)) {
      if (name.endsWith(".models.ts")) {
        copyFileSync(join(providers, name), join(stagedProviders, name));
      }
    }
    cpSync(join(releasePackage, "dist/providers/data"), stagedData, {
      recursive: true,
    });
    // Use Pi's own schema, provider-set, model-identity and hash validation
    // before touching an existing installation.
    validateGeneratedModelData(staging);
    const hadData = existsSync(destination);
    if (hadData) renameSync(destination, previous);
    try {
      renameSync(stagedData, destination);
    } catch (error) {
      if (hadData) renameSync(previous, destination);
      throw error;
    }
  } finally {
    // If rollback itself failed, keep the previous data for manual recovery.
    if (existsSync(destination) || !existsSync(previous)) {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return source.version;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      `[setup:pi] Verified and installed Pi ${setupPi()} model data offline.`,
    );
  } catch (error) {
    console.error(`[setup:pi] ${error.message}`);
    process.exitCode = 1;
  }
}
