import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useIsDarkMode } from "@/hooks/use-dark-mode"

/**
 * shadcn generates this component reading the theme from `next-themes`, which
 * Iroha does not use: `use-theme` writes the `dark` class onto <html> itself.
 * Resolving the mode from that class keeps a toast in step with the Owner's
 * preference, including a live OS switch, without a second theme provider.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const dark = useIsDarkMode()

  return (
    <Sonner
      theme={dark ? "dark" : "light"}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
