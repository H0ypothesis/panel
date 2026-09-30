import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { FileCheck2, FileText } from "lucide-react";
import type { Components } from "react-markdown";

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && !!item.trim(),
      )
    : [];
}

// Interpret only the plugin's explicit report fence. Ordinary JSON and malformed
// reports remain readable code; original stored/copyable output is untouched.
export const subagentMarkdownComponents: Components = {
  pre({ children, node: _node, ...props }) {
    const child = Children.toArray(children)[0];
    if (isValidElement(child)) {
      const code = child as ReactElement<{
        className?: string;
        children?: ReactNode;
      }>;
      if (
        code.props.className === "language-acceptance-report" &&
        typeof code.props.children === "string"
      ) {
        try {
          const report = JSON.parse(code.props.children);
          if (
            report &&
            typeof report === "object" &&
            Array.isArray(report.criteriaSatisfied) &&
            Array.isArray(report.changedFiles)
          ) {
            const files = strings(report.changedFiles);
            const risks = strings(report.residualRisks);
            const summary =
              typeof report.diffSummary === "string" ? report.diffSummary : "";
            // Keep reports containing no presentable information as their original code.
            if (files.length || risks.length || summary)
              return (
                <aside
                  className="subagent-delivery"
                  aria-label="子代理交付说明"
                >
                  <div className="subagent-delivery-heading">
                    <FileCheck2 size={14} />
                    <strong>交付说明</strong>
                    <span>由子代理提供</span>
                  </div>
                  {summary && <p>{summary}</p>}
                  {files.length > 0 && (
                    <ul className="subagent-delivery-files">
                      {files.map((file, index) => (
                        <li key={index}>
                          <FileText size={13} />
                          <code>{file}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                  {risks.length > 0 && (
                    <details className="subagent-delivery-notes" open>
                      <summary>需要注意 · {risks.length}</summary>
                      <ul>
                        {risks.map((risk, index) => (
                          <li key={index}>{risk}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </aside>
              );
          }
        } catch {
          /* Partial or invalid structured output remains literal. */
        }
      }
    }
    return <pre {...props}>{children}</pre>;
  },
};
