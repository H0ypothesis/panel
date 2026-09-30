import type { ComputerUseScope, ToolCall } from "../shared/types.ts";

export interface CuaPreparedApproval {
  scope?: ComputerUseScope;
  routine: boolean;
  sensitive: boolean;
  reason: string;
  /** Installs a dispatch-time guard. Only the scheduler can supply the live grant. */
  authorizeTask?: (assertActive: () => void) => void;
}
export type CuaSnapshot = {
  scope: ComputerUseScope;
  data: Record<string, unknown>;
};
const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
export function webOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.origin;
  } catch {
    /* An opaque or malformed origin cannot receive a task grant. */
  }
}
export function observedPageUrl(
  data: Record<string, unknown>,
): string | undefined {
  const url = record(data.page)?.url ?? data.url;
  return typeof url === "string" && webOrigin(url) ? url : undefined;
}
export function sameTarget(a: unknown, b: ComputerUseScope["target"]): boolean {
  const t = record(a);
  return (
    !!t &&
    t.kind === b.kind &&
    t.pid === b.pid &&
    t.windowId === b.windowId &&
    (b.kind === "page" ? t.tabId === b.tabId : t.tabId === undefined)
  );
}
const searchName =
  /^(?:search(?:\s+(?:this site|the web|here))?|google search|bing search|搜索|搜尋|站内搜索|搜索内容|搜索关键词|搜索一下|百度一下|查找)$/iu;
const pageName = /^(?:next page|previous page|下一页|上一页|下一頁|上一頁)$/iu;
const sensitiveName =
  /(?:发送|发布|提交|支付|付款|购买|下单|删除|移除|清空|授权|允许访问|修改权限|保存设置|确认订单|转账|执行|运行|安装|上传|send|publish|submit|pay(?:ment)?|purchase|buy|checkout|delete|remove|erase|grant|authorize|permission|transfer|execute|run command|install|upload)/iu;
const sensitiveUrl =
  /(?:^|[\/?&=._-])(?:delete|remove|destroy|erase|logout|signout|unsubscribe|checkout|purchase|payment|pay|transfer|submit|send|publish|execute|install|download|oauth|authorize|redirect|redirect_uri|return_to|callback)(?:$|[\/?&=._-])/iu;
function safeLink(value: unknown, snapshot: CuaSnapshot): string | undefined {
  if (typeof value !== "string" || /[\s\u0000-\u001f]/u.test(value)) return;
  try {
    const url = new URL(value, observedPageUrl(snapshot.data));
    if (
      webOrigin(url.href) !== snapshot.scope.origin ||
      sensitiveUrl.test(decodeURIComponent(url.pathname + url.search)) ||
      /\.(?:exe|dmg|pkg|msi|sh|zip|tar|gz)(?:$|\?)/iu.test(url.pathname)
    )
      return;
    return url.href;
  } catch {
    return;
  }
}
/** 0.30.4 dom_refs_v1 labels are flattened attrs, not escaped structured attrs.
 * Only a sole href (optionally role=link) is unambiguous; never mine an href
 * out of aria-label/value text. semantic_v2 does not expose link destinations. */
function linkOf(element: Record<string, unknown>, snapshot: CuaSnapshot) {
  if (element.frame !== "main") return;
  if (element.node !== "A" && element.node !== "a") return;
  if (typeof element.label !== "string") return;
  const match = /^href=([^\s]+)(?: role=link)?$/u.exec(element.label);
  return match ? safeLink(match[1], snapshot) : undefined;
}
function rows(snapshot: CuaSnapshot): Record<string, unknown>[] {
  const list =
    snapshot.scope.target.kind === "page"
      ? snapshot.data.refs
      : snapshot.data.elements;
  return Array.isArray(list)
    ? list.map(record).filter((v): v is Record<string, unknown> => !!v)
    : [];
}
export function selectedElement(
  args: Record<string, unknown>,
  snapshot: CuaSnapshot,
) {
  const candidates = rows(snapshot).filter((e) => {
    if (snapshot.scope.target.kind === "page")
      return typeof args.ref === "string" && e.ref === args.ref;
    if (
      typeof args.element_token === "string" &&
      e.element_token !== args.element_token
    )
      return false;
    if (
      args.element_index !== undefined &&
      (e.element_index !== args.element_index ||
        args.snapshot_id !== snapshot.data.snapshot_id)
    )
      return false;
    return (
      typeof args.element_token === "string" || args.element_index !== undefined
    );
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}
function identity(e: Record<string, unknown>): string {
  return JSON.stringify([
    e.role,
    e.node,
    e.name,
    e.label,
    e.frame,
    e.in_web_content,
    e.actions,
  ]);
}
export function remapTaskArguments(
  args: Record<string, unknown>,
  before: CuaSnapshot,
  after: CuaSnapshot,
): Record<string, unknown> {
  if (!args.ref && !args.element_token && args.element_index === undefined)
    return { ...args };
  const original = selectedElement(args, before);
  const matches = original
    ? rows(after).filter((e) => identity(e) === identity(original))
    : [];
  if (matches.length !== 1)
    throw new Error("授权目标元素已变化或不唯一，请重新观察并审核。");
  const next = { ...args };
  if (after.scope.target.kind === "page") next.ref = matches[0].ref;
  else {
    delete next.element_index;
    delete next.snapshot_id;
    next.element_token = matches[0].element_token;
    if (typeof next.element_token !== "string")
      throw new Error("新观察缺少有效元素标识，请重新审核。");
  }
  return next;
}
const only = (args: Record<string, unknown>, keys: string[]) =>
  Object.keys(args).every((k) => keys.includes(k));

/** Deterministic fast path based on adapter-owned observation, never model risk claims. */
export function assessCuaTaskAction(
  call: Pick<ToolCall, "name" | "arguments">,
  snapshot?: CuaSnapshot,
): CuaPreparedApproval {
  const result = (
    routine: boolean,
    reason: string,
    sensitive = false,
  ): CuaPreparedApproval => ({
    scope: snapshot?.scope,
    routine,
    sensitive,
    reason,
  });
  if (!snapshot || !sameTarget(call.arguments.target, snapshot.scope.target))
    return result(false, "尚无当前目标的有效观察，按单次操作审核。");
  const tool = call.arguments.tool;
  const args = record(call.arguments.arguments) ?? {};
  if (tool === "browser_dialog" && args.action !== "inspect")
    return result(false, "处理确认对话框需要单次批准。", true);
  const element = selectedElement(args, snapshot);
  const name = String(element?.name ?? element?.label ?? "").trim();
  if (
    ["browser_type", "type_text", "set_value"].includes(String(tool)) &&
    sensitiveName.test(name)
  )
    return result(false, "输入目标涉及重要操作，需要单次审核。");
  if (
    (tool === "browser_click" || tool === "click") &&
    sensitiveName.test(name)
  )
    return result(
      false,
      `重要操作「${name.slice(0, 120)}」需要单次批准。`,
      true,
    );
  if (tool === "browser_navigate") {
    if (!only(args, ["url"])) return result(false, "导航参数超出常规范围。");
    const url = safeLink(args.url, snapshot);
    if (url && rows(snapshot).some((e) => linkOf(e, snapshot) === url))
      return result(true, "本任务已授权网站内、当前观察到的普通链接导航。");
    return result(false, "新网站或无法确认用途的导航，需单次审核。");
  }
  if (!element) return result(false, "坐标、焦点或未知元素操作，需单次审核。");
  if (
    snapshot.data.degraded === true ||
    element.enabled === false ||
    record(element.states)?.disabled === true ||
    element.in_web_content === true ||
    (element.visibility !== undefined &&
      element.visibility !== "in_viewport") ||
    (snapshot.scope.target.kind === "page" && element.frame !== "main")
  )
    return result(false, "元素不可用、不可见或属于未授权的嵌入内容。");
  const role = String(element.role ?? "").toLowerCase();
  // Explicit semantic search roles, or an exact search label on a text field.
  const search =
    role === "searchbox" ||
    role === "axsearchfield" ||
    (["textbox", "combobox", "axtextfield", "axcombobox"].includes(role) &&
      searchName.test(name)) ||
    (["INPUT", "input"].includes(String(element.node)) &&
      element.label === "type=search");
  if (
    tool === "browser_click" &&
    only(args, ["ref", "input_route"]) &&
    (args.input_route === undefined || args.input_route === "trusted")
  ) {
    if (
      search ||
      (role === "button" && (searchName.test(name) || pageName.test(name))) ||
      linkOf(element, snapshot)
    )
      return result(true, "本任务范围内的搜索、翻页或普通链接点击。");
  }
  if (
    (tool === "browser_type" || tool === "type_text" || tool === "set_value") &&
    search
  ) {
    const text = tool === "set_value" ? args.value : args.text;
    const keys =
      tool === "browser_type"
        ? ["ref", "text", "replace", "mode"]
        : [
            "element_token",
            "element_index",
            "snapshot_id",
            "text",
            "value",
            "delivery_mode",
          ];
    if (
      only(args, keys) &&
      typeof text === "string" &&
      text.length <= 2000 &&
      !/[\u0000-\u001f\u007f]/u.test(text) &&
      (args.delivery_mode === undefined ||
        args.delivery_mode === "background") &&
      (args.replace === undefined || typeof args.replace === "boolean") &&
      (args.mode === undefined || args.mode === "insert_text")
    )
      return result(true, "在本任务授权的搜索框内输入查询内容。");
  }
  if (
    tool === "click" &&
    only(args, [
      "element_token",
      "element_index",
      "snapshot_id",
      "button",
      "action",
      "delivery_mode",
    ]) &&
    (args.button === undefined || args.button === "left") &&
    (args.action === undefined || args.action === "press") &&
    (args.delivery_mode === undefined || args.delivery_mode === "background") &&
    (search ||
      (role === "axbutton" && (searchName.test(name) || pageName.test(name))))
  )
    return result(true, "在本任务授权窗口内操作搜索或翻页控件。");
  return result(false, "操作用途不明确或可能提交、修改内容，按单次操作审核。");
}
