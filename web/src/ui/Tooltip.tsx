import type { ReactElement } from "react";
import { Tooltip as SdkTooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { cn } from "./cn";

export const tooltipClass = cn(
  "max-w-72 whitespace-pre-line rounded-md bg-primary px-2 py-1 text-[12.5px] font-medium leading-snug text-primary-fg shadow-elevated",
  "origin-(--transform-origin) transition-[opacity,scale] duration-100 data-starting-style:scale-96 data-starting-style:opacity-0",
  "data-ending-style:opacity-0 data-instant:transition-none motion-reduce:transition-none",
);

// `children` is the trigger and must forward props and ref. The tip names a
// trigger that has no name of its own (an icon button) and describes any other.
export function Tip({
  label,
  children,
  side = "top",
  type,
}: {
  label: string;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  type?: "label" | "description";
}) {
  return (
    <SdkTooltip type={type}>
      <TooltipTrigger render={children} />
      {/* The tip's text already names or describes the trigger; an agent sees it there, not twice. */}
      <TooltipContent data-agent-hidden side={side} sideOffset={6} collisionPadding={8} className={tooltipClass}>
        {label}
      </TooltipContent>
    </SdkTooltip>
  );
}
