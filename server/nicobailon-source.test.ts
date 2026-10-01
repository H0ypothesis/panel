import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { adaptNicobailonSource } from "./nicobailon-source.mjs";

test("managed native artifact paths follow worktree cwd without remapping arbitrary output paths", async () => {
  const path = new URL(
    "../node_modules/pi-subagents/src/runs/shared/single-output.js",
    import.meta.url,
  );
  const source = adaptNicobailonSource(
    path.pathname,
    await readFile(path, "utf8"),
  );
  assert.equal(adaptNicobailonSource(path.pathname, source), source);
  const engine = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  assert.equal(
    engine.resolveSingleOutputPath(
      "report.md",
      "/project",
      "/worktree",
      "/project/.pi/subagents/artifacts/outputs/run",
    ),
    "/worktree/.pi/subagents/artifacts/outputs/run/report.md",
  );
  assert.equal(
    engine.resolveSingleOutputPath(
      "/project/.pi/subagents/artifacts/task.md",
      "/project",
      "/worktree",
    ),
    "/worktree/.pi/subagents/artifacts/task.md",
  );
  assert.equal(
    engine.resolveSingleOutputPath(
      "/external/report.md",
      "/project",
      "/worktree",
    ),
    "/external/report.md",
  );
  assert.equal(
    engine.resolveSingleOutputPath(
      "report.md",
      "/project",
      "/project",
      "/project/.pi/subagents/artifacts/outputs/run",
    ),
    "/project/.pi/subagents/artifacts/outputs/run/report.md",
  );
});
