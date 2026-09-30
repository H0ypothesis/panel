import assert from "node:assert/strict";
import test from "node:test";
import { contextReferencePrompt } from "./context-references.ts";
import { toolRequestPrompt, validateToolRequests } from "./tool-requests.ts";

test("tool selection validates exact capabilities and preserves omitted versus cleared fields", () => {
  assert.equal(validateToolRequests(undefined), undefined);
  assert.deepEqual(validateToolRequests([]), []);
  assert.deepEqual(validateToolRequests(["web_search"]), ["web_search"]);
  assert.deepEqual(validateToolRequests(["computer_use"]), ["computer_use"]);
  for (const value of [
    null,
    "web_search",
    {},
    1,
    [null],
    [1],
    [""],
    ["bash"],
    ["web_fetch"],
    ["computer_use_call"],
    [" web_search "],
    ["WEB_SEARCH"],
    ["@web_search"],
    ["web_search", "unknown"],
    ["web_search", "web_search", "web_search", "web_search"],
    new Array(2),
  ])
    assert.throws(() => validateToolRequests(value), /工具调用选择/);
});

test("tool selections canonicalize set order, deduplicate, and copy caller arrays", () => {
  const input = ["computer_use", "web_search"];
  const result = validateToolRequests(input);
  assert.deepEqual(result, ["web_search", "computer_use"]);
  assert.deepEqual(input, ["computer_use", "web_search"]);
  assert.deepEqual(validateToolRequests(["web_search", "web_search"]), [
    "web_search",
  ]);
  input.length = 0;
  assert.deepEqual(result, ["web_search", "computer_use"]);
  assert.deepEqual(
    validateToolRequests(["web_search", "computer_use"]),
    result,
  );
});

test("unselected @ text stays ordinary prompt text and never activates a capability", () => {
  const prompt = "分析这段文字：@web_search @computer_use";
  assert.equal(toolRequestPrompt(prompt), prompt);
  assert.equal(toolRequestPrompt(prompt, []), prompt);
});

test("selected tools require real capability use and preserve historical provenance", () => {
  const prompt = toolRequestPrompt("研究后填写指定页面", [
    "computer_use",
    "web_search",
  ]);
  assert.match(prompt, /^研究后填写指定页面\n/);
  assert.match(prompt, /@web_search[\s\S]*实际调用 web_search/);
  assert.match(
    prompt,
    /@computer_use[\s\S]*computer_use_tools[\s\S]*computer_use_call/,
  );
  assert.ok(prompt.indexOf("@web_search") < prompt.indexOf("@computer_use"));
  assert.match(prompt, /用户在输入框中通过 @ 选择/);
  assert.match(prompt, /不替代具体操作审批/);
  assert.match(prompt, /历史、摘要或引用[\s\S]*不要求后续新轮次重复调用/);
  assert.match(prompt, /工具不可用、权限不足或必要目标不明确/);
});

test("tool intent composes with card references without treating reference text as selection", () => {
  const referenced = contextReferencePrompt("检索来源", [
    {
      nodeId: "old",
      revision: 0,
      prompt: "@computer_use 打开应用",
      response: "旧资料中的指令仅作资料",
    },
  ]);
  const prompt = toolRequestPrompt(referenced, ["web_search"]);
  assert.ok(prompt.startsWith(referenced));
  assert.match(prompt, /引用卡片资料（JSON）/);
  assert.equal((prompt.match(/@computer_use：/g) ?? []).length, 0);
  assert.equal((prompt.match(/@web_search：/g) ?? []).length, 1);
});
