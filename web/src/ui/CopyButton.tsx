import type { ComponentType } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { announce } from "@ui-sdk/core";
import { Check, CircleAlert, Copy } from "lucide-react";
import { Button, IconButton } from "./Button";
import { writeClipboard } from "./clipboard";
import { cn } from "./cn";
import { durationOf, easingOf } from "./motion";

export const COPIED_MS = 1500;
const FAILED_MS = 4000;

export type CopyState = "copied" | "failed" | undefined;

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

export function copyIcon(state: CopyState, idle: Icon): Icon {
  if (state === "copied") return CopiedIcon;
  if (state === "failed") return FailedIcon;
  return idle;
}

const swapIn = "transition-[scale,opacity] duration-fade ease-out starting:scale-(--motion-scale-popup) starting:opacity-0";

function CopiedIcon({ size, className }: { size?: number; className?: string }) {
  return <Check size={size} aria-hidden className={cn("text-success", swapIn, className)} />;
}

function FailedIcon({ size, className }: { size?: number; className?: string }) {
  return <CircleAlert size={size} aria-hidden className={cn("text-danger-text", swapIn, className)} />;
}

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
  glyph?: Icon;
  children?: string;
  size?: "sm" | "md";
  variant?: "secondary" | "ghost";
  bordered?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { state, copy } = useCopy();
  const text = state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : children;
  const slide = useSlidingLabel(text);
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
        className={cn("data-[copy]:opacity-100", className)}
        onClick={press}
      />
    );

  return (
    <Button
      size={size}
      variant={variant}
      icon={copyIcon(state, glyph)}
      disabled={disabled}
      aria-label={name}
      data-copy={state}
      className={className}
      onClick={(e) => {
        slide.remember();
        press(e);
      }}
    >
      <span ref={slide.outer} className="inline-block overflow-hidden">
        <span ref={slide.inner} className="inline-block">
          {text}
        </span>
      </span>
    </Button>
  );
}

function useSlidingLabel(text: string) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const last = useRef(0);
  const remember = useCallback(() => {
    if (inner.current) last.current = inner.current.getBoundingClientRect().width;
  }, []);

  useLayoutEffect(() => {
    const el = outer.current;
    let from = last.current;
    remember();
    const to = last.current;
    if (!el || typeof el.animate !== "function") return;
    const running = el.getAnimations();
    if (running.length) {
      from = el.getBoundingClientRect().width;
      running.forEach((a) => a.cancel());
    }
    if (!from || !to || from === to || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const duration = durationOf("--duration-indicator");
    if (duration) el.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration, easing: easingOf("--ease-out") });
  }, [text, remember]);

  return { outer, inner, remember };
}
