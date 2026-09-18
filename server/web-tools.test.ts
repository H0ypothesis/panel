import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import test from "node:test";
import type { PiWebJob, PiWebResult, PiWebRunner } from "./pi-web-access.ts";
import { createWebTools, webCapabilities } from "./web-tools.ts";

const page: PiWebResult = {
  text: "Verified webpage body",
  sources: [{ title: "Example article", url: "https://example.com/article" }],
};

function fixture(result: PiWebResult = page, run?: PiWebRunner) {
  const jobs: PiWebJob[] = [];
  const tools = createWebTools({
    async runPlugin(job, signal) {
      jobs.push(structuredClone(job));
      return run ? run(job, signal) : result;
    },
  });
  const tool = (name = "web_fetch") => {
    const found = tools.find((entry) => entry.name === name);
    assert.ok(found);
    return found;
  };
  return { jobs, tools, tool };
}

function text(result: AgentToolResult<unknown>) {
  return result.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

test("Pi Web search and fetch remain available without provider credentials", () => {
  const exaKey = process.env.EXA_API_KEY;
  const braveKey = process.env.BRAVE_API_KEY;
  delete process.env.EXA_API_KEY;
  delete process.env.BRAVE_API_KEY;
  try {
    assert.deepEqual(
      fixture().tools.map((tool) => tool.name),
      ["web_search", "web_fetch"],
    );
    const capabilities = webCapabilities();
    assert.equal(capabilities.webSearch, true);
    assert.equal(capabilities.webFetch, true);
    assert.equal(capabilities.searchProvider, "Exa MCP");
    assert.equal(capabilities.searchKeyRequired, false);
    assert.equal(capabilities.pdfRead, true);
    assert.equal(capabilities.plugin, "pi-web-access");
  } finally {
    if (exaKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = exaKey;
    if (braveKey === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = braveKey;
  }
});

test("search and PDF fetch forward the approved inputs to the correct plugin jobs", async () => {
  const { tool, jobs } = fixture();
  await tool("web_search").execute("default-search", {
    query: "agentic papers",
  });
  await tool("web_search").execute("filtered-search", {
    query: "recent papers",
    count: 10,
    freshness: "pw",
  });
  const result = await tool().execute("pdf", {
    url: "https://example.com/paper.pdf",
  });
  assert.deepEqual(jobs, [
    { kind: "search", query: "agentic papers", count: 5 },
    { kind: "search", query: "recent papers", count: 10, freshness: "pw" },
    { kind: "fetch", url: "https://example.com/paper.pdf" },
  ]);
  assert.match(text(result), /外部来源/);
  assert.match(text(result), /不可信指令/);
  assert.match(text(result), /Verified webpage body/);
  assert.deepEqual(result.details.sources, page.sources);
  assert.equal(result.details.truncated, undefined);
});

test("invalid search inputs fail before entering the plugin", async () => {
  const { tool, jobs } = fixture();
  for (const args of [
    {},
    { query: null },
    { query: 123 },
    { query: "" },
    { query: "   " },
    { query: "q".repeat(2001) },
    { query: "test", count: 0 },
    { query: "test", count: 11 },
    { query: "test", count: 1.5 },
    { query: "test", count: NaN },
    { query: "test", count: "5" },
    { query: "test", freshness: "" },
    { query: "test", freshness: "today" },
  ])
    await assert.rejects(tool("web_search").execute("search", args));
  assert.equal(jobs.length, 0);
});

test("invalid or nonpublic fetch URLs fail before entering the plugin", async () => {
  const { tool, jobs } = fixture();
  for (const url of [
    null,
    123,
    "",
    "not a URL",
    `https://example.com/${"a".repeat(8192)}`,
    "file:///etc/passwd",
    "ftp://example.com/file",
    "https://user:password@example.com/",
    "http://localhost/",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
  ])
    await assert.rejects(tool().execute("fetch", { url }));
  assert.equal(jobs.length, 0);
});

test("source metadata filters unsafe links and preserves complete valid URLs", async () => {
  const longUrl = `https://example.com/${"a".repeat(8100)}`;
  const { tool } = fixture({
    text: "Extracted content",
    sources: [
      { title: "Unsafe script", url: "javascript:alert(1)" },
      { title: "Private file", url: "file:///etc/passwd" },
      { title: "Private host", url: "http://127.0.0.1/" },
      { title: "Embedded credential", url: "https://user:secret@example.com/" },
      { title: "T".repeat(600), url: longUrl },
      { title: "Canonical URL", url: "https://EXAMPLE.COM/article#fragment" },
    ],
  });
  const result = await tool().execute("fetch", {
    url: "https://example.com/article",
  });
  assert.deepEqual(result.details.sources, [
    { title: "T".repeat(500), url: longUrl },
    { title: "Canonical URL", url: "https://example.com/article" },
  ]);
});

test("large plugin output has a bounded visible result and source list", async () => {
  const { tool } = fixture({
    text: "x".repeat(25_000),
    sources: Array.from({ length: 25 }, (_, index) => ({
      title: `Source ${index}`,
      url: `https://example.com/${index}`,
    })),
  });
  const result = await tool().execute("fetch", {
    url: "https://example.com/article",
  });
  assert.ok(text(result).length <= 16_000);
  assert.match(text(result), /内容已截断/);
  assert.equal(result.details.truncated, true);
  assert.equal(result.details.sources.length, 20);
  assert.deepEqual(result.details.sources[19], {
    title: "Source 19",
    url: "https://example.com/19",
  });
});

test("already cancelled web actions never enter the plugin", async () => {
  const { tool, jobs } = fixture();
  const controller = new AbortController();
  const reason = new Error("User cancelled");
  controller.abort(reason);
  await assert.rejects(
    tool().execute(
      "fetch",
      { url: "https://example.com/article" },
      controller.signal,
    ),
    (error) => error === reason,
  );
  await assert.rejects(
    tool("web_search").execute("search", { query: "test" }, controller.signal),
    (error) => error === reason,
  );
  assert.equal(jobs.length, 0);
});

test("cancellation propagates to the plugin and discards a late successful result", async () => {
  let resolveResult!: (result: PiWebResult) => void;
  let receivedSignal: AbortSignal | undefined;
  const { tool, jobs } = fixture(page, async (_job, signal) => {
    receivedSignal = signal;
    return new Promise((resolve) => {
      resolveResult = resolve;
    });
  });
  const controller = new AbortController();
  const pending = tool().execute(
    "fetch",
    { url: "https://example.com/article" },
    controller.signal,
  );
  assert.equal(jobs.length, 1);
  assert.equal(receivedSignal, controller.signal);
  const reason = new Error("User cancelled");
  controller.abort(reason);
  resolveResult(page);
  await assert.rejects(pending, (error) => error === reason);
});

test("plugin failures reject the tool instead of fabricating successful output", async () => {
  const reason = new Error("Plugin unavailable");
  const { tool } = fixture(page, async () => {
    throw reason;
  });
  await assert.rejects(
    tool().execute("fetch", { url: "https://example.com/article" }),
    (error) => error === reason,
  );
});
