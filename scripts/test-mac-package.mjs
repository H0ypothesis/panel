import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import yauzl from "yauzl";
import { extractArchive, validateApp } from "../desktop/macos/updater.mjs";
import { packageMacApp } from "./package-mac.mjs";

const run = promisify(execFile);
test(
  "Mac update archive omits resource forks, preserves links and passes updater validation",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "panel-mac-package-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const app = join(directory, "Panel.app"),
      archive = join(directory, "Panel.zip");
    await mkdir(join(app, "Contents/MacOS"), { recursive: true });
    await mkdir(join(app, "Contents/Resources"));
    await cp("/usr/bin/true", join(app, "Contents/MacOS/Panel"));
    await writeFile(
      join(app, "Contents/Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>app.panel.desktop</string>
    <key>CFBundleExecutable</key><string>Panel</string>
    <key>CFBundleShortVersionString</key><string>0.9.5</string>
    <key>CFBundleVersion</key><string>0.9.5</string>
    <key>LSMinimumSystemVersion</key><string>13.5</string>
  </dict></plist>`,
    );
    const resource = join(app, "Contents/Resources/file.txt");
    await writeFile(resource, "app resource");
    await symlink("file.txt", join(app, "Contents/Resources/current"));
    await run("/usr/bin/xattr", [
      "-w",
      "com.panel.package-test",
      "metadata",
      resource,
    ]);
    await run("/usr/bin/codesign", ["--force", "--sign", "-", app]);
    await packageMacApp(app, archive, "0.9.5");
    const zip = await yauzl.openPromise(archive);
    const names = [];
    for await (const entry of zip.eachEntry()) names.push(entry.fileName);
    assert.ok(names.includes("Panel.app/Contents/Info.plist"));
    assert.ok(names.every((name) => !name.startsWith("__MACOSX/")));
    const unpacked = await extractArchive(archive, join(directory, "unpacked"));
    await validateApp(unpacked, "0.9.5");
    assert.equal(
      await readlink(join(unpacked, "Contents/Resources/current")),
      "file.txt",
    );
    assert.equal(
      await readFile(join(unpacked, "Contents/Resources/file.txt"), "utf8"),
      "app resource",
    );
    const verified = await readFile(archive);
    await assert.rejects(packageMacApp(app, archive, "0.9.6"), /身份或版本/);
    assert.deepEqual(await readFile(archive), verified);
  },
);
