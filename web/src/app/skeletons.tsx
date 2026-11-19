import type { ReactNode } from "react";
import type { SkulletConfig } from "skullet/react";
import { SkulletProvider } from "skullet/react";
import { useTheme } from "./theme";

// Loading states are Skullet skeletons measured from the real content
// (docs/agents/architecture.md, "UI ticket 02"). Colours are Iroha's tokens
// (styles/index.css), so light and dark come from the same place as every
// other colour; the radius is the small corner of chips and bars.
export const SKELETON_THEME: NonNullable<SkulletConfig["theme"]> = {
  light: { base: "var(--bg-muted)", highlight: "var(--skeleton-highlight)" },
  dark: { base: "var(--bg-muted)", highlight: "var(--skeleton-highlight)" },
  radius: "6px",
  animation: "shimmer",
  speed: "slow",
};

/**
 * One Skullet provider at the root. `mode` follows Iroha's theme (the `.dark`
 * class the Owner can set), never the OS. `reveal="smart"` holds a skeleton
 * back for 150 ms, so a fast load shows none.
 */
export function SkeletonRoot({ children }: { children: ReactNode }) {
  const { resolved } = useTheme();
  return (
    <SkulletProvider mode={resolved} theme={SKELETON_THEME} reveal="smart">
      {children}
    </SkulletProvider>
  );
}
