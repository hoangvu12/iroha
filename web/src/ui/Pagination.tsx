import { ChevronLeft, ChevronRight, Ellipsis } from "lucide-react";
import {
  Pagination as SdkPagination,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationList,
  PaginationNext,
  PaginationPrevious,
} from "@ui-sdk/react/pagination";
import { cn } from "./cn";

const step =
  "press inline-flex size-8 items-center justify-center rounded-lg text-fg-muted hover:bg-muted hover:text-fg data-disabled:opacity-40 data-disabled:hover:bg-transparent";
const link =
  "press inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-[13px] tabular text-fg-muted hover:bg-muted hover:text-fg data-current:bg-muted data-current:font-medium data-current:text-fg";

export function Pager({
  page,
  pageCount,
  onPageChange,
  label,
  className,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  label: string;
  className?: string;
}) {
  return (
    <SdkPagination aria-label={label} page={page} pageCount={pageCount} onPageChange={(p) => onPageChange(p)} className={className}>
      <PaginationList className={cn("flex items-center gap-0.5")}>
        {({ items }) => (
          <>
            <PaginationItem>
              <PaginationPrevious aria-label="Previous page" className={step}>
                <ChevronLeft size={16} aria-hidden />
              </PaginationPrevious>
            </PaginationItem>
            {items.map((item) => (
              <PaginationItem key={item}>
                {typeof item === "number" ? (
                  <PaginationLink page={item} aria-label={`Page ${item}`} className={link} />
                ) : (
                  <PaginationEllipsis className="inline-flex size-8 items-center justify-center text-fg-subtle">
                    <Ellipsis size={15} aria-hidden />
                  </PaginationEllipsis>
                )}
              </PaginationItem>
            ))}
            <PaginationItem>
              <PaginationNext aria-label="Next page" className={step}>
                <ChevronRight size={16} aria-hidden />
              </PaginationNext>
            </PaginationItem>
          </>
        )}
      </PaginationList>
    </SdkPagination>
  );
}
