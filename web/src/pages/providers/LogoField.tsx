import { useEffect, useId, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { isApiError } from "@/api/client";
import { findLogo } from "@/api/logos";
import { cn } from "@/ui/cn";
import { Input } from "@/ui/Input";
import { LogoTile } from "@/ui/LogoTile";
import { errorText } from "./api";

function useDebounced<T>(v: T, ms = 400): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function LogoInput({
  label,
  name,
  shape,
  value,
  fallback,
  previewUrl,
  onChange,
  placeholder,
  invalid,
}: {
  invalid?: boolean;
  label: string;
  name: string;
  shape?: "round" | "square";
  value: string;
  fallback: string;
  previewUrl: (v: string) => string | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const statusId = useId();
  const target = value.trim() || fallback;
  const shown = useDebounced(target);
  const src = shown ? previewUrl(shown) : undefined;
  const check = useQuery({
    queryKey: ["logo-check", src],
    queryFn: ({ signal }) => findLogo(src!, signal),
    enabled: !!src,
    retry: false,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const pending = target !== shown || (!!src && (check.isPending || check.isPlaceholderData));
  const refused = !pending && !!src && isApiError(check.error) && check.error.status === 400;
  const lastFound = useRef<string | undefined>(undefined);
  if (!pending) lastFound.current = src && check.data === true ? src : undefined;
  const tileKey = lastFound.current ?? "letter";
  const firstTile = useRef(tileKey);
  const fades = useRef(false);
  if (tileKey !== firstTile.current) fades.current = true;

  let text: string;
  if (pending) text = "Looking for a logo…";
  else if (!src) text = "Shows the first letter.";
  else if (refused) text = errorText(check.error);
  else if (check.error) text = `Couldn't look for a logo: ${errorText(check.error)}`;
  else if (check.data) text = `Logo found for ${shown}.`;
  else text = `No logo found for ${shown}. The tile shows a letter.`;

  return (
    <div className="min-w-0 flex-1">
      <div className="relative">
        <span className="absolute left-2 top-1/2 flex -translate-y-1/2">
          <span key={tileKey} data-logo-tile="" className={cn("flex", fades.current && "transition-[opacity,scale] duration-fade ease-out starting:scale-(--motion-scale-popup) starting:opacity-0")}>
            <LogoTile name={name} shape={shape} src={lastFound.current} size={22} />
          </span>
        </span>
        <Input
          aria-label={label}
          aria-describedby={statusId}
          aria-invalid={refused || invalid || undefined}
          mono
          className="pl-10"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <p id={statusId} role="status" aria-live="polite" className={cn("mt-1.5 text-[13px]", refused ? "text-danger-text" : "text-fg-muted")}>
        {text}
      </p>
    </div>
  );
}
