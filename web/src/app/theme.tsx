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

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const resolved = pref === "system" ? (systemDark ? "dark" : "light") : pref;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

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
