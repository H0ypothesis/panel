import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { codingSandboxScope, createPanelTools } from "./coding-tools.ts";
import { createRunCodingTools } from "./run-coding-tools.ts";
import type { RunEnvironment } from "./runtime.ts";
import { prepareSandbox } from "./sandbox.ts";
import { sandboxConfig, SANDBOX_POLICY_VERSION } from "./sandbox-policy.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture(t: TestContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-isolation-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "project");
  await mkdir(root);
  const tools = createPanelTools(root);
  return {
    directory,
    root,
    tool: (name: string) => tools.find((tool) => tool.name === name)!,
  };
}

test("trusted sandbox provenance belongs to real Panel tools, not matching names or copies", async (t) => {
  const { root, tool } = await fixture(t);
  assert.deepEqual(codingSandboxScope(tool("bash"), root), {
    policyVersion: SANDBOX_POLICY_VERSION,
    workingDirectory: root,
  });
  assert.equal(codingSandboxScope({ ...tool("bash") }, root), undefined);
  assert.equal(codingSandboxScope({ name: "write" }, root), undefined);
});

test("file tools protect credentials, Panel state and executable configuration", async (t) => {
  const { root, tool } = await fixture(t);
  for (const path of [
    "nested/.env",
    "private.key",
    ".npmrc",
    ".panel/auth.json",
  ]) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), "original");
    for (const name of ["read", "write", "edit"]) {
      await assert.rejects(
        tool(name).execute(`${name}:${path}`, {
          path,
          content: "bad",
          edits: [{ oldText: "original", newText: "bad" }],
        }),
        /沙盒禁止/,
      );
    }
    assert.equal(await readFile(join(root, path), "utf8"), "original");
  }
  for (const path of [
    ".pi/extensions/evil.ts",
    ".git/hooks/pre-commit",
    ".git/config",
  ]) {
    await assert.rejects(
      tool("write").execute(path, { path, content: "bad" }),
      /沙盒禁止修改/,
    );
  }
});

test("native sandbox blocks outside writes and existing credential reads and writes", async (t) => {
  const { directory, root, tool } = await fixture(t);
  const outside = join(directory, "outside.txt");
  await writeFile(outside, "original");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested/.env"), "private-secret");
  await assert.rejects(
    tool("bash").execute("outside", {
      command: `printf bad > ${quote(outside)}`,
    }),
    /exit code|Permission denied|Operation not permitted/,
  );
  await assert.rejects(
    tool("bash").execute("read-secret", { command: "cat nested/.env" }),
  );
  await assert.rejects(
    tool("bash").execute("write-secret", {
      command: "printf bad > nested/.env",
    }),
  );
  assert.equal(await readFile(outside, "utf8"), "original");
  assert.equal(
    await readFile(join(root, "nested/.env"), "utf8"),
    "private-secret",
  );
});

test("default workspaces can write beneath protected Panel state without exposing sibling state", async (t) => {
  const { directory } = await fixture(t);
  const state = join(directory, "state");
  const root = join(state, "workspaces/id");
  await mkdir(root, { recursive: true });
  await writeFile(join(state, "auth.json"), "state-secret");
  const previous = process.env.PANEL_DATA_DIR;
  process.env.PANEL_DATA_DIR = state;
  try {
    const tools = createPanelTools(root);
    const bash = tools.find((tool) => tool.name === "bash")!;
    const config = await sandboxConfig(root, directory);
    assert.ok(!config.filesystem.denyWrite.includes(state));
    await tools
      .find((tool) => tool.name === "write")!
      .execute("file", { path: "file.txt", content: "file" });
    await bash.execute("shell", { command: "printf shell > shell.txt" });
    await assert.rejects(
      bash.execute("state", { command: "cat ../../auth.json" }),
    );
    assert.equal(await readFile(join(root, "shell.txt"), "utf8"), "shell");
    assert.throws(() => createPanelTools(state), /不能作为编码工作目录/);
  } finally {
    if (previous === undefined) delete process.env.PANEL_DATA_DIR;
    else process.env.PANEL_DATA_DIR = previous;
  }
});

test("concurrent commands keep independent workspaces and policies", async (t) => {
  const { directory, root, tool } = await fixture(t);
  const other = join(directory, "other");
  await mkdir(other);
  const bash = createPanelTools(other).find((tool) => tool.name === "bash")!;
  await Promise.all([
    tool("bash").execute("first", { command: "printf first > result.txt" }),
    bash.execute("second", { command: "printf second > result.txt" }),
  ]);
  assert.equal(await readFile(join(root, "result.txt"), "utf8"), "first");
  assert.equal(await readFile(join(other, "result.txt"), "utf8"), "second");
});

test("sandbox uses a private temporary directory and removes it after execution", async (t) => {
  const { tool } = await fixture(t);
  const result = await tool("bash").execute("temporary", {
    command: 'printf "%s" "$TMPDIR"; printf private > "$TMPDIR/marker"',
  });
  const temporary = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
  assert.match(temporary, /panel-sandbox-/);
  await assert.rejects(readFile(join(temporary, "marker")), { code: "ENOENT" });
});

test("network denial preserves command progress without replaying the shell", async (t) => {
  const { root } = await fixture(t);
  const requests: string[] = [];
  const bash = createPanelTools(root, async (request) => {
    requests.push(request.host);
    return false;
  }).find((tool) => tool.name === "bash")!;
  await assert.rejects(
    bash.execute("network", {
      command:
        "printf once >> progress.txt; curl --max-time 5 --fail https://example.invalid",
    }),
  );
  assert.deepEqual(requests, ["example.invalid"]);
  assert.equal(await readFile(join(root, "progress.txt"), "utf8"), "once");
  await assert.rejects(
    bash.execute("direct", {
      command: "curl --noproxy '*' --max-time 1 --fail https://example.invalid",
    }),
  );
  assert.deepEqual(requests, ["example.invalid"]);
});

test("network target grants are reused within a run and invalidated on settings changes", async (t) => {
  const { root } = await fixture(t);
  const requests: Array<{ name: string; arguments: Record<string, unknown> }> =
    [];
  let scope = "one";
  const environment: RunEnvironment = {
    sandboxPermissionScope: () => scope,
    beforeToolCall: async (call) => {
      requests.push(call);
      return true;
    },
    executeTool: async (_call, execute) => execute(),
    onToolUpdate: () => {},
  };
  const bash = createRunCodingTools(root, environment).find(
    (tool) => tool.name === "bash",
  )!;
  const command = "curl --max-time 2 --fail https://example.invalid";
  for (const id of ["first", "again"])
    await assert.rejects(bash.execute(id, { command }));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].name, "sandbox_network");
  assert.equal(requests[0].arguments.host, "example.invalid");
  assert.equal(requests[0].arguments.port, 443);
  scope = "two";
  await assert.rejects(bash.execute("changed", { command }));
  assert.equal(requests.length, 2);
});

test("private address literals cannot be permitted through the network callback", async (t) => {
  const { root } = await fixture(t);
  const requests: string[] = [];
  const bash = createPanelTools(root, async (request) => {
    requests.push(request.host);
    return true;
  }).find((tool) => tool.name === "bash")!;
  for (const host of ["127.0.0.2", "10.0.0.1", "[::1]"]) {
    await assert.rejects(
      bash.execute(host, {
        command: `curl --max-time 1 --fail https://${host}`,
      }),
    );
  }
  assert.deepEqual(requests, []);
});

test("cancelling a waiting network request stops later shell effects", async (t) => {
  const { root } = await fixture(t);
  const controller = new AbortController();
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  const bash = createPanelTools(root, async (_request, signal) => {
    started();
    return new Promise<boolean>((resolve) =>
      signal!.addEventListener("abort", () => resolve(false), { once: true }),
    );
  }).find((tool) => tool.name === "bash")!;
  const running = bash.execute(
    "waiting",
    {
      command:
        "curl --max-time 5 https://example.invalid; printf bad > later.txt",
    },
    controller.signal,
  );
  const rejected = assert.rejects(running, /aborted/);
  await requested;
  controller.abort();
  await rejected;
  await assert.rejects(readFile(join(root, "later.txt")), { code: "ENOENT" });
});

test("failed initialization and cancelled preparation do not fall back to host execution", async (t) => {
  const { directory, root } = await fixture(t);
  const marker = join(directory, "must-not-exist");
  await assert.rejects(
    prepareSandbox(`touch ${quote(marker)}`, join(directory, "missing")),
  );
  await assert.rejects(
    prepareSandbox(`touch ${quote(marker)}`, root, AbortSignal.abort()),
  );
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});
