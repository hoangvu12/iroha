import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Link } from "react-router";
import { Tabs as Root, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import { cn } from "./cn";
import { ScrollArea } from "./ScrollArea";

type Variant = "underline" | "segmented";
const VariantContext = createContext<Variant>("underline");

/** UI SDK Tabs root: `value` + `onValueChange`, or a value from the URL (see RouteTabs). */
export function Tabs(props: ComponentProps<typeof Root>) {
  return <Root {...props} />;
}

/**
 * The row of tabs. `underline` (page sections) scrolls sideways on narrow
 * screens with no visible bar and fades at the edge that continues;
 * `segmented` is the pill switch (Request views, Captured sides). Both
 * slide an indicator to the selected tab.
 */
export function TabList({ label, variant = "underline", className, children }: { label: string; variant?: Variant; className?: string; children: ReactNode }) {
  if (variant === "segmented")
    return (
      <VariantContext.Provider value="segmented">
        <TabsList aria-label={label} className={cn("relative inline-flex rounded-lg bg-muted p-1", className)}>
          <TabsIndicator className="absolute left-0 top-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) translate-y-(--active-tab-top) rounded-md bg-bg shadow-sm transition-[translate,width] duration-indicator ease-out data-[activation-direction=none]:transition-none" />
          {children}
        </TabsList>
      </VariantContext.Provider>
    );
  return (
    <VariantContext.Provider value="underline">
      <ScrollArea axis="x" bars={false} className={cn("shadow-[inset_0_-1px_0_var(--border)]", className)}>
        <TabsList aria-label={label} className="relative flex w-max min-w-full gap-6">
          {children}
          <TabsIndicator className="absolute bottom-0 left-0 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) bg-fg transition-[translate,width] duration-indicator ease-out data-[activation-direction=none]:transition-none" />
        </TabsList>
      </ScrollArea>
    </VariantContext.Provider>
  );
}

const tabClass: Record<Variant, string> = {
  underline:
    "whitespace-nowrap pb-2.5 text-[15px] text-fg-muted transition-colors duration-hover ease-[ease] hover:text-fg data-selected:text-fg focus-visible:-outline-offset-2",
  segmented:
    "relative flex h-8 flex-1 items-center justify-center whitespace-nowrap rounded-md px-4 text-[14.5px] text-fg-muted transition-colors duration-hover ease-[ease] hover:text-fg data-selected:font-medium data-selected:text-fg",
};

export function Tab({ className, ...props }: ComponentProps<typeof TabsTab>) {
  const variant = useContext(VariantContext);
  return <TabsTab {...props} className={cn(tabClass[variant], className as string | undefined)} />;
}

export function TabPanel(props: ComponentProps<typeof TabsPanel>) {
  return <TabsPanel {...props} />;
}

/**
 * Tabs that are routes (Provider, Pool, Settings): each tab is a Link, the
 * current route's `value` selects it, and `children` is its panel.
 */
export function RouteTabs({
  label,
  value,
  items,
  children,
  panelClassName,
}: {
  label: string;
  value: string;
  items: { value: string; to: string; label: ReactNode }[];
  children: ReactNode;
  panelClassName?: string;
}) {
  return (
    <Root value={value}>
      <TabList label={label}>
        {items.map((t) => (
          <Tab key={t.value} value={t.value} render={<Link to={t.to} />}>
            {t.label}
          </Tab>
        ))}
      </TabList>
      <TabsPanel value={value} className={panelClassName}>
        {children}
      </TabsPanel>
    </Root>
  );
}
