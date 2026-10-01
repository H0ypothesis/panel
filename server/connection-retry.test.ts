import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  normalizeContext,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { withConnectionRetries } from "./connection-retry.ts";
import type { ConnectionRetry } from "../shared/types.ts";

const provider = fauxProvider({
  provider: "openai",
  models: [{ id: "retry" }],
});
const registry = createModels();
registry.setProvider(provider.provider);
const model = registry.getModel("openai", "retry")!;
const failure = (errorMessage = "Connect error") =>
  fauxAssistantMessage("", { stopReason: "error", errorMessage });

function errorStream(errorMessage?: string) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "error", reason: "error", error: failure(errorMessage) });
  return stream;
}

test("connection errors retry exactly five times before surfacing the final error", async () => {
  let calls = 0;
  const retries: (ConnectionRetry | undefined)[] = [];
  const stream = await withConnectionRetries(
    () => {
      calls++;
      return errorStream();
    },
    { baseDelayMs: 0, onRetry: (retry) => retries.push(retry) },
  )(model, normalizeContext({ messages: [] }));
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  assert.equal(calls, 6);
  assert.deepEqual(
    retries.filter(Boolean).map((retry) => retry!.attempt),
    [1, 2, 3, 4, 5],
  );
  assert.ok(retries.filter(Boolean).every((retry) => retry!.maxAttempts === 5));
  assert.equal(retries.at(-1), undefined);
  assert.equal(events.length, 1);
  assert.equal((await stream.result()).stopReason, "error");
  assert.match(
    (await stream.result()).errorMessage!,
    /已自动重连 5 次.*Connect error/,
  );
});

test("a synchronous network exception is retried with unchanged context and request options", async () => {
  const context = normalizeContext({ messages: [] });
  const options = { maxTokens: 123, signal: new AbortController().signal };
  let calls = 0;
  const stream = await withConnectionRetries(
    (_model, receivedContext, receivedOptions) => {
      assert.equal(receivedContext, context);
      assert.equal(receivedOptions, options);
      if (++calls === 1) throw new Error("fetch failed");
      const result = createAssistantMessageEventStream();
      result.push({
        type: "done",
        reason: "stop",
        message: fauxAssistantMessage("Recovered"),
      });
      return result;
    },
    { baseDelayMs: 0 },
  )(model, context, options);
  assert.equal((await stream.result()).stopReason, "stop");
  assert.equal(calls, 2);
});

test("authentication, quota, context and request validation errors fail immediately", async () => {
  for (const error of [
    "Invalid API key",
    "401 Unauthorized",
    "429 insufficient_quota",
    "maximum context length exceeded",
    "输入上下文超限：maximum context length exceeded: 500 tokens",
    "服务端输出参数限制：max_tokens exceeds 500",
    "400 invalid request",
  ]) {
    let calls = 0;
    const stream = await withConnectionRetries(
      () => {
        calls++;
        return errorStream(error);
      },
      { baseDelayMs: 0 },
    )(model, normalizeContext({ messages: [] }));
    assert.equal((await stream.result()).errorMessage, error);
    assert.equal(calls, 1, error);
  }
});

test("cancellation during backoff stops without sending another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const retries: (ConnectionRetry | undefined)[] = [];
  const stream = await withConnectionRetries(
    () => {
      calls++;
      return errorStream("ECONNRESET");
    },
    {
      onRetry: (retry) => {
        retries.push(retry);
        if (retry) controller.abort();
      },
    },
  )(model, normalizeContext({ messages: [] }), { signal: controller.signal });
  assert.equal((await stream.result()).stopReason, "aborted");
  assert.equal(calls, 1);
  assert.equal(retries.at(-1), undefined);
});

test("an already cancelled request does not call the provider", async () => {
  const stream = await withConnectionRetries(() => {
    assert.fail("Cancelled provider request was sent");
  })(model, normalizeContext({ messages: [] }), {
    signal: AbortSignal.abort(),
  });
  assert.equal((await stream.result()).stopReason, "aborted");
});
