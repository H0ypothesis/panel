import { executePiWebJob } from "./pi-web-engine.ts";
import type { PiWebJob } from "./pi-web-access.ts";
import { publicFetch } from "./web-transport.ts";

// This replacement is scoped to the disposable process, never the model server.
globalThis.fetch = publicFetch;
// Stop network/CPU work if the host disappears unexpectedly.
process.once("disconnect", () => process.exit(1));
process.once("message", async (job: PiWebJob) => {
  let reply;
  try {
    reply = { result: await executePiWebJob(job) };
  } catch (error) {
    let message = (
      error instanceof Error ? error.message : String(error)
    ).split("\n\nFallback options:")[0];
    if (process.env.EXA_API_KEY)
      message = message.replaceAll(process.env.EXA_API_KEY, "[redacted]");
    if (process.env.PI_CODING_AGENT_DIR)
      message = message.replaceAll(
        process.env.PI_CODING_AGENT_DIR,
        "[临时配置目录]",
      );
    reply = { error: message.slice(0, 1500) };
  }
  if (process.send) process.send(reply, () => process.exit(0));
  else process.exit(1);
});
