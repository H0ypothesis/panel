import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin")
  throw new Error(
    "Build the Mac app on macOS with Xcode Command Line Tools installed.",
  );
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = resolve(process.env.PANEL_NODE_BINARY || process.execPath);
const nodeLicense =
  process.env.PANEL_NODE_LICENSE || resolve(dirname(node), "../LICENSE");
const run = (command, args) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
const capture = (command, args) =>
  execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
const version = capture(node, ["--version"]);
const architecture = capture(node, ["-p", "process.arch"]);
if (architecture !== process.arch)
  throw new Error(
    "Node and installed npm dependencies must use the same CPU architecture.",
  );
const [major, minor] = version.slice(1).split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19))
  throw new Error("Node.js >= 22.19 is required.");
const dependencies = capture("otool", ["-L", node])
  .split("\n")
  .slice(1)
  .map((line) => line.trim().split(" (")[0]);
const runtimeMinimum = capture("otool", ["-l", node]).match(
  /\bminos\s+(\d+\.\d+(?:\.\d+)?)/,
)?.[1];
const minimumOS =
  runtimeMinimum && Number.parseFloat(runtimeMinimum) > 13.5
    ? runtimeMinimum
    : "13.5";
if (
  dependencies.some(
    (path) =>
      !path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/"),
  )
) {
  throw new Error(
    "This Node binary depends on external libraries (for example Homebrew). Set PANEL_NODE_BINARY to the bin/node from the official macOS archive at https://nodejs.org/en/download. The app must not depend on this machine's Homebrew installation.",
  );
}

const app = join(root, "release/Panel.app");
await rm(app, { recursive: true, force: true });
const contents = join(app, "Contents");
const resources = join(contents, "Resources");
await mkdir(join(contents, "MacOS"), { recursive: true });
await mkdir(join(resources, "runtime/bin"), { recursive: true });
await cp(join(root, "build/desktop/app"), join(resources, "app"), {
  recursive: true,
});
await cp(node, join(resources, "runtime/bin/node"));
await chmod(join(resources, "runtime/bin/node"), 0o755);
await cp(nodeLicense, join(resources, "app/licenses/Node-LICENSE.txt"));
await cp(join(root, "desktop/macos/Info.plist"), join(contents, "Info.plist"));
run("/usr/libexec/PlistBuddy", [
  "-c",
  `Set :LSMinimumSystemVersion ${minimumOS}`,
  join(contents, "Info.plist"),
]);
run("xcrun", [
  "swiftc",
  "-swift-version",
  "5",
  "-O",
  "-target",
  `${architecture === "arm64" ? "arm64" : "x86_64"}-apple-macosx${minimumOS}`,
  "-module-cache-path",
  join(root, "build/swift-cache"),
  "desktop/macos/Panel.swift",
  "-o",
  join(contents, "MacOS/Panel"),
  "-framework",
  "AppKit",
  "-framework",
  "WebKit",
]);
run("xcrun", [
  "swift",
  "-module-cache-path",
  join(root, "build/swift-cache"),
  "desktop/macos/Icon.swift",
  join(root, "build/Panel.iconset"),
]);
run("iconutil", [
  "-c",
  "icns",
  join(root, "build/Panel.iconset"),
  "-o",
  join(resources, "Panel.icns"),
]);
// Ad-hoc signing is for local use. Developer ID/notarization is a release step.
run("codesign", [
  "--force",
  "--sign",
  "-",
  join(resources, "runtime/bin/node"),
]);
run("codesign", ["--force", "--sign", "-", app]);
run("codesign", ["--verify", "--deep", "--strict", app]);
const archive = join(root, `release/Panel-mac-${architecture}.zip`);
await rm(archive, { force: true });
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
await writeFile(
  join(root, "release/build-info.json"),
  JSON.stringify(
    {
      version: JSON.parse(await readFile(join(root, "package.json"), "utf8"))
        .version,
      architecture,
      node: version,
      minimumOS,
      signing: "ad-hoc",
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `\nBuilt ${app}\nArchive: ${archive}\nNode: ${version} (${architecture})`,
);
