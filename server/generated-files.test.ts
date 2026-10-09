import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApi } from "./api.ts";
import { Store, type StoredNode } from "./store.ts";
import type { Runtime } from "./runtime.ts";
import type { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import type { GeneratedFile } from "../shared/generated-files.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

async function fixture(t: TestContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-generated-files-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project");
  await mkdir(project);
  const store = new Store(join(directory, "data"));
  const workspace = createWorkspace("opd 多模态", "");
  workspace.workingDirectory = project;
  const node: StoredNode = {
    ...workspace.nodes[0],
    id: "report-node",
    parentId: workspace.nodes[0].id,
    status: "completed",
    prompt: "整理成一个网页方便看",
    revision: 0,
    response: "文件：`opd-opsd-multimodal-survey.html`",
    toolCalls: [],
    execution: { workingDirectory: project, approvalMode: "ask" },
  };
  workspace.nodes.push(node);
  const answer = (response: string) => {
    node.response = response;
    node.messages = [fauxAssistantMessage(response)];
  };
  answer(node.response);
  store.data.workspaces.push(workspace);
  const api = createApi(store, {} as Runtime, {} as Scheduler);
  const base = `/api/workspaces/${workspace.id}/nodes/${node.id}/generated-files`;
  const call = async (
    path = "?revision=0",
    method = "GET",
    headers: Record<string, string> = {},
  ) => {
    const request = Readable.from(
      method === "POST" ? [Buffer.from("{}")] : [],
    ) as IncomingMessage;
    Object.assign(request, {
      url: base + path,
      method,
      headers: {
        host: "127.0.0.1:9999",
        "content-type": "application/json",
        ...headers,
      },
    });
    const chunks: Buffer[] = [];
    const responseHeaders: Record<string, unknown> = {};
    let status = 0;
    const response = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    Object.assign(response, {
      headersSent: false,
      setHeader(name: string, value: unknown) {
        responseHeaders[name.toLowerCase()] = value;
      },
      writeHead(code: number, values: Record<string, unknown>) {
        status = code;
        Object.assign(responseHeaders, values);
        (this as unknown as { headersSent: boolean }).headersSent = true;
      },
    });
    await api(request, response as unknown as ServerResponse);
    const output = Buffer.concat(chunks);
    return {
      status,
      output,
      headers: responseHeaders,
      json: () => JSON.parse(output.toString()),
    };
  };
  const record = (
    path: string,
    name = "write",
    status: "completed" | "denied" | "failed" = "completed",
  ) => {
    node.toolCalls!.push({
      id: `call-${node.toolCalls!.length}`,
      name,
      status,
      arguments: { path },
      startedAt: 1,
    });
  };
  return { directory, project, store, workspace, node, call, record, answer };
}

test("legacy inline filenames get file entries from write/edit and command snapshots without migrating records", async (t) => {
  const f = await fixture(t);
  const html =
    "<!doctype html><title>OPD 调研</title><script>document.body.dataset.ready='yes'</script>";
  await writeFile(join(f.project, "opd-opsd-multimodal-survey.html"), html);
  await writeFile(join(f.project, "报告.md"), "# 完整报告");
  f.answer(f.node.response + "\n\n完整报告：`报告.md`");
  f.record("opd-opsd-multimodal-survey.html");
  f.record(join(f.project, "opd-opsd-multimodal-survey.html"), "edit");
  f.workspace.gitHistory = [
    {
      id: "snapshot",
      nodeId: f.node.id,
      nodeRevision: 0,
      nodePrompt: f.node.prompt,
      toolCallId: "bash",
      toolName: "bash",
      workingDirectory: f.project,
      createdAt: 1,
      status: "completed",
      summary: "命令生成报告",
      files: [{ path: "报告.md", status: "added" }],
    },
  ];
  const before = JSON.stringify(f.store.data);
  const list = await f.call();
  assert.equal(list.status, 200);
  const files = list.json().files as GeneratedFile[];
  assert.equal(files.length, 2);
  assert.deepEqual(
    files.map((file) => file.name),
    ["opd-opsd-multimodal-survey.html", "报告.md"],
  );
  const file = files[0];
  assert.equal(file.status, "available");
  assert.equal(file.size, Buffer.byteLength(html));
  assert.equal(file.nativeOpenable, true);
  const preview = await f.call(`/${file.id}/content?revision=0`);
  assert.equal(preview.status, 200);
  assert.equal(preview.output.toString(), html);
  const csp = String(preview.headers["Content-Security-Policy"]);
  assert.match(csp, /sandbox allow-scripts/);
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation/);
  assert.equal(
    preview.headers["X-Content-Type-Options"] ??
      preview.headers["x-content-type-options"],
    "nosniff",
  );
  const download = await f.call(
    `/${files[1].id}/content?revision=0&download=1`,
  );
  assert.equal(download.status, 200);
  assert.match(
    String(download.headers["Content-Disposition"]),
    /attachment.*%E6%8A%A5%E5%91%8A/,
  );
  const native = await f.call(`/${file.id}/native?revision=0`, "POST");
  assert.deepEqual(native.json(), {
    path: join(f.project, file.name),
    root: f.project,
    nativeOpenable: true,
  });
  assert.equal(JSON.stringify(f.store.data), before);
});

test("candidates exclude unexecuted tools, prompt-only paths, hidden state and paths outside the recorded directory", async (t) => {
  const f = await fixture(t);
  for (const path of [
    ".env",
    ".pi/subagents/handoffs/report.md",
    "../outside.md",
    join(f.directory, "outside.md"),
    "node_modules/pkg/readme.md",
  ])
    f.record(path);
  f.record("denied.md", "write", "denied");
  f.record("failed.md", "write", "failed");
  f.record("read.md", "read");
  assert.deepEqual((await f.call()).json(), { files: [] });
  const denied = await f.call(`/${"a".repeat(64)}/content?revision=0`);
  assert.equal(denied.status, 404);
  assert.match(denied.json().error, /未登记/);
});

test("a webpage delivery omits its images, processing scripts, manifest and deleted intermediate PDFs", async (t) => {
  const f = await fixture(t);
  const html = "opd-opsd-multimodal-survey.html";
  await writeFile(join(f.project, html), '<img src="images/figure-0.png">');
  f.record(html, "edit");
  for (const path of [
    "fetch_figs.py",
    "retry_figs.py",
    "fix_figs.py",
    "fix2_figs.py",
    "insert_figs.py",
  ]) {
    await writeFile(join(f.project, path), "# processing script");
    f.record(path);
  }
  await mkdir(join(f.project, "images"));
  const assets = [
    "images/manifest.json",
    ...Array.from({ length: 23 }, (_, i) => `images/figure-${i}.png`),
  ];
  for (const path of assets) await writeFile(join(f.project, path), "asset");
  f.workspace.gitHistory = [
    {
      id: "assets",
      nodeId: f.node.id,
      nodeRevision: 0,
      nodePrompt: f.node.prompt,
      toolCallId: "bash",
      toolName: "bash",
      workingDirectory: f.project,
      createdAt: 1,
      status: "completed",
      summary: "添加网页配图",
      files: [
        ...assets,
        "images/_gkd.pdf",
        "images/_imitkd.pdf",
        "images/_minillm.pdf",
      ].map((path) => ({ path, status: "added" })),
    },
  ];
  f.node.messages = [
    fauxAssistantMessage("先写入 `fetch_figs.py`，下载临时 PDF。", {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      `完成！23 张图片已保存。\n\n小的已知限制：图片 \u0060images/figure-0.png\u0060 较大。\n\n打开方式不变：浏览器打开 \u0060${html}\u0060 即可。`,
    ),
  ];
  f.node.response = f.node.messages
    .flatMap((m) =>
      m.role === "assistant"
        ? m.content.flatMap((c) => (c.type === "text" ? [c.text] : []))
        : [],
    )
    .join("");
  assert.deepEqual(
    (await f.call()).json().files.map((file: GeneratedFile) => file.path),
    [html],
  );
  // Normal code changes without a delivery reference do not create an empty file section.
  f.answer("已更新页面代码并通过检查。");
  assert.deepEqual((await f.call()).json().files, []);
});

test("later path replies reuse only explicitly mentioned files generated by their own ancestors", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.project, "report.html"), "report");
  f.record("report.html");
  const later: StoredNode = {
    ...f.node,
    id: "later",
    parentId: f.node.id,
    toolCalls: [],
    response: `文件路径：\n\n\u0060\u0060\u0060\n${f.project}/report.html\n\u0060\u0060\u0060`,
  };
  later.messages = [fauxAssistantMessage(later.response)];
  f.workspace.nodes.push(later);
  // Request helper targets the original ID, so exchange IDs without losing ancestry.
  f.node.id = "original";
  later.parentId = "original";
  later.id = "report-node";
  assert.equal((await f.call()).json().files[0].name, "report.html");
  later.response = "这里仅提到不存在的 arbitrary.html 和 report.html.bak";
  later.messages = [fauxAssistantMessage(later.response)];
  assert.deepEqual((await f.call()).json().files, []);
  later.response = "`report.html`";
  later.messages = [fauxAssistantMessage(later.response)];
  later.parentId = f.workspace.nodes[0].id;
  assert.deepEqual((await f.call()).json().files, []);
});

test("removed files remain identifiable and return a clear missing error; stale revisions cannot open them", async (t) => {
  const f = await fixture(t);
  f.answer("文件：`missing.html`");
  f.record("missing.html");
  const [file] = (await f.call()).json().files as GeneratedFile[];
  assert.equal(file.status, "missing");
  assert.equal((await f.call(`/${file.id}/content?revision=0`)).status, 404);
  await writeFile(join(f.project, "missing.html"), "report");
  f.node.revision = 1;
  assert.equal((await f.call(`/${file.id}/content?revision=0`)).status, 409);
  assert.equal((await f.call()).status, 409);
  assert.equal((await f.call("?revision=-1")).status, 400);
  assert.equal((await f.call("")).status, 400);
  assert.equal(
    (await f.call(`/${file.id}/native?revision=0`, "POST")).status,
    409,
  );
});

test("symlink files, symlink parents, non-files and replaced execution roots never expose content", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "secret.txt"), "PRIVATE");
  await symlink(join(f.directory, "secret.txt"), join(f.project, "link.txt"));
  await mkdir(join(f.project, "folder"));
  await symlink(f.directory, join(f.project, "linked-folder"));
  for (const path of ["link.txt", "linked-folder/secret.txt", "folder"])
    f.record(path);
  f.answer(
    "### 交付文件\n- `link.txt`\n- `linked-folder/secret.txt`\n- `folder`",
  );
  const files = (await f.call()).json().files as GeneratedFile[];
  assert.equal(files.length, 3);
  for (const file of files) {
    assert.equal(file.status, "unavailable");
    assert.equal((await f.call(`/${file.id}/content?revision=0`)).status, 403);
    assert.equal(
      (await f.call(`/${file.id}/native?revision=0`, "POST")).status,
      403,
    );
  }
  await rm(f.project, { recursive: true });
  await symlink(f.directory, f.project);
  assert.equal(
    (await f.call(`/${files[0].id}/content?revision=0`)).status,
    403,
  );
});

test("verified child execution directories and original parent cwd survive workspace directory changes", async (t) => {
  const f = await fixture(t);
  const childRoot = join(f.directory, "child-worktree");
  await mkdir(childRoot);
  await writeFile(join(childRoot, "child.txt"), "child output");
  await writeFile(join(f.project, "parent.txt"), "parent output");
  f.node.subagents = [
    {
      id: "child",
      agent: "writer",
      task: "report",
      model: "demo/pi-demo",
      status: "completed",
      response: "",
      createdAt: 1,
      workingDirectory: childRoot,
    },
  ];
  f.record("child.txt");
  f.node.toolCalls![0].workingDirectory = childRoot;
  f.node.toolCalls![0].subagentId = "child";
  f.record("parent.txt");
  f.answer("### 交付文件\n- `child.txt`\n- `parent.txt`");
  f.workspace.workingDirectory = join(f.directory, "new-project");
  const files = (await f.call()).json().files as GeneratedFile[];
  assert.equal(files.length, 2);
  assert.ok(files.every((file) => file.status === "available"));
  const native = await f.call(`/${files[0].id}/native?revision=0`, "POST");
  assert.equal(native.json().root, childRoot);
});

test("executable scripts are downloadable and previewable as plain text, while cross-site requests are denied", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.project, "run.sh"), "echo hello");
  f.answer("交付脚本：`run.sh`");
  f.record("run.sh");
  const [file] = (await f.call()).json().files as GeneratedFile[];
  assert.equal(file.nativeOpenable, false);
  assert.equal(file.mediaType, "text/plain; charset=utf-8");
  assert.equal(
    (await f.call("?revision=0", "GET", { origin: "http://evil.example" }))
      .status,
    403,
  );
  assert.equal(
    (
      await f.call(`/${file.id}/content?revision=0`, "GET", {
        "sec-fetch-site": "cross-site",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(`/${file.id}/native?revision=0`, "POST", {
        host: "evil.example",
      })
    ).status,
    403,
  );
});
