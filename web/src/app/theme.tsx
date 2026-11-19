import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { useMediaQuery } from "@/lib/media";

// Light and dark use the same tokens (src/styles/index.css). The Owner's
// choice is kept in this browser; "system" follows the OS. index.html
// applies it before the first paint.

export type ThemePref = "system" | "light" | "dark";
const KEY = "iroha.theme";

type Ctx = { pref: ThemePref; resolved: "light" | "dark"; setPref: (p: ThemePref) => void };
const ThemeContext = createContext<Ctx>({ pref: "system", resolved: "light", setPref: () => {} });

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** The page background (--bg) of each theme: the phone's browser bar takes it (theme-color in index.html). */
const BAR_COLOUR = { light: "#ffffff", dark: "#0e0e10" } as const;

/**
 * Flips the colours in one step. Hover-coloured parts have a colour
 * transition, so without this they fade 150 ms behind the rest of the page.
 * `theme-switching` (styles/index.css) turns every transition off; the
 * forced style read applies the new colours with it on, and it comes off
 * once a frame has been drawn in the new colours.
 */
function applyTheme(resolved: "light" | "dark") {
  const html = document.documentElement;
  html.classList.add("theme-switching");
  html.classList.toggle("dark", resolved === "dark");
  html.style.colorScheme = resolved;
  for (const meta of document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = BAR_COLOUR[resolved];
  void getComputedStyle(html).color;
  cancelAnimationFrame(restoreFrame);
  restoreFrame = requestAnimationFrame(() => {
    restoreFrame = requestAnimationFrame(() => html.classList.remove("theme-switching"));
  });
}
let restoreFrame = 0;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const resolved = pref === "system" ? (systemDark ? "dark" : "light") : pref;

  useEffect(() => applyTheme(resolved), [resolved]);

  const setPref = (p: ThemePref) => {
    setPrefState(p);
    try {
      if (p === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, p);
    } catch {
      /* private mode: the choice lasts this visit */
    }
  };

  return <ThemeContext.Provider value={{ pref, resolved, setPref }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
