import { useState } from "react";
import { cn } from "./cn";

/**
 * A logo in a tile: round for Providers, rounded square for Model Pools,
 * so a Pool never looks like a Provider. When there is no logo, or it fails
 * to load, the tile shows the name's first letter (C25 "Logo fallback").
 * `src` must be a URL served by Iroha (logos are never hot-linked).
 */
export function LogoTile({
  name,
  src,
  shape = "round",
  size = 28,
  className,
}: {
  name: string;
  src?: string | null;
  shape?: "round" | "square";
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  const showImg = src && !failed;
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center overflow-hidden border border-border bg-bg font-semibold text-fg-muted",
        shape === "round" ? "rounded-full" : "rounded-[28%]",
        className,
      )}
    >
      {showImg ? (
        <img src={src} alt="" className="size-[64%] object-contain" onError={() => setFailed(true)} draggable={false} />
      ) : (
        letter
      )}
    </span>
  );
}
