import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnNode } from "../shared/types";
import {
  cardReferenceQuery,
  cardReferenceTitle,
  filterCardReferences,
  insertCardReference,
  filterToolRequests,
  insertToolRequest,
} from "./card-reference-input";

const completed = (id: string, prompt: string, response = ""): TurnNode => ({
  id,
  prompt,
  response,
  status: "completed",
  parentId: null,
  position: { x: 0, y: 0 },
  createdAt: 1,
  contextIds: [],
  config: { model: "demo/pi-demo", thinking: "off" },
  color: "sage",
});

test("tool choices remain independent from card matches and support Chinese and English queries", () => {
  assert.deepEqual(
    filterToolRequests("").map((item) => item.id),
    ["web_search", "computer_use", "subagents"],
  );
  assert.deepEqual(
    filterToolRequests("联网").map((item) => item.id),
    ["web_search"],
  );
  assert.deepEqual(
    filterToolRequests("WEB search").map((item) => item.id),
    ["web_search"],
  );
  assert.deepEqual(
    filterToolRequests("窗口").map((item) => item.id),
    ["computer_use"],
  );
  assert.deepEqual(
    filterToolRequests("cua").map((item) => item.id),
    ["computer_use"],
  );
  assert.deepEqual(filterToolRequests("不存在"), []);
  const namedLikeTool = completed("card-web", "联网搜索");
  assert.deepEqual(filterCardReferences([namedLikeTool], "联网"), [
    namedLikeTool,
  ]);
  assert.equal(
    insertCardReference(
      "@联网",
      { start: 0, end: 3, text: "联网" },
      namedLikeTool,
    ).value,
    "@「联网搜索」 ",
  );
});

test("tool selection removes only the active query, does not create card tokens and deduplicates chips", () => {
  const value = "请查找 @联网 并总结";
  const query = cardReferenceQuery(value, 7)!;
  const selected = insertToolRequest(value, query, "web_search", []);
  assert.deepEqual(selected, {
    value: "请查找  并总结",
    caret: 4,
    toolRequests: ["web_search"],
  });
  assert.doesNotMatch(selected.value, /@|「|」/);
  assert.deepEqual(
    insertToolRequest(value, query, "web_search", ["web_search"]).toolRequests,
    ["web_search"],
  );
  assert.deepEqual(
    insertToolRequest(value, query, "computer_use", ["web_search"])
      .toolRequests,
    ["web_search", "computer_use"],
  );
  assert.equal(cardReferenceQuery(selected.value, selected.caret), null);
});

test("finds a Chinese mention at the caret without consuming later draft text", () => {
  assert.deepEqual(cardReferenceQuery("请参考@数据库 后面的文字", 7), {
    start: 3,
    end: 7,
    text: "数据库",
  });
  assert.deepEqual(cardReferenceQuery("@React API", 10), {
    start: 0,
    end: 10,
    text: "React API",
  });
});

test("does not interpret email, completed labels, multiline text or selection as a query", () => {
  for (const value of [
    "user@example.com",
    "@「完成的卡片」 接着写",
    "@搜索\n另起一行",
  ]) {
    assert.equal(cardReferenceQuery(value, value.length), null);
  }
  assert.equal(cardReferenceQuery("参考@", 2, 3), null);
  assert.equal(cardReferenceQuery("plain text", 10), null);
});

test("matches prompt and response words case-insensitively and excludes unavailable cards", () => {
  const react = completed("react", "React 设计", "包含 Context API");
  const database = completed("db", "数据库", "索引配置");
  const candidates = [
    react,
    database,
    { ...react, id: "pending", status: "running" as const },
    { ...react, id: "stale", contextStale: true },
    react,
  ];
  assert.deepEqual(
    filterCardReferences(candidates, "react api").map((node) => node.id),
    ["react"],
  );
  assert.deepEqual(
    filterCardReferences(candidates, "索引").map((node) => node.id),
    ["db"],
  );
  assert.deepEqual(
    filterCardReferences(candidates, "").map((node) => node.id),
    ["react", "db"],
  );
  assert.deepEqual(filterCardReferences(candidates, "不存在"), []);
});

test("insertion replaces only the active mention and places the caret after its readable label", () => {
  const value = "参考 @API 的设计";
  const node = completed("secret-technical-id", "  API\n设计  ");
  const query = cardReferenceQuery(value, 7);
  assert.ok(query);
  const inserted = insertCardReference(value, query, node);
  assert.equal(inserted.value, "参考 @「API 设计」  的设计");
  assert.equal(inserted.value.slice(0, inserted.caret), "参考 @「API 设计」 ");
  assert.equal(inserted.value.includes(node.id), false);
  assert.equal(cardReferenceQuery(inserted.value, inserted.caret), null);
});

test("labels have a useful fallback and bounded text for narrow cards", () => {
  assert.equal(cardReferenceTitle({ prompt: " \n " }), "无文字问题");
  assert.equal(
    cardReferenceTitle({ prompt: "字".repeat(100) }),
    `${"字".repeat(42)}…`,
  );
});
