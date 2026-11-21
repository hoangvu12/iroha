import type { ComponentType, ReactNode } from "react";
import { CircleAlert, RotateCw, X } from "lucide-react";
import { isApiError } from "@/api/client";
import { Button, IconButton } from "./Button";
import { cn } from "./cn";

function Centered({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col items-center px-4 py-14 text-center", className)}>{children}</div>;
}

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

export type FilterChip = { label: ReactNode; name?: string; onRemove: () => void };

export function Chip({ label, name, onRemove }: FilterChip) {
  const what = name ?? (typeof label === "string" ? label : "");
  return (
    <span className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-muted pl-3 pr-1 text-[13px] text-fg">
      {label}
      <IconButton icon={X} size="xs" label={`Remove filter ${what}`.trim()} onClick={onRemove} />
    </span>
  );
}

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

export function ErrorState({ title, error, onRetry }: { title: ReactNode; error: unknown; onRetry?: () => void }) {
  const message = isApiError(error) ? error.message : error instanceof Error ? error.message : String(error);
  const hint = isApiError(error) && error.status !== null && error.status >= 400 ? error.hint : "";
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
