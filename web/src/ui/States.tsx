import type { ComponentType, ReactNode } from "react";
import { CircleAlert, RotateCw, X } from "lucide-react";
import { isApiError } from "@/api/client";
import { Button } from "./Button";
import { cn } from "./cn";

// Page states from C25. Each keeps the page around it: render them inside
// the table area, under the table header, not instead of the page.

function Centered({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col items-center px-4 py-14 text-center", className)}>{children}</div>;
}

/** Empty: one sentence and the one action that fills the page. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: ComponentType<{ size?: number; className?: string }>;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Centered>
      {Icon && (
        <span className="mb-4 inline-flex size-10 items-center justify-center rounded-lg border border-border bg-bg text-fg-muted">
          <Icon size={18} />
        </span>
      )}
      <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
      {description && <p className="mt-1.5 max-w-md text-sm text-fg-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </Centered>
  );
}

export type FilterChip = { label: ReactNode; onRemove: () => void };

/** A filter shown as a removable chip; used above tables and in NoResults. */
export function Chip({ label, onRemove }: FilterChip) {
  return (
    <span className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-muted pl-3 pr-1.5 text-[13px] text-fg">
      {label}
      <button type="button" onClick={onRemove} aria-label="Remove filter" className="rounded p-0.5 text-fg-muted hover:text-fg">
        <X size={14} />
      </button>
    </span>
  );
}

/** No results: the filters stay on screen as chips, with Clear filters. */
export function NoResults({
  title,
  description,
  filters,
  onClear,
}: {
  title: ReactNode;
  description?: ReactNode;
  filters?: FilterChip[];
  onClear: () => void;
}) {
  return (
    <Centered>
      {filters && filters.length > 0 && (
        <div className="mb-5 flex flex-wrap justify-center gap-2">
          {filters.map((f, i) => (
            <Chip key={i} {...f} />
          ))}
        </div>
      )}
      <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
      {description && <p className="mt-1.5 max-w-md text-sm text-fg-muted">{description}</p>}
      <Button className="mt-5" onClick={onClear}>
        Clear filters
      </Button>
    </Centered>
  );
}

/**
 * Error: says what failed, offers Try again, and shows the failed call in
 * small mono text ("GET /api/requests timed out").
 */
export function ErrorState({ title, error, onRetry }: { title: ReactNode; error: unknown; onRetry?: () => void }) {
  const message = isApiError(error) ? error.message : error instanceof Error ? error.message : String(error);
  const hint = isApiError(error) && error.status >= 400 ? error.hint : "";
  return (
    <Centered>
      <span className="mb-4 inline-flex size-10 items-center justify-center rounded-lg bg-danger-tint text-danger-text">
        <CircleAlert size={19} />
      </span>
      <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm text-fg-muted">{message}</p>
      {hint && <p className="mt-1 max-w-md text-sm text-fg-muted">{hint}</p>}
      {onRetry && (
        <Button className="mt-5" icon={RotateCw} onClick={onRetry}>
          Try again
        </Button>
      )}
      {isApiError(error) && <p className="mt-5 font-mono text-xs text-fg-muted">{error.call}</p>}
    </Centered>
  );
}
