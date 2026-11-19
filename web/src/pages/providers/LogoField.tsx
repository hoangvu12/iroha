import { useEffect, useId, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { isApiError } from "@/api/client";
import { findLogo } from "@/api/logos";
import { cn } from "@/ui/cn";
import { Input } from "@/ui/Input";
import { LogoTile } from "@/ui/LogoTile";
import { errorText } from "./api";

/** Debounced value, for previews that fetch. */
function useDebounced<T>(v: T, ms = 400): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/**
 * The Logo field of the Provider and Pool Settings tabs: the input with the
 * logo it finds in a tile, looked up as you type (debounced), and a line
 * under it saying whether one was found, before anything is saved.
 * `fallback` is what an empty field stands for (the guessed domain or
 * maker); `previewUrl` gives the lookup URL for a value, or undefined when
 * the value asks for the letter (a Provider's "none").
 */
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
  /** Saving it failed (the error shows under the row). */
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
  // The tile keeps the last logo found while the next one is looked up.
  const lastFound = useRef<string | undefined>(undefined);
  if (!pending) lastFound.current = src && check.data === true ? src : undefined;

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
        <span className="absolute left-2 top-1/2 -translate-y-1/2">
          <LogoTile name={name} shape={shape} src={lastFound.current} size={22} />
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
