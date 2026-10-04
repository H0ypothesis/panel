import type {
  Api,
  AssistantMessage,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  effortLevels,
  type ThinkingFormat,
  type ThinkingProbeResult,
} from "../shared/provider-settings.ts";
import { setEffort } from "./model-thinking.ts";

type Row = ThinkingProbeResult["rows"][number];
const prompt = "Calculate 17 * 19. Reply with only the number.";

/** Probe the same adapter used by real runs, with no conversation, tools or saved writes. */
export async function probeThinking(
  model: Model<Api>,
  format: ThinkingFormat,
  complete: (options: SimpleStreamOptions) => Promise<AssistantMessage>,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ThinkingProbeResult> {
  const deadline = AbortSignal.timeout(120_000);
  const overall = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
  let requests = 0;
  let blocked = false;
  async function check(option: Row["option"]): Promise<Row> {
    if (overall.aborted || blocked)
      return {
        option,
        status: "inconclusive",
        detail: "未调用：检测已停止或达到时间上限。",
      };
    const timeout = AbortSignal.timeout(20_000);
    const requestSignal = AbortSignal.any([overall, timeout]);
    let status = 0;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(requestSignal.reason);
        requestSignal.addEventListener("abort", onAbort, { once: true });
        if (requestSignal.aborted) onAbort();
      });
      const result = await Promise.race([
        aborted,
        complete({
          signal: requestSignal,
          timeoutMs: 20_000,
          maxTokens: 256,
          maxRetries: 0,
          onPayload(payload) {
            const body = { ...(payload as Record<string, unknown>) };
            delete body.thinking;
            setEffort(body, format, model.api);
            // Also undo SDK reasoning token budgets: every probe has the same hard output cap.
            for (const key of [
              "max_tokens",
              "max_completion_tokens",
              "max_output_tokens",
            ])
              if (key in body) body[key] = 256;
            if (["enabled", "disabled", "invalid-toggle"].includes(option))
              body.thinking = {
                type:
                  option === "invalid-toggle"
                    ? "panel_invalid_probe_value"
                    : option,
              };
            else if (option !== "baseline")
              setEffort(
                body,
                format,
                model.api,
                option === "invalid-effort"
                  ? "panel_invalid_probe_value"
                  : option,
              );
            return body;
          },
          fetch: async (input, init) => {
            if (requests >= 12) throw new Error("Probe request limit");
            requests++;
            const response = await fetcher(input, {
              ...init,
              signal: requestSignal,
              redirect: "error",
            });
            status = response.status;
            // Bound upstream error bodies and streaming content, including untrusted gateways.
            let bytes = 0;
            const body = response.body?.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  bytes += chunk.byteLength;
                  if (bytes > 256 * 1024)
                    throw new Error("Probe response too large");
                  controller.enqueue(chunk);
                },
              }),
            );
            return new Response(body, {
              status,
              statusText: response.statusText,
              headers: response.headers,
            });
          },
        }),
      ]);
      if ([401, 403, 429].includes(status)) blocked = true;
      if (result.stopReason === "error" || result.stopReason === "aborted") {
        return {
          option,
          status: [400, 422].includes(status) ? "rejected" : "inconclusive",
          detail: requestSignal.aborted
            ? "请求超时或已取消，无法判断支持情况。"
            : status
              ? `HTTP ${status}：${[400, 422].includes(status) ? "此参数组合被拒绝。" : "未取得有效模型响应。"}`
              : "连接或认证失败，无法判断支持情况。",
        };
      }
      return {
        option,
        status: "accepted",
        detail: "请求被接受；不代表各档位产生不同的思考强度。",
        observedThinking: result.content.some(
          (part) => part.type === "thinking" && Boolean(part.thinking.trim()),
        ),
      };
    } catch {
      if ([401, 403, 429].includes(status)) blocked = true;
      return {
        option,
        status: "inconclusive",
        detail: "连接失败、超时或响应不完整，无法判断支持情况。",
      };
    } finally {
      if (onAbort) requestSignal.removeEventListener("abort", onAbort);
    }
  }
  const baseline = await check("baseline");
  const rows: Row[] = [baseline];
  if (baseline.status === "accepted") {
    const candidates: Row["option"][] = [
      "enabled",
      "disabled",
      "invalid-toggle",
      ...(format === "none"
        ? []
        : (["invalid-effort", "none", ...effortLevels] as Row["option"][])),
    ];
    const results: Row[] = new Array(candidates.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (next < candidates.length) {
          const index = next++;
          results[index] = await check(candidates[index]);
        }
      }),
    );
    rows.push(...results);
  }
  return { format, checkedAt: Date.now(), requests, rows };
}

export const thinkingProbeContext = {
  messages: [{ role: "user" as const, content: prompt, timestamp: 0 }],
};
