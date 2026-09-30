import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantResponse } from "./AssistantResponse";
import { subagentMarkdownComponents } from "./SubagentOutput";

const receipt = {
  criteriaSatisfied: [{ id: "criterion-1", status: "satisfied" }],
  changedFiles: ["report.md"],
  diffSummary: "已整理调研报告",
  residualRisks: ["有两个来源尚未核实"],
  validationOutput: ["internal-command-log"],
};
const report = `# 报告\n\n正文\n\n\`\`\`acceptance-report\n${JSON.stringify(receipt)}\n\`\`\``;
test("native acceptance reports become readable handoffs while their caveats remain visible", () => {
  const html = renderToStaticMarkup(
    <AssistantResponse
      response={report}
      status="completed"
      markdownComponents={subagentMarkdownComponents}
    />,
  );
  assert.match(html, /<h1>报告<\/h1>/);
  assert.match(html, /子代理交付说明/);
  assert.match(html, /report.md/);
  assert.match(html, /<details[^>]*open=""/);
  assert.match(html, /有两个来源尚未核实/);
  assert.doesNotMatch(html, /criteriaSatisfied|internal-command-log/);
  const conversation = renderToStaticMarkup(
    <AssistantResponse response={report} status="completed" />,
  );
  assert.match(conversation, /criteriaSatisfied/);
});
test("ordinary JSON, nested examples and incomplete native reports stay literal", () => {
  for (const response of [
    report.replace("acceptance-report", "json"),
    '```acceptance-report\n{"incomplete":',
    '```acceptance-report\n{"example":true}\n```',
    `\`\`\`\`text\n${report}\n\`\`\`\``,
  ]) {
    const html = renderToStaticMarkup(
      <AssistantResponse
        response={response}
        status="running"
        markdownComponents={subagentMarkdownComponents}
      />,
    );
    assert.doesNotMatch(html, /子代理交付说明/);
    assert.match(html, /<pre>/);
  }
});
