import { useEffect, useLayoutEffect, useState } from "react";
import { readPreference, savePreference } from "./api";
import { getDesktopBridge } from "./desktop";

export type ThemePreference = "light" | "dark" | "system";

export const THEME_PALETTES = [
  { id: "green", label: "苔绿" },
  { id: "mono", label: "黑白" },
  { id: "blue", label: "海蓝" },
  { id: "violet", label: "鸢紫" },
  { id: "sand", label: "暖砂" },
] as const;
export type ThemePalette = (typeof THEME_PALETTES)[number]["id"];

function readThemePreference(): ThemePreference {
  const saved = readPreference("theme");
  return saved === "light" || saved === "dark" ? saved : "system";
}

function readPalettePreference(): ThemePalette {
  const saved = readPreference("palette");
  return THEME_PALETTES.find((palette) => palette.id === saved)?.id ?? "green";
}

export function useTheme() {
  const [preference, setPreference] = useState(readThemePreference);
  const [palette, setPalette] = useState(readPalettePreference);
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
      if (event.key === "panel:palette" || event.key === null) {
        setPalette(readPalettePreference());
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = colorMode;
    document.documentElement.dataset.palette = palette;
    document.documentElement.style.colorScheme = colorMode;
    document.documentElement.style.backgroundColor = "var(--page-background)";
    const background = getComputedStyle(document.documentElement)
      .getPropertyValue("--page-background")
      .trim();
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", background);
  }, [colorMode, palette]);

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

  const changePalette = (next: ThemePalette) => {
    setPalette(next);
    savePreference("palette", next);
  };

  return { preference, palette, colorMode, changeTheme, changePalette };
}
