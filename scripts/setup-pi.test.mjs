import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createModelDataManifest,
  readModelDataStructure,
  validateGeneratedModelData,
} from "../pi/packages/ai/scripts/model-data.ts";
import { setupPi } from "./setup-pi.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piPackage = join(root, "pi/packages/ai");
const releasedPackage = dirname(
  dirname(fileURLToPath(import.meta.resolve("@panel/pi-model-data"))),
);
const release = JSON.parse(
  readFileSync(join(releasedPackage, "package.json"), "utf8"),
);

function snapshot(directory) {
  return Object.fromEntries(
    readdirSync(directory).map((name) => [
      name,
      readFileSync(join(directory, name), "utf8"),
    ]),
  );
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "panel-setup-pi-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePackage = join(directory, "source");
  const releasePackage = join(directory, "release");
  const providers = join(sourcePackage, "src/providers");
  const data = join(providers, "data");
  const releaseData = join(releasePackage, "dist/providers/data");
  mkdirSync(providers, { recursive: true });
  mkdirSync(releaseData, { recursive: true });
  for (const target of [sourcePackage, releasePackage]) {
    writeFileSync(join(target, "package.json"), JSON.stringify(release));
  }
  const aggregator = readFileSync(
    join(piPackage, "src/models.generated.ts"),
    "utf8",
  )
    .split("\n")
    .filter((line) =>
      /^import .*\/providers\/(groq|kimi-coding)\.models\.ts/.test(line),
    )
    .join("\n");
  writeFileSync(join(sourcePackage, "src/models.generated.ts"), aggregator);
  const files = {};
  const structure = {};
  for (const provider of ["groq", "kimi-coding"]) {
    copyFileSync(
      join(piPackage, "src/providers", `${provider}.models.ts`),
      join(providers, `${provider}.models.ts`),
    );
    const name = `${provider}.json`;
    files[name] = readFileSync(
      join(releasedPackage, "dist/providers/data", name),
      "utf8",
    );
    writeFileSync(join(releaseData, name), files[name]);
    structure[provider] = Object.fromEntries(
      Object.entries(JSON.parse(files[name])).flatMap(([api, models]) =>
        Object.keys(models).map((id) => [id, api]),
      ),
    );
  }
  const manifest = createModelDataManifest(
    structure,
    files,
    "2026-09-29T00:00:00.000Z",
  );
  writeFileSync(join(releaseData, ".manifest.json"), JSON.stringify(manifest));
  return {
    sourcePackage,
    releasePackage,
    providers,
    data,
    releaseData,
    run() {
      const version = setupPi({ sourcePackage, releasePackage });
      assert.equal(
        readFileSync(join(sourcePackage, "src/models.generated.ts"), "utf8"),
        aggregator,
      );
      assert.equal(
        readdirSync(providers).some((name) =>
          name.startsWith(".panel-model-data-"),
        ),
        false,
      );
      return version;
    },
  };
}

test("the pinned npm model-data release matches the Pi source version", () => {
  const source = JSON.parse(
    readFileSync(join(piPackage, "package.json"), "utf8"),
  );
  const panel = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(release.version, source.version);
  assert.equal(
    panel.devDependencies["@panel/pi-model-data"],
    `npm:@earendil-works/pi-ai@${source.version}`,
  );
  assert.equal(panel.scripts["setup:pi"], "node scripts/setup-pi.mjs");
});

test("setup installs and validates released model metadata offline, then repeats safely", (t) => {
  t.mock.method(globalThis, "fetch", () => {
    assert.fail("setup must not fetch any remote model catalog");
  });
  const isolated = fixture(t);
  assert.equal(existsSync(isolated.data), false);
  const original = snapshot(isolated.releaseData);
  assert.equal(isolated.run(), release.version);
  validateGeneratedModelData(isolated.sourcePackage);
  assert.deepEqual(snapshot(isolated.data), original);
  assert.ok(
    Object.keys(readModelDataStructure(isolated.sourcePackage).groq).length > 0,
  );
  isolated.run();
  assert.deepEqual(snapshot(isolated.data), original);
  assert.deepEqual(snapshot(isolated.releaseData), original);
});

test("setup replaces old ignored catalogs instead of merging incompatible schemas", (t) => {
  const isolated = fixture(t);
  mkdirSync(isolated.data);
  writeFileSync(join(isolated.data, "obsolete.json"), "{}");
  writeFileSync(join(isolated.data, ".manifest.json"), '{"schemaVersion":3}');
  isolated.run();
  assert.equal(existsSync(join(isolated.data, "obsolete.json")), false);
  validateGeneratedModelData(isolated.sourcePackage);
});

for (const [scenario, corrupt, expected] of [
  [
    "version mismatch",
    (f) => {
      writeFileSync(
        join(f.releasePackage, "package.json"),
        JSON.stringify({ ...release, version: "0.85.1" }),
      );
    },
    /must match/,
  ],
  [
    "missing provider",
    (f) => {
      rmSync(join(f.releaseData, "groq.json"));
    },
    /groq.json/,
  ],
  [
    "extra provider",
    (f) => {
      copyFileSync(
        join(f.releaseData, "groq.json"),
        join(f.releaseData, "extra.json"),
      );
    },
    /provider data files do not match/,
  ],
  [
    "hash mismatch",
    (f) => {
      const path = join(f.releaseData, "groq.json");
      writeFileSync(path, readFileSync(path, "utf8") + "\n");
    },
    /does not match its manifest hash/,
  ],
  [
    "schema mismatch",
    (f) => {
      const path = join(f.releaseData, ".manifest.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...manifest, schemaVersion: 3 }));
    },
    /model data schema/,
  ],
  [
    "source shard mismatch",
    (f) => {
      rmSync(join(f.providers, "groq.models.ts"));
    },
    /aggregator and provider shards do not match/,
  ],
]) {
  test(`setup rejects ${scenario} and preserves the last usable data`, (t) => {
    const isolated = fixture(t);
    isolated.run();
    const before = snapshot(isolated.data);
    corrupt(isolated);
    assert.throws(() => isolated.run(), expected);
    assert.deepEqual(snapshot(isolated.data), before);
    assert.equal(
      readdirSync(isolated.providers).some((name) =>
        name.startsWith(".panel-model-data-"),
      ),
      false,
    );
  });
}
