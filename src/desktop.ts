export type DesktopAction = "new-workspace" | "search";

export interface PanelDesktop {
  readonly platform: "macos";
  chooseDirectory: () => Promise<string | null>;
  openSettings: () => Promise<unknown>;
  openDataDirectory: () => Promise<unknown>;
}

declare global {
  interface Window {
    panelDesktop?: PanelDesktop;
  }
}

export function getDesktopBridge(): PanelDesktop | null {
  return window.panelDesktop?.platform === "macos" ? window.panelDesktop : null;
}

export function onDesktopAction(handle: (action: DesktopAction) => void) {
  if (!getDesktopBridge()) return () => {};
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const action = event.detail?.action;
    if (action === "new-workspace" || action === "search") handle(action);
  };
  window.addEventListener("panel:native-action", listener);
  return () => window.removeEventListener("panel:native-action", listener);
}
