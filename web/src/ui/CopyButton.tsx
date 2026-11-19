import type { ComponentType } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { announce } from "@ui-sdk/core";
import { Check, CircleAlert, Copy } from "lucide-react";
import { Button, IconButton } from "./Button";
import { writeClipboard } from "./clipboard";
import { cn } from "./cn";

// Copying shows its result on the button that copied (spec: "Results show
// where they happened"): the icon and label turn into "Copied" for a moment,
// and a screen reader hears "<what> copied". No toast.

/** How long "Copied" stays on the button. */
export const COPIED_MS = 1500;
const FAILED_MS = 4000;

export type CopyState = "copied" | "failed" | undefined;

/**
 * Copy with feedback: `state` is "copied" (or "failed") for a moment after
 * `copy`, and the result is announced. For controls other than CopyButton,
 * such as a menu trigger whose menu item copied.
 */
export function useCopy() {
  const [state, setState] = useState<CopyState>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async (text: string, what: string) => {
    clearTimeout(timer.current);
    try {
      await writeClipboard(text);
      setState("copied");
      announce(`${what} copied`);
      timer.current = setTimeout(() => setState(undefined), COPIED_MS);
      return true;
    } catch (e) {
      setState("failed");
      const why = e instanceof Error && e.message ? `: ${e.message}` : "";
      announce(`Couldn't copy the ${what}${why}`, { priority: "assertive" });
      timer.current = setTimeout(() => setState(undefined), FAILED_MS);
      return false;
    }
  }, []);

  return { state, copy };
}

type Icon = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;

/** The icon of a control showing a copy's result, crossfaded in. */
export function copyIcon(state: CopyState, idle: Icon): Icon {
  if (state === "copied") return CopiedIcon;
  if (state === "failed") return FailedIcon;
  return idle;
}

// A short crossfade on the motion tokens; a plain fade under reduced motion (the scale token is 1 there).
const swapIn = "transition-[scale,opacity] duration-fade ease-out starting:scale-(--motion-scale-popup) starting:opacity-0";

function CopiedIcon({ size, className }: { size?: number; className?: string }) {
  return <Check size={size} aria-hidden className={cn("text-success", swapIn, className)} />;
}

function FailedIcon({ size, className }: { size?: number; className?: string }) {
  return <CircleAlert size={size} aria-hidden className={cn("text-danger-text", swapIn, className)} />;
}

/**
 * The one copy button. `what` names the value ("Gateway Key", "Base URL"):
 * the default label is "Copy the <what>" and the announcement "<what> copied".
 * `icon` makes it an icon button named by its tooltip, which says "Copied"
 * after a copy. A press never reaches a clickable row around it.
 */
export function CopyButton({
  value,
  what,
  label,
  icon,
  glyph = Copy,
  children = "Copy",
  size = "sm",
  variant = "secondary",
  bordered,
  disabled,
  className,
}: {
  value: string | (() => string);
  what: string;
  label?: string;
  icon?: boolean;
  /** The icon shown before a copy (Copy by default). */
  glyph?: Icon;
  children?: string;
  size?: "sm" | "md";
  variant?: "secondary" | "ghost";
  bordered?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { state, copy } = useCopy();
  const name = label ?? `Copy the ${what}`;
  const press = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    void copy(typeof value === "function" ? value() : value, what);
  };

  if (icon)
    return (
      <IconButton
        icon={copyIcon(state, glyph)}
        label={state === "copied" ? "Copied" : state === "failed" ? `Couldn't copy the ${what}` : name}
        size={size}
        bordered={bordered}
        disabled={disabled}
        data-copy={state}
        // A button shown on row hover stays visible while it shows the result.
        className={cn("data-[copy]:opacity-100", className)}
        onClick={press}
      />
    );

  const text = state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : children;
  return (
    <Button size={size} variant={variant} icon={copyIcon(state, glyph)} disabled={disabled} aria-label={name} data-copy={state} className={className} onClick={press}>
      {/* Keeps the width of "Copied" so the button doesn't jump when it changes. */}
      <span data-reserve="Copied" className="grid justify-items-start after:invisible after:col-start-1 after:row-start-1 after:content-[attr(data-reserve)]">
        <span className="col-start-1 row-start-1">{text}</span>
      </span>
    </Button>
  );
}
