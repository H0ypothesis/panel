import type { ToolCall } from "../shared/types";

const labels: Record<string, string> = {
  status: "检查电脑控制",
  tools: "查看电脑控制能力",
  call: "操作电脑",
  list_apps: "查看应用",
  list_windows: "查看窗口",
  get_app_state: "查看应用界面",
  get_window_state: "查看窗口界面",
  verify_state: "验证界面变化",
  screenshot: "截取画面",
  get_screenshot: "截取画面",
  take_screenshot: "截取画面",
  click: "点击界面",
  double_click: "双击界面",
  right_click: "右键点击",
  drag: "拖动界面",
  scroll: "滚动界面",
  type_text: "输入文字",
  set_value: "设置界面内容",
  zoom: "缩放界面",
  keypress: "按下按键",
  press_key: "按下按键",
  hotkey: "执行快捷键",
  launch_app: "打开应用",
  activate_app: "切换应用",
  focus_window: "切换窗口",
  bring_to_front: "将窗口置前",
  set_window_frame: "调整窗口位置",
  close_window: "关闭窗口",
  browser_list_tabs: "查看浏览器页面",
  browser_list_pages: "查看浏览器页面",
  browser_navigate: "打开网页",
  browser_prepare: "准备浏览器",
  get_browser_state: "查看网页界面",
  browser_click: "点击网页",
  browser_type: "输入网页内容",
  browser_dialog: "处理网页对话框",
  browser_pointer: "移动网页光标",
  browser_evaluate: "执行页面脚本",
  browser_screenshot: "截取网页",
  browser_get_page_state: "查看网页界面",
  release: "释放操作目标",
  release_target: "释放操作目标",
  check_permissions: "检查系统权限",
  health_report: "检查驱动状态",
  get_screen_size: "查看屏幕尺寸",
  get_cursor_position: "查看光标位置",
};

export function isComputerUseCall(call: Pick<ToolCall, "name">): boolean {
  return call.name.startsWith("computer_use_");
}

export function computerUseLabel(
  call: Pick<ToolCall, "name" | "arguments">,
): string {
  const operation = (
    call.name === "computer_use_call" && typeof call.arguments.tool === "string"
      ? call.arguments.tool
      : call.name
  ).replace(/^computer_use_/, "");
  return labels[operation] ?? `电脑操作 · ${operation.replaceAll("_", " ")}`;
}

export function toolWaitLabel(call: ToolCall): string {
  if (!isComputerUseCall(call))
    return call.name === "bash" ? "等待文件操作" : "等待文件";
  return call.computerUse?.scope === "page"
    ? "等待页面"
    : call.computerUse?.scope === "window"
      ? "等待窗口"
      : "等待桌面";
}

export function computerUseTargetLabel(call: ToolCall): string | undefined {
  const target = call.computerUse;
  if (target?.targetLabel) return target.targetLabel;
  const details = [
    target?.app,
    target?.windowId !== undefined ? `窗口 ${target.windowId}` : undefined,
    target?.pageId !== undefined ? `页面 ${target.pageId}` : undefined,
  ].filter(Boolean);
  return details.length
    ? details.join(" · ")
    : target?.scope === "desktop"
      ? "当前桌面"
      : undefined;
}

/** Persisted tool images are served by Panel, never by a tool-supplied origin. */
export function toolImageUrl(value: string): string | null {
  if (!value.startsWith("/api/") || value.includes("\\")) return null;
  try {
    const url = new URL(value, "https://panel.invalid");
    return url.origin === "https://panel.invalid" &&
      /^\/api\/workspaces\/[^/]+\/nodes\/[^/]+\/tool-images\/[^/]+\/\d+$/.test(
        url.pathname,
      ) &&
      /^\?revision=\d+$/.test(url.search) &&
      !url.hash
      ? `${url.pathname}${url.search}`
      : null;
  } catch {
    return null;
  }
}
