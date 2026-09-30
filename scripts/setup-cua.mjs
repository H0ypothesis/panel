import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const release = JSON.parse(
  await readFile(new URL("./cua-release.json", import.meta.url), "utf8"),
);

export function runtimeTarget(
  platform = process.platform,
  arch = process.arch,
) {
  const target =
    platform === "darwin" ? "darwin-universal" : `${platform}-${arch}`;
  if (!release.assets[target])
    throw new Error(`Cua Driver setup does not support ${platform}/${arch}.`);
  return target;
}

export function verifyArchive(bytes, asset) {
  if (bytes.length !== asset.size)
    throw new Error(
      "Cua Driver archive size does not match the pinned release.",
    );
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256)
    throw new Error(
      "Cua Driver SHA256 verification failed; nothing was installed.",
    );
}

export function validateArchiveEntries(entries) {
  for (const name of entries.split("\n").filter(Boolean)) {
    if (name.startsWith("/") || name.split("/").includes(".."))
      throw new Error(`Unsafe path in Cua Driver archive: ${name}`);
  }
}

export async function setupCua({
  projectRoot = root,
  platform = process.platform,
  arch = process.arch,
  fetchArchive = fetch,
} = {}) {
  const target = runtimeTarget(platform, arch);
  const asset = release.assets[target];
  const base = join(projectRoot, ".panel", "cua-driver", release.version);
  const destination = join(base, target);
  try {
    const installed = JSON.parse(
      await readFile(join(destination, "release.json"), "utf8"),
    );
    const binary = target.startsWith("darwin")
      ? join(destination, "CuaDriver.app/Contents/MacOS/cua-driver")
      : join(destination, "cua-driver");
    if (installed.sha256 === asset.sha256 && (await stat(binary)).isFile()) {
      console.log(
        `Cua Driver ${release.version} is already available: ${destination}`,
      );
      return destination;
    }
  } catch {
    /* Stage a verified replacement. */
  }
  await mkdir(base, { recursive: true });
  const temporary = await mkdtemp(join(base, ".download-"));
  try {
    console.log(
      `Downloading official Cua Driver ${release.version} (${target})…`,
    );
    const response = await fetchArchive(asset.url, {
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok)
      throw new Error(`Cua Driver download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verifyArchive(bytes, asset);
    const archive = join(temporary, asset.name);
    await writeFile(archive, bytes, { mode: 0o600 });
    const { stdout } = await execFileAsync("tar", ["-tzf", archive], {
      maxBuffer: 4 * 1024 * 1024,
    });
    validateArchiveEntries(stdout);
    const stage = join(temporary, "runtime");
    await mkdir(stage);
    await execFileAsync("tar", [
      "-xzf",
      archive,
      "-C",
      stage,
      `--strip-components=${asset.stripComponents}`,
    ]);
    const binary = target.startsWith("darwin")
      ? join(stage, "CuaDriver.app/Contents/MacOS/cua-driver")
      : join(stage, "cua-driver");
    if (!(await stat(binary)).isFile())
      throw new Error(
        "The official archive did not contain the expected Cua Driver executable.",
      );
    await chmod(binary, 0o755);
    if (platform === "darwin") {
      // Verify the unmodified signed app; never re-sign or strip quarantine.
      await execFileAsync("/usr/bin/codesign", [
        "--verify",
        "--deep",
        "--strict",
        join(stage, "CuaDriver.app"),
      ]);
    }
    await writeFile(
      join(stage, "release.json"),
      JSON.stringify({ version: release.version, target, ...asset }, null, 2) +
        "\n",
    );
    const previous = `${destination}.previous-${process.pid}`;
    let moved = false;
    try {
      try {
        await rename(destination, previous);
        moved = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await rename(stage, destination);
    } catch (error) {
      if (moved) await rename(previous, destination);
      throw error;
    }
    if (moved) await rm(previous, { recursive: true, force: true });
    console.log(`Verified Cua Driver ${release.version}: ${destination}`);
    console.log(
      "No global install, auto-start service, shell changes, or macOS permission changes were made.",
    );
    return destination;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  setupCua().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
