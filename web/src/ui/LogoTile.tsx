import { useState } from "react";
import { poolLogo, providerLogo } from "@/api/logos";
import { cn } from "./cn";
import { useIsSample } from "./Skeleton";

/**
 * A Provider's logo (round), served by Iroha; the handle's first letter when
 * it has none. The one helper every page uses for Provider logos.
 * `version` is the Provider's logo_domain when the caller knows it, so a
 * change shows at once.
 */
export function ProviderTile({ handle, version, size = 24, className }: { handle: string; version?: string; size?: number; className?: string }) {
  return <LogoTile name={handle} src={providerLogo(handle, version)} size={size} className={className} />;
}

/** A Model Pool's logo (rounded square): its model maker's; the name's first letter when it has none. `version` is the Pool's maker. */
export function PoolTile({ name, version, size = 24, className }: { name: string; version?: string; size?: number; className?: string }) {
  return <LogoTile name={name} src={poolLogo(name, version)} shape="square" size={size} className={className} />;
}

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
  // The src that failed, so a new src (another logo domain) is tried again.
  const [failed, setFailed] = useState<string>();
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  // A skeleton's sample draws the tile as one block and fetches no logo.
  const showImg = src && failed !== src && !useIsSample();
  return (
    <span
      aria-hidden="true"
      skullet-block=""
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center overflow-hidden border border-border bg-bg font-semibold text-fg-muted",
        shape === "round" ? "rounded-full" : "rounded-[28%]",
        className,
      )}
    >
      {showImg ? (
        <img
          src={src}
          alt=""
          className="size-[64%] object-contain"
          onError={() => setFailed(src)}
          onLoad={(e) => e.currentTarget.naturalWidth === 0 && setFailed(src)}
          draggable={false}
        />
      ) : (
        letter
      )}
    </span>
  );
}
