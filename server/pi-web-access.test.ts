import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PI_WEB_CONFIG, piWebEnvironment, runPiWeb } from "./pi-web-access.ts";
import { executePiWebJob } from "./pi-web-engine.ts";

const savedFetch = globalThis.fetch;
const originalEnvironment = { ...process.env };
let directory: string;
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "panel-web-engine-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.TMPDIR = directory;
  delete process.env.EXA_API_KEY;
  await writeFile(
    join(directory, "web-search.json"),
    JSON.stringify(PI_WEB_CONFIG),
  );
});
after(async () => {
  globalThis.fetch = savedFetch;
  for (const key of Object.keys(process.env))
    if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  await rm(directory, { recursive: true, force: true });
});

test("actual plugin Exa MCP parser handles search without keys and sends exact query", async () => {
  const query = "pi web access";
  const requests: URL[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(url.origin, "https://mcp.exa.ai");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.params.arguments.query, query);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: "Title: Pi Web Access\nURL: https://github.com/nicobailon/pi-web-access\nText: Existing search extension for Pi.\n",
            },
          ],
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const result = await executePiWebJob({ kind: "search", query, count: 2 });
  assert.ok(requests.length > 0);
  assert.equal(
    result.sources[0].url,
    "https://github.com/nicobailon/pi-web-access",
  );
  assert.match(result.text, /Pi Web Access/);
});

test("search keeps full plugin highlights and titles beyond Panel's former limits", async () => {
  const title = `${"Long source title ".repeat(40)}TITLE_TAIL`;
  const highlights = `${"A useful source highlight. ".repeat(600)}HIGHLIGHT_TAIL`;
  globalThis.fetch = (async () =>
    new Response(
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
                    title,
                    url: "https://example.com/source",
                    highlights: [highlights],
                  },
                ],
              }),
            },
          ],
        },
      }),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  const result = await executePiWebJob({
    kind: "search",
    query: "complete highlights",
    count: 1,
  });
  assert.equal(result.sources[0].title, title);
  assert.ok(result.text.includes(highlights));
  assert.ok(
    result.text.endsWith(`Source: ${title} (https://example.com/source)`),
  );
});

test("actual plugin reads HTML without scripts or cloud extraction", async () => {
  let requests = 0;
  globalThis.fetch = (async (input) => {
    assert.equal(String(input), "https://example.com/article");
    requests++;
    return new Response(
      `<html><head><title>Public article</title></head><body><article><h1>Public article</h1><p>${"Readable content from the original page. ".repeat(40)}</p><script>UNTRUSTED_SCRIPT()</script></article></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  }) as typeof fetch;
  const result = await executePiWebJob(
    { kind: "fetch", url: "https://example.com/article" },
    undefined,
    lookup,
  );
  assert.match(result.text, /Readable content/);
  assert.doesNotMatch(result.text, /UNTRUSTED_SCRIPT/);
  assert.equal(requests, 1);
});

test("HTML keeps the plugin's full title and text beyond Panel's former limits", async () => {
  const title = `${"Long article title ".repeat(40)}TITLE_TAIL`;
  const content = `${"可读的网页内容，保留完整段落。".repeat(5000)}正文尾部保留`;
  globalThis.fetch = (async () =>
    new Response(
      `<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${content}</p></article></body></html>`,
      { headers: { "content-type": "text/html" } },
    )) as typeof fetch;
  const result = await executePiWebJob(
    { kind: "fetch", url: "https://example.com/long-article" },
    undefined,
    lookup,
  );
  assert.equal(result.sources[0].title, title);
  assert.ok(result.text.includes(content));
  assert.ok(result.text.endsWith("正文尾部保留"));
  assert.doesNotMatch(result.text, /正文已截断/);
});

test("short plugin HTML results retain useful text without unsupported fallback instructions", async () => {
  globalThis.fetch = (async () =>
    new Response(
      "<html><head><title>Example</title></head><body><article><h1>Example</h1><p>This small page contains useful text.</p></article></body></html>",
      { headers: { "content-type": "text/html" } },
    )) as typeof fetch;
  const result = await executePiWebJob(
    { kind: "fetch", url: "https://example.com/short" },
    undefined,
    lookup,
  );
  assert.match(result.text, /useful text/);
  assert.match(result.text, /可能不完整/);
  assert.doesNotMatch(result.text, /Fallback options|GEMINI_API_KEY/);
});

function pdfFixture(pages = [["Panel PDF extraction works"]]) {
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

test("actual plugin PDF extraction returns text instead of an ephemeral file link", async () => {
  let requests = 0;
  globalThis.fetch = (async (input) => {
    assert.equal(String(input), "https://example.com/paper.pdf");
    requests++;
    return new Response(new Uint8Array(pdfFixture()), {
      headers: { "content-type": "application/pdf" },
    });
  }) as typeof fetch;
  const result = await executePiWebJob(
    { kind: "fetch", url: "https://example.com/paper.pdf" },
    undefined,
    lookup,
  );
  assert.match(result.text, /Panel PDF extraction works/);
  assert.match(result.text, /原始 PDF 尚未保存/);
  assert.doesNotMatch(result.text, /pi-web-pdf|PDF extracted and saved to/);
  assert.equal(requests, 1, "PDF contents never leave the local parser");
});

test("PDF cache is read in full, including the plugin's native page-limit notice", async () => {
  const pages = Array.from({ length: 101 }, (_, page) =>
    Array.from(
      { length: 50 },
      (_, line) =>
        `Page ${page + 1} line ${line + 1}: ${"Complete readable PDF text. ".repeat(2)}`,
    ),
  );
  pages[99].push("PDF_TEXT_TAIL_RETAINED");
  pages[100].push("BEYOND_NATIVE_PAGE_LIMIT");
  const pdf = pdfFixture(pages);
  globalThis.fetch = (async () =>
    new Response(new Uint8Array(pdf), {
      headers: { "content-type": "application/pdf" },
    })) as typeof fetch;
  const result = await executePiWebJob(
    { kind: "fetch", url: "https://example.com/long-paper.pdf" },
    undefined,
    lookup,
  );
  assert.ok(result.text.length > 240_004, "exceeds the old PDF read buffer");
  assert.match(result.text, /PDF_TEXT_TAIL_RETAINED/);
  assert.ok(
    result.text.endsWith(
      "*[Truncated: Only first 100 of 101 pages extracted]*",
    ),
  );
  assert.doesNotMatch(result.text, /BEYOND_NATIVE_PAGE_LIMIT|正文已截断/);
});

test("plugin process environment excludes provider keys, browser cookies and inherited config", () => {
  process.env.EXA_API_KEY = "exa-test-key";
  process.env.GEMINI_API_KEY = "private-model-key";
  process.env.PI_ALLOW_BROWSER_COOKIES = "1";
  process.env.NODE_OPTIONS = "--inspect";
  process.env.HTTPS_PROXY = "http://proxy.invalid";
  const search = piWebEnvironment(directory, {
    kind: "search",
    query: "test",
    count: 1,
  });
  const fetch = piWebEnvironment(directory, {
    kind: "fetch",
    url: "https://example.com",
  });
  assert.equal(search.EXA_API_KEY, "exa-test-key");
  assert.equal(fetch.EXA_API_KEY, undefined);
  for (const key of [
    "GEMINI_API_KEY",
    "PI_ALLOW_BROWSER_COOKIES",
    "NODE_OPTIONS",
    "HTTPS_PROXY",
  ])
    assert.equal(search[key], undefined);
  assert.equal(search.HOME, directory);
  assert.equal(search.PI_CODING_AGENT_DIR, directory);
  delete process.env.EXA_API_KEY;
});

test("real worker rejects nonpublic targets and removes invocation files", async () => {
  const beforeFiles = await readdir(directory);
  await assert.rejects(
    runPiWeb({ kind: "fetch", url: "http://127.0.0.1/private" }),
    /公共互联网/,
  );
  assert.deepEqual(await readdir(directory), beforeFiles);
});

test("cancellation terminates a running worker and removes invocation files", async () => {
  const beforeFiles = await readdir(directory);
  const controller = new AbortController();
  const running = runPiWeb(
    { kind: "search", query: "cancelled request", count: 1 },
    controller.signal,
  );
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(running, /取消|abort/i);
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(await readdir(directory), beforeFiles);
});
