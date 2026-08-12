import { Menu } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { PRIMARY_NAVIGATION, type NavigationItem } from '@/components/navigation'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

interface AppShellProps {
  readonly activeId: string
  readonly onNavigate: (id: string) => void
  readonly title: string
  readonly description: string
  readonly headerAside?: ReactNode
  readonly children: ReactNode
}

/**
 * The management shell: a persistent sidebar on desktop, the same navigation in
 * a drawer on small screens, and a divider-led content column. Bordered
 * surfaces are reserved for tables and charts, so the shell itself uses
 * dividers and whitespace for hierarchy.
 */
export function AppShell({
  activeId,
  onNavigate,
  title,
  description,
  headerAside,
  children,
}: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)

  const navigate = (id: string) => {
    onNavigate(id)
    setDrawerOpen(false)
  }

  return (
    <div className="bg-canvas flex h-full">
      <aside className="border-sidebar-border bg-sidebar hidden w-56 shrink-0 flex-col border-r md:flex">
        <Brand />
        <Navigation activeId={activeId} onNavigate={navigate} />
        <InstallationNote />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-border bg-background flex items-center gap-3 border-b px-4 py-3 md:px-6">
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
                <Menu className="size-4" aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="bg-sidebar w-64 p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <Brand />
              <Navigation activeId={activeId} onNavigate={navigate} />
              <InstallationNote />
            </SheetContent>
          </Sheet>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold tracking-tight">{title}</h1>
            <p className="text-muted-foreground truncate text-xs">{description}</p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {headerAside}
            <ThemeToggle />
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6 md:py-8">{children}</div>
        </main>
      </div>
    </div>
  )
}

function Brand() {
  return (
    <div className="border-sidebar-border flex h-[57px] items-center border-b px-4">
      <span className="text-sidebar-foreground text-sm font-semibold tracking-tight">Iroha</span>
      <span className="text-muted-foreground ml-2 text-xs">Gateway</span>
    </div>
  )
}

function Navigation({
  activeId,
  onNavigate,
}: {
  activeId: string
  onNavigate: (id: string) => void
}) {
  return (
    <nav aria-label="Primary" className="flex-1 overflow-y-auto p-2">
      <ul className="flex flex-col gap-0.5">
        {PRIMARY_NAVIGATION.map((item) => (
          <li key={item.id}>
            <NavigationButton
              item={item}
              active={item.id === activeId}
              onSelect={() => onNavigate(item.id)}
            />
          </li>
        ))}
      </ul>
    </nav>
  )
}

function NavigationButton({
  item,
  active,
  onSelect,
}: {
  item: NavigationItem
  active: boolean
  onSelect: () => void
}) {
  const Icon = item.icon

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!item.available}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
        'text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        active && 'bg-active-subtle text-active font-medium hover:bg-active-subtle hover:text-active',
        !item.available && 'cursor-not-allowed opacity-45 hover:bg-transparent',
      )}
    >
      {/* The blue active accent, drawn as a rail rather than a filled block. */}
      <span
        aria-hidden
        className={cn(
          'bg-active absolute top-1.5 bottom-1.5 -left-2 w-0.5 rounded-full opacity-0',
          active && 'opacity-100',
        )}
      />
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{item.label}</span>
      {!item.available && (
        <span className="text-muted-foreground ml-auto text-[10px] tracking-wide uppercase">
          Soon
        </span>
      )}
    </button>
  )
}

function InstallationNote() {
  return (
    <div className="border-sidebar-border text-muted-foreground border-t px-4 py-3 text-xs">
      Self-hosted installation
    </div>
  )
}
