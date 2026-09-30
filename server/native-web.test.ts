import assert from "node:assert/strict";
import { after, before, test, mock } from "node:test";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { createNativeWebHost } from "./native-web-engine.ts";
import {
  createNativeWebSession,
  NATIVE_WEB_CONFIG,
} from "./native-web-session.ts";
import { createWebTools } from "./web-tools.ts";
import {
  nativeWebSchemas,
  validateNativeWebRequest,
} from "./native-web-contract.ts";

let directory: string;
let host: Awaited<ReturnType<typeof createNativeWebHost>>;
const originalEnvironment = { ...process.env };
const savedFetch = globalThis.fetch;
const requests: string[] = [];
const article = `${"The API supports streaming responses. ".repeat(1200)}ARTICLETAIL`;
function pdfFixture(pages = [["Native PDF streaming text"]]) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const lines of pages) {
    const stream = `BT /F1 10 Tf 50 700 Td ${lines
      .map((line) => `(${line.replace(/[\\()]/g, "\\$&")}) Tj 0 -10 Td`)
      .join(" ")} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "panel-native-web-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.TMPDIR = directory;
  delete process.env.EXA_API_KEY;
  await writeFile(
    join(directory, "web-search.json"),
    JSON.stringify(NATIVE_WEB_CONFIG),
  );
  mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  syncBuiltinESMExports();
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    requests.push(url.href);
    if (url.hostname === "mcp.exa.ai") {
      const query = JSON.parse(String(init?.body)).params.arguments.query;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  results: [
                    {
                      title: `Docs for ${query}`,
                      url: "https://example.com/docs",
                      highlights: [
                        query === "long search"
                          ? `${"Search evidence. ".repeat(3000)}SEARCHTAIL`
                          : "The API supports streaming responses.",
                      ],
                    },
                  ],
                }),
              },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    assert.equal(url.hostname, "example.com");
    if (url.pathname.endsWith(".pdf"))
      return new Response(
        new Uint8Array(
          url.pathname === "/long.pdf"
            ? pdfFixture(
                Array.from({ length: 101 }, (_, page) => [
                  ...Array.from(
                    { length: 50 },
                    (_, line) =>
                      `Page ${page + 1} line ${line + 1}: reference evidence.`,
                  ),
                  page === 99
                    ? "PDFTAILRETAINED"
                    : page === 100
                      ? "BEYONDNATIVELIMIT"
                      : "Page end",
                ]),
              )
            : pdfFixture(),
        ),
        {
          headers: { "content-type": "application/pdf" },
        },
      );
    return new Response(
      `<html><head><title>Official API docs</title></head><body><article><h1>API docs</h1><p>${article}</p></article></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  }) as typeof fetch;
  host = await createNativeWebHost();
});
after(async () => {
  await host?.close();
  globalThis.fetch = savedFetch;
  mock.restoreAll();
  syncBuiltinESMExports();
  for (const key of Object.keys(process.env))
    if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  await rm(directory, { recursive: true, force: true });
});

test("Panel research contracts use the actual upstream tool names and parameter names", () => {
  assert.deepEqual(
    [...host.tools.keys()].sort(),
    Object.keys(nativeWebSchemas).sort(),
  );
  for (const [name, schema] of Object.entries(nativeWebSchemas)) {
    const native = host.tools.get(name)!.parameters as {
      properties: Record<string, unknown>;
    };
    for (const property of Object.keys(schema.properties))
      assert.ok(property in native.properties, `${name}.${property}`);
  }
});

test("native batch research searches store full results for subsequent retrieval", async () => {
  const result = await host.execute({
    name: "web_search",
    args: {
      queries: ["streaming reference", "streaming limitations"],
      workflow: "none",
      numResults: 3,
    },
  });
  assert.equal(result.details?.successfulQueries, 2);
  assert.match(result.text, /streaming reference/);
  assert.equal(result.sources[0].url, "https://example.com/docs");
  const before = requests.length;
  const stored = await host.execute({
    name: "get_search_content",
    args: {
      responseId: result.details?.responseId,
      queryIndex: 1,
      findText: "streaming",
    },
  });
  assert.match(stored.text, /streaming/);
  assert.equal(
    requests.length,
    before,
    "cache retrieval must not perform network I/O",
  );
});

test("native fetch supports full cached text, pagination and exact passage lookup", async () => {
  const result = await host.execute({
    name: "fetch_content",
    args: { url: "https://example.com/docs" },
  });
  assert.equal(result.details?.truncated, true);
  assert.doesNotMatch(result.text, /ARTICLETAIL/);
  const id = result.details?.responseId;
  const before = requests.length;
  const tail = await host.execute({
    name: "get_search_content",
    args: {
      responseId: id,
      urlIndex: 0,
      offset: Number(result.details?.totalChars) - 1000,
      limit: 1000,
    },
  });
  assert.match(tail.text, /ARTICLETAIL/);
  const found = await host.execute({
    name: "get_search_content",
    args: {
      responseId: id,
      urlIndex: 0,
      findText: "ARTICLETAIL",
      findMode: "exact",
    },
  });
  assert.match(found.text, /ARTICLETAIL/);
  assert.equal(found.sources[0].url, "https://example.com/docs");
  assert.equal(requests.length, before);
});

test("native source_check preserves exact evidence, hashes and uncertainty", async () => {
  const result = await host.execute({
    name: "source_check",
    args: {
      claim: "The API supports streaming responses.",
      queries: ["streaming reference"],
      fetchContent: true,
    },
  });
  const artifact = result.details?.artifact as {
    passages: { text: string; content_hash: string }[];
    claims: { status: string }[];
  };
  assert.ok(artifact.passages.length > 0);
  assert.match(artifact.passages[0].text, /streaming responses/);
  assert.match(artifact.passages[0].content_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    artifact.claims[0].status,
    "unclear",
    "tool must not fabricate a semantic verdict",
  );
  assert.equal(result.sources[0].url, "https://example.com/docs");
  const cached = await host.execute({
    name: "get_search_content",
    args: { responseId: result.details?.responseId, limit: 1000 },
  });
  assert.match(cached.text, /research/);
});

test("native PDF extraction stores readable text rather than an inaccessible private file path", async () => {
  const result = await host.execute({
    name: "fetch_content",
    args: { url: "https://example.com/paper.pdf" },
  });
  assert.match(result.text, /Native PDF streaming text/);
  assert.doesNotMatch(result.text, /PDF extracted and saved to|pi-web-pdf/);
  const cached = await host.execute({
    name: "get_search_content",
    args: {
      responseId: result.details?.responseId,
      urlIndex: 0,
      findText: "streaming",
    },
  });
  assert.match(cached.text, /streaming/);
  assert.doesNotMatch(cached.text, /pi-web-pdf/);
});

test("includeContent finishes native background fetch before reporting completion", async () => {
  const result = await host.execute({
    name: "web_search",
    args: { query: "streaming", workflow: "none", includeContent: true },
  });
  assert.ok(result.details?.fetchId);
  const cached = await host.execute({
    name: "get_search_content",
    args: {
      responseId: result.details?.fetchId,
      urlIndex: 0,
      findText: "ARTICLETAIL",
    },
  });
  assert.match(cached.text, /ARTICLETAIL/);
});

test("long native PDF text remains retrievable through the plugin page limit", async () => {
  const result = await host.execute({
    name: "fetch_content",
    args: { url: "https://example.com/long.pdf" },
  });
  assert.equal(result.details?.truncated, true);
  assert.ok(Number(result.details?.totalChars) > 100000);
  assert.doesNotMatch(result.text, /PDFTAILRETAINED/);
  const tail = await host.execute({
    name: "get_search_content",
    args: {
      responseId: result.details?.responseId,
      urlIndex: 0,
      offset: Number(result.details?.totalChars) - 1000,
      limit: 1000,
    },
  });
  assert.match(tail.text, /PDFTAILRETAINED/);
  assert.match(tail.text, /Only first 100 of 101 pages extracted/);
  assert.doesNotMatch(tail.text, /BEYONDNATIVELIMIT|pi-web-pdf/);
});

test("long native search summaries retain the omitted content in the native cache", async () => {
  const result = await host.execute({
    name: "web_search",
    args: { query: "long search" },
  });
  assert.equal(result.details?.truncated, true);
  assert.doesNotMatch(result.text, /SEARCHTAIL/);
  const before = requests.length;
  const cached = await host.execute({
    name: "get_search_content",
    args: {
      responseId: result.details?.responseId,
      queryIndex: 0,
      findText: "SEARCHTAIL",
    },
  });
  assert.match(cached.text, /SEARCHTAIL/);
  assert.equal(requests.length, before);
});

test("single query uses the same native search and cache contract as batch queries", async () => {
  const result = await host.execute({
    name: "web_search",
    args: { query: "single search", numResults: 1, recencyFilter: "week" },
  });
  assert.equal(result.details?.successfulQueries, 1);
  assert.equal(result.details?.queryCount, 1);
  assert.equal(result.details?.responseId, result.details?.searchId);
  const cached = await host.execute({
    name: "get_search_content",
    args: { responseId: result.details?.responseId, queryIndex: 0 },
  });
  assert.match(cached.text, /streaming/);
});

test("invalid, conflicting or unsupported parameters fail before native execution", () => {
  for (const args of [
    { query: "test", queries: ["test"] },
    { query: "test", count: 3, numResults: 5 },
    { query: "test", freshness: "pd", recencyFilter: "year" },
    { query: "test", workflow: "auto-summary" },
    { query: "test", proxy: "http://localhost" },
  ])
    assert.throws(() => validateNativeWebRequest({ name: "web_search", args }));
  for (const url of [
    "file:///etc/passwd",
    "http://127.0.0.1",
    "https://user:secret@example.com",
  ])
    assert.throws(() =>
      validateNativeWebRequest({ name: "fetch_content", args: { url } }),
    );
  assert.deepEqual(
    validateNativeWebRequest({
      name: "web_search",
      args: { queries: ["q"], numResults: 4, recencyFilter: "month" },
    }),
    { queries: ["q"], numResults: 4, recencyFilter: "month" },
  );
});

test("real isolated workers initialize the plugin, reject foreign IDs and clean up", async () => {
  const before = await readdir(directory);
  const first = createNativeWebSession();
  const second = createNativeWebSession();
  const foreign = await host.execute({
    name: "web_search",
    args: { query: "foreign cache", workflow: "none" },
  });
  try {
    await assert.rejects(
      first.run({
        name: "get_search_content",
        args: { responseId: foreign.details?.responseId },
      }),
      /Not found/,
    );
    await assert.rejects(
      second.run({
        name: "get_search_content",
        args: { responseId: foreign.details?.responseId },
      }),
      /Not found/,
    );
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
  assert.deepEqual(await readdir(directory), before);
});

test("cancelled native calls terminate the worker and release its cache", async () => {
  const before = await readdir(directory);
  const session = createNativeWebSession();
  const controller = new AbortController();
  const pending = session.run(
    { name: "get_search_content", args: { responseId: "unused" } },
    controller.signal,
  );
  const timer = setTimeout(
    () => controller.abort(new Error("Test cancellation")),
    20,
  );
  try {
    await assert.rejects(pending, /cancellation/);
  } finally {
    clearTimeout(timer);
    await session.close();
  }
  assert.deepEqual(await readdir(directory), before);
});

test("web tools preserve native details and source links without a workspace", async () => {
  const tools = createWebTools({
    runNativePlugin: (request, signal) => host.execute(request, signal),
  });
  try {
    const result = await tools
      .find((tool) => tool.name === "source_check")!
      .execute("evidence", { claim: "Streaming API", fetchContent: false });
    assert.ok(result.details.responseId);
    assert.equal(result.details.sources[0].url, "https://example.com/docs");
  } finally {
    await tools.close();
  }
});
