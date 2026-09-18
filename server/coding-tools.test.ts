import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createPanelTools } from "./coding-tools.ts";
import { createShellEnvironment } from "./shell-environment.ts";

function output(result: AgentToolResult<unknown>) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function quoted(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "panel-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "work");
  await mkdir(cwd);
  const tools = createPanelTools(cwd);
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name);
    assert.ok(found);
    return found;
  };
  return { directory, cwd, tool };
}

test("Pi tools create, read and precisely edit real files", async (t) => {
  const { cwd, tool } = await fixture(t);
  await tool("write").execute("write", {
    path: "src/main.ts",
    content: "\uFEFFconst answer = 41;\r\nconsole.log(answer);\r\n",
  });
  const read = await tool("read").execute("read", {
    path: "src/main.ts",
    offset: 2,
    limit: 1,
  });
  assert.match(output(read), /console\.log\(answer\)/);
  const edit = await tool("edit").execute("edit", {
    path: "src/main.ts",
    edits: [{ oldText: "answer = 41", newText: "answer = 42" }],
  });
  assert.equal(
    await readFile(join(cwd, "src/main.ts"), "utf8"),
    "\uFEFFconst answer = 42;\r\nconsole.log(answer);\r\n",
  );
  assert.match(
    edit.details.patch,
    /-const answer = 41;[\s\S]*\+const answer = 42;/,
  );
  await assert.rejects(
    tool("edit").execute("missing-match", {
      path: "src/main.ts",
      edits: [{ oldText: "does not exist", newText: "bad" }],
    }),
  );
  assert.match(await readFile(join(cwd, "src/main.ts"), "utf8"), /answer = 42/);
});

test("all file tools reject traversal, external symlinks and dangling symlinks", async (t) => {
  const { directory, cwd, tool } = await fixture(t);
  const outside = join(directory, "work-other");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside");
  await symlink(outside, join(cwd, "escape"));
  await symlink(join(outside, "new.txt"), join(cwd, "dangling"));
  const paths = [
    "../work-other/secret.txt",
    join(outside, "secret.txt"),
    "escape/secret.txt",
    "dangling",
  ];
  for (const path of paths) {
    for (const name of ["read", "write", "edit"]) {
      await assert.rejects(
        tool(name).execute(`${name}-${path}`, {
          path,
          content: "modified",
          edits: [{ oldText: "outside", newText: "modified" }],
        }),
        Error,
        `${name} must reject ${path}`,
      );
    }
  }
  await assert.rejects(
    tool("write").execute("new-escape", {
      path: "escape/not-created/deep/file.txt",
      content: "bad",
    }),
    /超出当前工作目录/,
  );
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "outside");
  await assert.rejects(readFile(join(outside, "new.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(outside, "not-created/deep/file.txt")), {
    code: "ENOENT",
  });
});

test("canonical workspaces allow internal symlinks and serialize edits across instances", async (t) => {
  const { directory, cwd, tool } = await fixture(t);
  await symlink(cwd, join(directory, "workspace-alias"));
  const otherEdit = createPanelTools(join(directory, "workspace-alias")).find(
    (candidate) => candidate.name === "edit",
  )!;
  await writeFile(join(cwd, "shared.txt"), "first = 0\nsecond = 0\n");
  await symlink("shared.txt", join(cwd, "internal-link"));
  await Promise.all([
    tool("edit").execute("first", {
      path: "shared.txt",
      edits: [{ oldText: "first = 0", newText: "first = 1" }],
    }),
    otherEdit.execute("second", {
      path: "internal-link",
      edits: [{ oldText: "second = 0", newText: "second = 1" }],
    }),
  ]);
  assert.equal(
    await readFile(join(cwd, "shared.txt"), "utf8"),
    "first = 1\nsecond = 1\n",
  );
});

test("bash runs code in the selected directory and reports failed commands", async (t) => {
  const { cwd, tool } = await fixture(t);
  const script =
    "require('node:fs').writeFileSync('result.txt', String(6 * 7)); console.log(process.cwd())";
  const result = await tool("bash").execute("run-code", {
    command: `${quoted(process.execPath)} -e ${quoted(script)}`,
  });
  assert.equal(output(result).trim(), await realpath(cwd));
  assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "42");
  await assert.rejects(
    tool("bash").execute("failed", { command: "printf 'failure' >&2; exit 7" }),
    /failure[\s\S]*Command exited with code 7/,
  );
});

test("shell environment includes only explicit development settings", () => {
  const environment = createShellEnvironment({
    PATH: "/usr/bin:/bin",
    HOME: "/home/developer",
    LANG: "en_US.UTF-8",
    TMPDIR: "/tmp",
    OPENAI_API_KEY: "test-model-credential",
    UNRECOGNIZED_SERVICE_SECRET: "test-service-credential",
    HTTPS_PROXY: "https://user:credential@proxy.invalid",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    BASH_ENV: "/tmp/startup.sh",
    ENV: "/tmp/startup.sh",
    NODE_OPTIONS: "--require=/tmp/startup.cjs",
    PYTHONPATH: "/tmp/python",
    PYTHONSTARTUP: "/tmp/startup.py",
    LD_PRELOAD: "/tmp/startup.so",
    DYLD_INSERT_LIBRARIES: "/tmp/startup.dylib",
    "BASH_FUNC_injected%%": "() { echo injected; }",
  });
  assert.deepEqual(environment, {
    PATH: "/usr/bin:/bin",
    HOME: "/home/developer",
    LANG: "en_US.UTF-8",
    TMPDIR: "/tmp",
  });
});

test("bash children cannot inherit server credentials or startup injections", async (t) => {
  const { directory, cwd, tool } = await fixture(t);
  const shellMarker = join(cwd, "shell-startup-ran");
  const nodeMarker = join(cwd, "node-startup-ran");
  const shellStartup = join(directory, "startup.sh");
  const nodeStartup = join(directory, "startup.cjs");
  await writeFile(shellStartup, `printf injected > ${quoted(shellMarker)}\n`);
  await writeFile(
    nodeStartup,
    `require('node:fs').writeFileSync(${JSON.stringify(nodeMarker)}, 'injected');\n`,
  );
  const injections: Record<string, string> = {
    OPENAI_API_KEY: "panel-test-provider-secret",
    PANEL_TEST_UNKNOWN_SECRET: "panel-test-unknown-secret",
    HTTPS_PROXY: "https://user:panel-test-secret@proxy.invalid",
    SSH_AUTH_SOCK: "/tmp/panel-test-agent.sock",
    BASH_ENV: shellStartup,
    ENV: shellStartup,
    NODE_OPTIONS: `--require=${nodeStartup}`,
    PYTHONPATH: directory,
    PYTHONSTARTUP: join(directory, "startup.py"),
  };
  const previous = new Map(
    Object.keys(injections).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, injections);
    const script = `console.log(JSON.stringify({
      inherited: ${JSON.stringify(Object.keys(injections))}.filter(key => Object.hasOwn(process.env, key)),
      path: process.env.PATH,
      home: process.env.HOME,
      cwd: process.cwd(),
      result: 6 * 7
    }))`;
    const result = await tool("bash").execute("clean-environment", {
      command: `${quoted(process.execPath)} -e ${quoted(script)}`,
    });
    const child = JSON.parse(output(result));
    assert.deepEqual(child.inherited, []);
    assert.equal(child.path, process.env.PATH);
    assert.equal(child.home, process.env.HOME);
    assert.equal(child.cwd, await realpath(cwd));
    assert.equal(child.result, 42);
    for (const marker of [shellMarker, nodeMarker]) {
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("bash enforces finite timeout and aborts running commands before further effects", async (t) => {
  const { cwd, tool } = await fixture(t);
  const command =
    "printf 'started'; sleep 3; printf bad > should-not-exist.txt";
  await assert.rejects(
    tool("bash").execute("timeout", { command, timeout: 0.05 }),
    /timed out after 0.05 seconds/,
  );
  const controller = new AbortController();
  await assert.rejects(
    tool("bash").execute(
      "cancel",
      { command },
      controller.signal,
      (partial) => {
        if (output(partial).includes("started")) controller.abort();
      },
    ),
    /Command aborted/,
  );
  await assert.rejects(readFile(join(cwd, "should-not-exist.txt")), {
    code: "ENOENT",
  });
  for (const timeout of [0, -1, Infinity, 601]) {
    await assert.rejects(
      tool("bash").execute("invalid-timeout", { command, timeout }),
    );
  }
});

test("already-cancelled tools do not read, mutate or execute", async (t) => {
  const { cwd, tool } = await fixture(t);
  await writeFile(join(cwd, "keep.txt"), "original");
  const signal = AbortSignal.abort();
  for (const name of ["read", "write", "edit", "bash"]) {
    await assert.rejects(
      tool(name).execute(
        `cancelled-${name}`,
        {
          path: "keep.txt",
          content: "bad",
          edits: [{ oldText: "original", newText: "bad" }],
          command: "printf bad > keep.txt",
        },
        signal,
      ),
    );
  }
  assert.equal(await readFile(join(cwd, "keep.txt"), "utf8"), "original");
});

test("Pi truncates file and command output and preserves full command logs", async (t) => {
  const { cwd, tool } = await fixture(t);
  const lines = Array.from(
    { length: 3000 },
    (_, index) => `line-${index}`,
  ).join("\n");
  await writeFile(join(cwd, "large.txt"), lines);
  const read = await tool("read").execute("large-read", { path: "large.txt" });
  assert.equal(read.details.truncation.truncated, true);
  assert.match(output(read), /^line-0\n/);
  assert.match(output(read), /Use offset=2001/);
  const result = await tool("bash").execute("large-output", {
    command: "cat large.txt",
  });
  assert.equal(result.details.truncation.truncated, true);
  assert.match(output(result), /line-2999/);
  assert.ok(output(result).length < lines.length);
  const fullOutputPath: string = result.details.fullOutputPath;
  assert.equal(await readFile(fullOutputPath, "utf8"), lines);
  await rm(dirname(fullOutputPath), { recursive: true, force: true });
});
