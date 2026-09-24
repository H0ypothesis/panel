import { useEffect, useLayoutEffect, useState } from "react";
import { readPreference, savePreference } from "./api";
import { getDesktopBridge } from "./desktop";

export type ThemePreference = "light" | "dark" | "system";

function readThemePreference(): ThemePreference {
  const saved = readPreference("theme");
  return saved === "light" || saved === "dark" ? saved : "system";
}

export function useTheme() {
  const [preference, setPreference] = useState(readThemePreference);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const colorMode =
    preference === "system" ? (systemDark ? "dark" : "light") : preference;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === "panel:theme" || event.key === null) {
        setPreference(readThemePreference());
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = colorMode;
    document.documentElement.style.colorScheme = colorMode;
    const background = colorMode === "dark" ? "#151b18" : "#f5f6f3";
    document.documentElement.style.backgroundColor = background;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", background);
  }, [colorMode]);

  useEffect(() => {
    // Pass the preference, so following macOS never pins its resolved appearance.
    void getDesktopBridge()
      ?.setAppearance?.(preference)
      .catch(() => {});
  }, [preference]);

  const changeTheme = (next: ThemePreference) => {
    setPreference(next);
    savePreference("theme", next);
  };

  return { preference, colorMode, changeTheme };
}
