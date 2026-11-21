import type { ReactElement } from "react";
import { Tooltip as SdkTooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { cn } from "./cn";

export const tooltipClass = cn(
  "max-w-72 whitespace-pre-line rounded-md bg-primary px-2 py-1 text-[12.5px] font-medium leading-snug text-primary-fg shadow-elevated",
  "origin-(--transform-origin) transition-[opacity,scale] duration-tooltip ease-out data-instant:duration-0",
  "data-starting-style:scale-(--motion-scale-popup) data-starting-style:opacity-0",
  "data-ending-style:scale-(--motion-scale-popup) data-ending-style:opacity-0",
);

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
      <TooltipContent data-agent-hidden side={side} sideOffset={6} collisionPadding={8} className={tooltipClass}>
        {label}
      </TooltipContent>
    </SdkTooltip>
  );
}
