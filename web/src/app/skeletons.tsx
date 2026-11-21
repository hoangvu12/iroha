import type { ReactNode } from "react";
import type { RevealContext, RevealSpec } from "skullet";
import { smart, together } from "skullet";
import type { SkulletConfig } from "skullet/react";
import { SkulletProvider } from "skullet/react";
import { useTheme } from "./theme";

export const SKELETON_THEME: NonNullable<SkulletConfig["theme"]> = {
  light: { base: "var(--bg-muted)", highlight: "var(--skeleton-highlight)" },
  dark: { base: "var(--bg-muted)", highlight: "var(--skeleton-highlight)" },
  radius: "6px",
  animation: "shimmer",
  speed: "slow",
};

export const SEQUENCE_PIECES = 60;

export function revealFor(context: RevealContext): RevealSpec {
  const chosen = smart.choose!(context);
  return typeof chosen.order === "function" && context.pieces > SEQUENCE_PIECES ? together : chosen;
}

export const SKELETON_REVEAL: RevealSpec = { ...smart, choose: revealFor };

export function SkeletonRoot({ children }: { children: ReactNode }) {
  const { resolved } = useTheme();
  return (
    <SkulletProvider mode={resolved} theme={SKELETON_THEME} reveal={SKELETON_REVEAL}>
      {children}
    </SkulletProvider>
  );
}
