import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  releaseCandidate,
  versionParts,
} from "../desktop/macos/updater.mjs";

// Run only after the release is public and its assets are fully uploaded.
// Keep exact GitHub-provided digests and URLs; never invent asset metadata.
export function publishedReleaseMetadata(release) {
  if (
    !versionParts(release?.tag_name) ||
    release.draft ||
    !release.published_at
  )
    throw new Error("Expected a published numeric GitHub Release.");
  const assets = ["arm64", "x64"].flatMap((architecture) => {
    const candidate = releaseCandidate(release, "0.0.0", architecture);
    return candidate
      ? [
          {
            name: `Panel-mac-${architecture}.zip`,
            state: "uploaded",
            size: candidate.size,
            digest: `sha256:${candidate.sha256}`,
            browser_download_url: candidate.url,
          },
        ]
      : [];
  });
  if (!assets.length)
    throw new Error("Release has no verified Mac archive metadata.");
  return {
    tag_name: release.tag_name,
    draft: false,
    prerelease: Boolean(release.prerelease),
    published_at: release.published_at,
    assets,
  };
}

async function main() {
  if (!process.argv[2])
    throw new Error(
      "Usage: node scripts/update-release-feed.mjs <published-release.json>",
    );
  const entry = publishedReleaseMetadata(
    JSON.parse(await readFile(process.argv[2], "utf8")),
  );
  const path = fileURLToPath(new URL("../updates/macos.json", import.meta.url));
  let previous = [];
  try {
    previous = JSON.parse(await readFile(path, "utf8")).releases;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const releases = [
    entry,
    ...previous
      .filter((item) => item.tag_name !== entry.tag_name)
      .map(publishedReleaseMetadata),
  ]
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))
    .slice(0, 20);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify(
      { schemaVersion: 1, repository: "H0ypothesis/panel", releases },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Updated ${path} from published ${entry.tag_name}; commit and push it after verifying release downloads.`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
