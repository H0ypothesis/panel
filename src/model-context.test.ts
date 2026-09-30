import assert from "node:assert/strict";
import test from "node:test";
import { modelContextLabel, modelContextTitle } from "./model-context";
import type { ModelOption } from "../shared/types";

test("unknown limits are labeled as fallback budgets while configured limits retain their provenance", () => {
  const model = {
    contextWindow: 128000,
    contextWindowSource: "fallback",
  } as ModelOption;
  assert.equal(modelContextLabel(model), "预算 128K");
  assert.match(modelContextTitle(model), /模型上限未知.*128,000/);
  const configured = {
    ...model,
    contextWindow: 1000000,
    contextWindowSource: "configured" as const,
  };
  assert.equal(modelContextLabel(configured), "配置 1M");
  assert.match(modelContextTitle(configured), /已配置上下文预算：1,000,000/);
  assert.equal(
    modelContextLabel({ ...model, contextWindowSource: "builtin" }),
    "128K",
  );
  assert.equal(modelContextLabel(undefined), "未知");
});
