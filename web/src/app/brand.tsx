import { cn } from "@/ui/cn";
import type { HealthState } from "./health";
import { healthLabel } from "./health";

// Brand art is served by Iroha itself from internal/webui/brand.
export const BANNER_SRC = "/brand/iroha-sidebar-banner.jpg";
export const AVATAR_SRC = "/brand/iroha-avatar.png";

/** The Iroha avatar; with `health`, a small dot on it says whether Iroha is ready. */
export function Avatar({ size = 24, health, className }: { size?: number; health?: HealthState; className?: string }) {
  const tone =
    health?.state === "ready" ? "bg-success" : health?.state === "checking" ? "bg-fg-subtle" : health ? "bg-danger-text" : undefined;
  const dot = Math.max(7, Math.round(size * 0.3));
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <img src={AVATAR_SRC} alt="" width={size} height={size} className="rounded-full object-cover" draggable={false} />
      {tone && (
        <span
          role="img"
          aria-label={healthLabel(health!)}
          title={healthLabel(health!)}
          style={{ width: dot, height: dot }}
          className={cn("absolute -bottom-px -right-px rounded-full ring-2 ring-subtle", tone)}
        />
      )}
    </span>
  );
}
