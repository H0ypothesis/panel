import assert from "node:assert/strict";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import {
  createSubagentHandoff,
  subagentNoticeMessage,
} from "./subagent-handoff.ts";

const full = `# Research report\n${"verified evidence\n".repeat(2000)}END OF REPORT`;
const result = (text = full): Message => ({
  role: "toolResult",
  toolCallId: "delegate",
  toolName: "subagent",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 1,
});
const signal = () => new AbortController().signal;

test("long results are saved intact and summarized only in model input, once per result", async () => {
  const saved: { path: string; text: string }[] = [];
  let summaries = 0;
  const project = createSubagentHandoff({
    cwd: "/workspace",
    save: async (path, text) => {
      saved.push({ path, text });
    },
    summarize: async () => {
      summaries++;
      return "Key finding, evidence and unresolved issue.";
    },
  });
  const raw = [result()];
  const projected = await project(raw, signal());
  assert.equal(saved[0].text, full);
  assert.match(
    saved[0].path,
    /^\/workspace\/\.pi\/subagents\/handoffs\/.+\.md$/,
  );
  assert.match(JSON.stringify(projected), /Key finding/);
  assert.match(JSON.stringify(projected), /文件路径/);
  assert.doesNotMatch(JSON.stringify(projected), /END OF REPORT/);
  assert.deepEqual(raw, [result()]);
  assert.deepEqual(await project(raw, signal()), projected);
  assert.equal(saved.length, 1);
  assert.equal(summaries, 1);
});

test("host-marked background reports use handoff projection and keep raw notices intact", async () => {
  const saved: string[] = [];
  const project = createSubagentHandoff({
    cwd: "/workspace",
    save: async (_path, text) => {
      saved.push(text);
    },
    summarize: async () => "COMPLETED_AND_FAILED_CHILDREN_SUMMARY",
  });
  const notice = subagentNoticeMessage(full);
  const ordinaryUser: Message = { role: "user", content: full, timestamp: 1 };
  const raw = [notice, ordinaryUser];
  const projected = await project(raw, signal());
  assert.deepEqual(saved, [full]);
  assert.equal(notice.content, full);
  assert.equal(projected[0].role, "user");
  assert.match(
    JSON.stringify(projected[0]),
    /COMPLETED_AND_FAILED_CHILDREN_SUMMARY/,
  );
  assert.match(JSON.stringify(projected[0]), /文件路径/);
  assert.doesNotMatch(JSON.stringify(projected[0]), /END OF REPORT/);
  assert.deepEqual(projected[1], ordinaryUser);
  assert.deepEqual(await project(raw, signal()), projected);
  assert.equal(saved.length, 1);
});

test("short results, failures and explicit guide requests retain their original contents", async () => {
  const project = createSubagentHandoff({
    cwd: "/workspace",
    save: async () => {
      throw new Error("must not save");
    },
    summarize: async () => {
      throw new Error("must not summarize");
    },
  });
  const failure = { ...result(), isError: true };
  const raw = [
    result("short"),
    failure,
    fauxAssistantMessage(
      fauxToolCall("subagent", { action: "guide" }, { id: "delegate" }),
    ),
    result(),
  ];
  assert.deepEqual(await project(raw, signal()), raw);
});

test("save denial preserves the original result and does not retry or summarize", async () => {
  let saves = 0;
  const project = createSubagentHandoff({
    cwd: "/workspace",
    save: async () => {
      saves++;
      throw new Error("denied");
    },
    summarize: async () => {
      throw new Error("must not summarize");
    },
  });
  const raw = [result()];
  assert.deepEqual(await project(raw, signal()), raw);
  assert.deepEqual(await project(raw, signal()), raw);
  assert.equal(saves, 1);
});

test("summary failure still returns a real file and clearly labelled excerpt", async () => {
  let persisted = false;
  const project = createSubagentHandoff({
    cwd: "/workspace",
    save: async () => {
      persisted = true;
    },
    summarize: async () => {
      throw new Error("length");
    },
  });
  const projected = await project([result()], signal());
  assert.equal(persisted, true);
  assert.match(JSON.stringify(projected), /不是完整结论/);
  assert.match(JSON.stringify(projected), /文件路径/);
});

test("cancellation is not converted into a successful handoff", async () => {
  const controller = new AbortController();
  const project = createSubagentHandoff({
    cwd: "/workspace",
    save: async () => {
      controller.abort();
      throw controller.signal.reason;
    },
    summarize: async () => "unexpected",
  });
  await assert.rejects(project([result()], controller.signal), {
    name: "AbortError",
  });
});
