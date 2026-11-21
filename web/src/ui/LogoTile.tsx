import { useEffect, useRef, useState } from "react";
import { poolLogo, providerLogo } from "@/api/logos";
import { cn } from "./cn";
import { useIsSample } from "./Skeleton";

export function ProviderTile({ handle, cacheKey, size = 24, className }: { handle: string; cacheKey?: string; size?: number; className?: string }) {
  return <LogoTile name={handle} src={providerLogo(handle, cacheKey)} size={size} className={className} />;
}

export function PoolTile({ name, cacheKey, size = 24, className }: { name: string; cacheKey?: string; size?: number; className?: string }) {
  return <LogoTile name={name} src={poolLogo(name, cacheKey)} shape="square" size={size} className={className} />;
}

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
  const [failed, setFailed] = useState<string>();
  const letter = (name.trim()[0] ?? "?").toUpperCase();
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
      {showImg ? <Logo src={src} onFail={() => setFailed(src)} /> : letter}
    </span>
  );
}

/** The source is set in an effect: when content replaces a skeleton, Skullet gives every image still loading a shimmering block of its own, reading and writing layout for each. */
function Logo({ src, onFail }: { src: string; onFail: () => void }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.src = src;
  }, [src]);
  return (
    <img
      ref={ref}
      alt=""
      className="size-[64%] object-contain"
      onError={onFail}
      onLoad={(e) => e.currentTarget.naturalWidth === 0 && onFail()}
      draggable={false}
    />
  );
}
