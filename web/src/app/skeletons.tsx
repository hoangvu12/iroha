import type { ReactNode } from "react";
import type { RevealContext, RevealSpec } from "skullet";
import { smart, together } from "skullet";
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
 * Content of more pieces than this crossfades whole when it replaces its
 * skeleton (UI ticket 26). Skullet's in-sequence reveal reads each piece's box
 * between the animations it starts, so every piece forces a style and layout
 * pass: on a 100-row table that alone was ~0.6 s of a 1-2 s task at 4x CPU, and
 * the sweep froze for all of it. A crossfade is two opacity animations,
 * composited. 60 pieces is about six table rows or a sheet's facts.
 */
export const SEQUENCE_PIECES = 60;

/** Skullet's `smart` choice, except that content of many pieces crossfades whole instead of coming in piece by piece. */
export function revealFor(context: RevealContext): RevealSpec {
  const chosen = smart.choose!(context);
  return typeof chosen.order === "function" && context.pieces > SEQUENCE_PIECES ? together : chosen;
}

/** `smart` (a skeleton held back 150 ms, at once for a fast load, a quick crossfade for a refetch) with `revealFor`'s rule for big content. */
export const SKELETON_REVEAL: RevealSpec = { ...smart, choose: revealFor };

/**
 * One Skullet provider at the root. `mode` follows Iroha's theme (the `.dark`
 * class the Owner can set), never the OS. The reveal holds a skeleton back for
 * 150 ms, so a fast load shows none.
 */
export function SkeletonRoot({ children }: { children: ReactNode }) {
  const { resolved } = useTheme();
  return (
    <SkulletProvider mode={resolved} theme={SKELETON_THEME} reveal={SKELETON_REVEAL}>
      {children}
    </SkulletProvider>
  );
}
