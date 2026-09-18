import type { ApprovalMode } from "../shared/types.ts";
import type { Runtime } from "./runtime.ts";

export function validateApprovalSettings(
  runtime: Runtime,
  mode: ApprovalMode,
  safetyModel?: string,
) {
  if (mode !== "auto") return;
  if (!safetyModel) throw new Error("请先选择安全模型，再启用自动审批。");
  const model = runtime.models().find((item) => item.id === safetyModel);
  if (!model || model.demo || !model.available)
    throw new Error("安全模型必须是已配置且可用的真实模型，不能使用演示模型。");
}
