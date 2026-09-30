import { publicFetch } from "./web-transport.ts";
import { createNativeWebHost } from "./native-web-engine.ts";
import type { NativeWebRequest } from "./native-web-contract.ts";

globalThis.fetch = publicFetch;
process.once("disconnect", () => process.exit(1));
const host = createNativeWebHost();
process.on(
  "message",
  async (message: { id: string; request: NativeWebRequest }) => {
    try {
      const result = await (await host).execute(message.request);
      process.send?.({ id: message.id, result });
    } catch (cause) {
      let error = cause instanceof Error ? cause.message : String(cause);
      for (const value of [
        process.env.EXA_API_KEY,
        process.env.PI_CODING_AGENT_DIR,
      ])
        if (value) error = error.replaceAll(value, "[redacted]");
      process.send?.({ id: message.id, error: error.slice(0, 2000) });
    }
  },
);
// Report import/init failures through the request rather than unhandled rejection.
void host.catch(() => {});
