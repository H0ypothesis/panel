import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import yauzl from "yauzl";
import { extractArchive, validateApp } from "../desktop/macos/updater.mjs";

const run = promisify(execFile);

export async function packageMacApp(app, archive, version) {
  if (basename(app) !== "Panel.app")
    throw new Error("The update archive must contain Panel.app.");
  // ditto wraps its 16-bit entry count instead of producing ZIP64. Resource
  // forks doubled our entry count and made older updaters stop halfway through.
  let entries = 1;
  const directories = [app];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries >= 0xffff)
        throw new Error(
          "Too many App files for ditto's ZIP format; use a ZIP64 packager.",
        );
      if (entry.isDirectory()) directories.push(join(directory, entry.name));
    }
  }
  await mkdir(dirname(archive), { recursive: true });
  const stage = await mkdtemp(join(dirname(archive), ".panel-package-"));
  try {
    const prepared = join(stage, basename(archive));
    await run(
      "/usr/bin/ditto",
      [
        "-c",
        "-k",
        "--norsrc",
        "--noextattr",
        "--noqtn",
        "--noacl",
        "--keepParent",
        app,
        prepared,
      ],
      { timeout: 10 * 60_000 },
    );
    const zip = await new Promise((accept, reject) =>
      yauzl.open(prepared, { lazyEntries: true }, (error, result) =>
        error ? reject(error) : accept(result),
      ),
    );
    const declared = zip.entryCount;
    zip.close();
    if (declared !== entries)
      throw new Error(
        `ZIP entry count mismatch: expected ${entries}, got ${declared}.`,
      );
    // Validate the archive with the actual updater, not Finder's more tolerant
    // extractor. Only replace the previous archive after the new one passes.
    const unpacked = await extractArchive(prepared, join(stage, "unpacked"));
    await validateApp(unpacked, version);
    await rename(prepared, archive);
    console.log(`Verified update archive: ${archive} (${entries} entries)`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 5)
    throw new Error(
      "Usage: node scripts/package-mac.mjs <Panel.app> <archive.zip> <version>",
    );
  await packageMacApp(
    resolve(process.argv[2]),
    resolve(process.argv[3]),
    process.argv[4],
  );
}
