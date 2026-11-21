import type { ReactNode } from "react";
import { Link } from "react-router";
import { ChevronLeft } from "lucide-react";
import { useIsPhone } from "@/lib/media";
import { Avatar } from "./brand";
import { useHealth } from "./health";

export function PageHeader({
  title,
  description,
  actions,
  back,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  icon?: ReactNode;
}) {
  const phone = useIsPhone();
  const health = useHealth();
  return (
    <header className="mb-8">
      {back && (
        <Link to={back.to} className="mb-3 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
          <ChevronLeft size={15} />
          {back.label}
        </Link>
      )}
      <div className="flex items-start gap-4">
        {icon}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[30px] font-semibold leading-tight tracking-tight md:text-[26px]">{title}</h1>
          {description && <div className="mt-1 text-[15px] text-fg-muted">{description}</div>}
        </div>
        {(actions || phone) && (
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            {phone && (
              <Link to="/settings" aria-label="Settings" className="ml-1 select-none rounded-full [-webkit-touch-callout:none]">
                <Avatar size={36} health={health} />
              </Link>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
