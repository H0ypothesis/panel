import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream, constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";
import yauzl from "yauzl";

const run = promisify(execFile);
const repository = "H0ypothesis/panel";
const api = `https://api.github.com/repos/${repository}/releases`;
const maxArchive = 512 * 1024 * 1024;
const maxExpanded = 2 * 1024 * 1024 * 1024;

export function versionParts(value) {
  if (typeof value !== "string" || !/^v?\d+\.\d+(?:\.\d+)?$/.test(value))
    return null;
  const parts = value.replace(/^v/, "").split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return [parts[0], parts[1], parts[2] ?? 0];
}

export function compareVersions(left, right) {
  const a = versionParts(left),
    b = versionParts(right);
  if (!a || !b) throw new Error("版本号格式无效。");
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function releaseCandidate(
  release,
  current,
  architecture = process.arch,
) {
  if (
    !release ||
    release.draft ||
    !release.published_at ||
    !versionParts(release.tag_name)
  )
    return null;
  if (compareVersions(release.tag_name, current) <= 0) return null;
  // A plain v0.5 tag is eligible even if GitHub marks it as a preview. Suffixes
  // such as -beta/-rc and the old date-based preview tags are never selected.
  const name = `Panel-mac-${architecture}.zip`;
  const asset = release.assets?.find(
    (item) => item.name === name && item.state === "uploaded",
  );
  if (
    !asset ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > maxArchive
  )
    return null;
  const expected = `https://github.com/${repository}/releases/download/${release.tag_name}/${name}`;
  if (
    asset.browser_download_url !== expected ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")
  )
    return null;
  return {
    version: release.tag_name,
    url: expected,
    size: asset.size,
    sha256: asset.digest.slice(7),
  };
}

async function githubJSON(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Panel-Updater",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(
      `无法检查 GitHub 更新（HTTP ${response.status}）。请稍后重试。`,
    );
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 8 * 1024 * 1024) throw new Error("更新信息过大。");
  return response.json();
}

export async function checkForUpdate(current, releases) {
  if (!versionParts(current)) throw new Error("当前 App 版本号无效。");
  const available = releases ?? (await githubJSON(`${api}?per_page=100`));
  if (!Array.isArray(available))
    throw new Error("GitHub 返回了无效的版本列表。");
  return (
    available
      .map((item) => releaseCandidate(item, current))
      .filter(Boolean)
      .sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
  );
}

function within(root, path) {
  const value = relative(root, path);
  return (
    value !== "" &&
    value !== ".." &&
    !value.startsWith(`..${sep}`) &&
    !value.startsWith(sep)
  );
}

export async function downloadArchive(
  candidate,
  destination,
  progress = () => {},
  fetchAsset = fetch,
) {
  let url = candidate.url;
  let response;
  for (let redirects = 0; redirects < 6; redirects++) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      ![
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
      ].includes(parsed.hostname)
    ) {
      throw new Error("安装包下载地址不受信任。");
    }
    response = await fetchAsset(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10 * 60_000),
      headers: { "User-Agent": "Panel-Updater" },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("安装包下载重定向无效。");
    url = new URL(location, url).href;
  }
  if (!response?.ok || !response.body)
    throw new Error(`安装包下载失败（HTTP ${response?.status ?? "未知"}）。`);
  const hash = createHash("sha256");
  let received = 0,
    previous = -1;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > candidate.size || received > maxArchive) {
        callback(new Error("安装包大小不符合发布信息。"));
        return;
      }
      hash.update(chunk);
      const percent = Math.floor((received / candidate.size) * 100);
      if (percent !== previous) {
        previous = percent;
        progress(percent);
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    meter,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  if (received !== candidate.size || hash.digest("hex") !== candidate.sha256)
    throw new Error("安装包 SHA-256 校验失败，已取消更新。");
}

export async function extractArchive(archive, destination) {
  await mkdir(destination, { mode: 0o700 });
  destination = await realpath(destination);
  const zip = await new Promise((accept, reject) =>
    yauzl.open(
      archive,
      {
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, result) => (error ? reject(error) : accept(result)),
    ),
  );
  const links = [],
    names = new Set();
  let bytes = 0,
    entries = 0;
  try {
    await new Promise((accept, reject) => {
      zip.on("error", reject);
      zip.on("end", accept);
      zip.on("entry", (entry) => {
        (async () => {
          if (++entries > 100_000) throw new Error("安装包文件数量过多。");
          const name = entry.fileName;
          if (
            name.includes("\0") ||
            name.split("/").some((part) => part === ".." || part === ".")
          )
            throw new Error("安装包包含不安全的路径。");
          if (name.startsWith("__MACOSX/")) return;
          if (name !== "Panel.app/" && !name.startsWith("Panel.app/"))
            throw new Error("安装包包含非 Panel 文件。");
          const path = resolve(destination, name);
          if (!within(destination, path))
            throw new Error("安装包路径超出目标目录。");
          const identity = path.normalize("NFD").toLowerCase();
          if (names.has(identity)) throw new Error("安装包包含重复路径。");
          names.add(identity);
          bytes += entry.uncompressedSize;
          if (bytes > maxExpanded || entry.uncompressedSize > maxArchive)
            throw new Error("解压后的安装包过大。");
          const mode = entry.externalFileAttributes >>> 16;
          const type = mode & 0o170000;
          if (
            ![0, 0o040000, 0o100000, 0o120000].includes(type) ||
            entry.isEncrypted()
          )
            throw new Error("不支持此安装包文件类型。");
          if (name.endsWith("/")) {
            await mkdir(path, { recursive: true, mode: 0o755 });
            return;
          }
          await mkdir(dirname(path), { recursive: true, mode: 0o755 });
          const stream = await new Promise((ok, fail) =>
            zip.openReadStream(entry, (error, result) =>
              error ? fail(error) : ok(result),
            ),
          );
          if (type === 0o120000) {
            if (entry.uncompressedSize > 4096) {
              stream.destroy();
              throw new Error("安装包链接过长。");
            }
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            const target = Buffer.concat(chunks).toString("utf8");
            if (
              !target ||
              target.includes("\0") ||
              !within(
                join(destination, "Panel.app"),
                resolve(dirname(path), target),
              )
            )
              throw new Error("安装包符号链接超出应用目录。");
            links.push({ path, target });
          } else {
            await pipeline(
              stream,
              createWriteStream(path, {
                flags: "wx",
                mode: mode & 0o111 ? 0o755 : 0o644,
              }),
            );
          }
        })().then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
    // Create links only after all regular files: an archive cannot write through
    // a symlink. Check complete link chains before allowing this app to run.
    for (const { path, target } of links) await symlink(target, path);
    for (const { path } of links) {
      if (!within(join(destination, "Panel.app"), await realpath(path)))
        throw new Error("安装包包含外部符号链接。");
    }
    return join(destination, "Panel.app");
  } finally {
    zip.close();
  }
}

async function plist(app, key) {
  return (
    await run("/usr/libexec/PlistBuddy", [
      "-c",
      `Print :${key}`,
      join(app, "Contents/Info.plist"),
    ])
  ).stdout.trim();
}

export function supportsArchitecture(header, architecture) {
  const cpu = { arm64: 0x0100000c, x64: 0x01000007 }[architecture];
  if (!cpu || header.length < 8) return false;
  const magic = header.readUInt32BE(0);
  if (magic === 0xcffaedfe) return header.readUInt32LE(4) === cpu;
  if (magic === 0xfeedfacf) return header.readUInt32BE(4) === cpu;
  if (![0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic))
    return false;
  const little = magic === 0xbebafeca || magic === 0xbfbafeca;
  const read = (offset) =>
    little ? header.readUInt32LE(offset) : header.readUInt32BE(offset);
  const count = read(4),
    stride = magic === 0xcafebabf || magic === 0xbfbafeca ? 32 : 20;
  if (count < 1 || count > 64 || header.length < 8 + count * stride)
    return false;
  return Array.from({ length: count }, (_, index) =>
    read(8 + index * stride),
  ).includes(cpu);
}

export async function validateApp(app, version) {
  if (
    (await plist(app, "CFBundleIdentifier")) !== "app.panel.desktop" ||
    compareVersions(await plist(app, "CFBundleShortVersionString"), version) !==
      0
  )
    throw new Error("下载的 App 身份或版本不符合发布信息。");
  const minimum = await plist(app, "LSMinimumSystemVersion");
  const system = (
    await run("/usr/bin/sw_vers", ["-productVersion"])
  ).stdout.trim();
  if (compareVersions(minimum, system) > 0)
    throw new Error(`新版需要 macOS ${minimum} 或更高版本。`);
  const executable = await plist(app, "CFBundleExecutable");
  if (executable !== "Panel") throw new Error("安装包主程序无效。");
  await access(join(app, "Contents/MacOS/Panel"), constants.X_OK);
  // lipo is an Xcode command-line-tools shim on some Macs. Read the Mach-O
  // header directly so end users never need developer tools to update.
  const binary = await open(join(app, "Contents/MacOS/Panel"), "r");
  try {
    const { buffer, bytesRead } = await binary.read(
      Buffer.alloc(4096),
      0,
      4096,
      0,
    );
    if (!supportsArchitecture(buffer.subarray(0, bytesRead), process.arch))
      throw new Error("安装包不支持当前 Mac 的 CPU 架构。");
  } finally {
    await binary.close();
  }
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
}

export async function replaceApp({
  app,
  prepared,
  backup,
  launch,
  move = rename,
}) {
  let saved = false,
    replaced = false;
  try {
    await move(app, backup);
    saved = true;
    await move(prepared, app);
    replaced = true;
    await launch(app);
  } catch (error) {
    if (saved) {
      // Preserve the failed candidate for diagnosis; never delete the backup
      // until the original path has been restored successfully.
      if (replaced) await move(app, prepared);
      await move(backup, app);
      try {
        await launch(app);
      } catch {
        /* The caller records the failure. */
      }
    }
    throw error;
  }
}

async function waitForExit(pid) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((accept) => setTimeout(accept, 200));
  }
  throw new Error("旧版 App 尚未退出，未替换应用。");
}

async function main() {
  const [mode, current, appPath, parent, target, report] =
    process.argv.slice(2);
  let committed = false,
    stage;
  process.once("SIGTERM", () => {
    if (!committed) {
      const cleanup = stage
        ? rm(stage, { recursive: true, force: true })
        : Promise.resolve();
      void cleanup.finally(() => process.exit(0));
    }
  });
  const emit = (state) => {
    if (!committed) process.stdout.write(JSON.stringify(state) + "\n");
  };
  process.stdout.on("error", () => {});
  try {
    if (mode === "check") {
      const candidate = await checkForUpdate(current);
      emit(
        candidate
          ? { phase: "available", version: candidate.version }
          : { phase: "idle" },
      );
      return;
    }
    if (
      mode !== "prepare" ||
      !versionParts(target) ||
      !versionParts(current) ||
      compareVersions(target, current) <= 0
    )
      throw new Error("更新请求无效。");
    const pid = Number(parent);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid !== process.ppid)
      throw new Error("更新进程来源无效。");
    if (!(await lstat(appPath)).isDirectory() || !appPath.endsWith(".app"))
      throw new Error("请将 Panel 放到可写的「应用程序」目录后再更新。");
    const app = await realpath(appPath);
    await access(dirname(app), constants.W_OK);
    await validateApp(app, current);
    const release = await githubJSON(
      `${api}/tags/${encodeURIComponent(target)}`,
    );
    const candidate = releaseCandidate(release, current);
    if (!candidate || compareVersions(candidate.version, target) !== 0)
      throw new Error("此版本没有可校验的兼容安装包。");
    stage = join(dirname(app), `.panel-update-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    const archive = join(stage, "Panel.zip");
    emit({ phase: "downloading", version: target, progress: 0 });
    await downloadArchive(candidate, archive, (progress) =>
      emit({ phase: "downloading", version: target, progress }),
    );
    emit({ phase: "verifying", version: target });
    const prepared = await extractArchive(archive, join(stage, "unpacked"));
    await validateApp(prepared, target);
    // No replacement until the native host has checked active work, stopped
    // its service, and explicitly committed. EOF or timeout aborts safely.
    const input = createInterface({ input: process.stdin });
    const permission = new Promise((accept) => {
      const timer = setTimeout(() => {
        input.close();
        accept(false);
      }, 120_000);
      input.once("line", (line) => {
        clearTimeout(timer);
        accept(line === "install");
        input.close();
      });
      input.once("close", () => {
        clearTimeout(timer);
        accept(false);
      });
    });
    emit({ phase: "ready", version: target });
    if (!(await permission)) return;
    committed = true;
    await waitForExit(pid);
    await validateApp(app, current);
    await replaceApp({
      app,
      prepared,
      backup: join(stage, "Previous.app"),
      launch: (path) => run("/usr/bin/open", ["-n", path]),
    });
    await rm(stage, { recursive: true, force: true });
    stage = undefined;
  } catch (error) {
    const message =
      error.code === "EACCES" || error.code === "EROFS"
        ? "安装位置不可写。请将 Panel 移到你的「应用程序」目录后重试。"
        : error.message || "更新失败，请稍后重试。";
    emit({ phase: "error", version: target, message });
    if (committed && report) {
      await writeFile(report, JSON.stringify({ message, backup: stage }), {
        mode: 0o600,
      }).catch(() => {});
    }
    process.exitCode = 1;
  } finally {
    if (stage && !committed) await rm(stage, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
