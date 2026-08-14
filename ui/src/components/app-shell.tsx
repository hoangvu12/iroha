import { FileText, Github, LogOut, Menu } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { PRIMARY_NAVIGATION, type NavigationItem } from '@/components/navigation'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useCsrf } from '@/lib/csrf-context'
import { cn } from '@/lib/utils'

interface AppShellProps {
  readonly children: ReactNode
}

const ROUTE_PATHS = {
  overview: '/',
  providers: '/providers',
  'gateway-keys': '/gateway-keys',
  requests: '/requests',
  audit: '/audit',
  settings: '/settings',
} as const

/**
 * The management shell: a single sidebar carries the brand, the navigation,
 * and the footer links. The main column has no header bar of its own — every
 * area renders its own title row inside its content.
 */
export function AppShell({ children }: AppShellProps) {
  const { onSignedOut } = useCsrf()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  const navigateAndClose = (id: string) => {
    const path = ROUTE_PATHS[id as keyof typeof ROUTE_PATHS]
    if (path === undefined) return
    setDrawerOpen(false)
    void navigate({ to: path })
  }

  const sidebarBody = (onItemNavigate: (id: string) => void) => (
    <>
      <Brand />
      <Navigation activeId={resolveActiveId(location.pathname)} onNavigate={onItemNavigate} />
      <SidebarFooter version="0.1.0" onSignOut={onSignedOut} />
    </>
  )

  return (
    <div className="bg-canvas flex h-full">
      <aside className="border-sidebar-border bg-sidebar hidden w-56 shrink-0 flex-col border-r md:flex">
        {sidebarBody(navigateAndClose)}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="md:hidden border-border bg-background flex items-center gap-3 border-b px-4 py-3">
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open navigation">
                <Menu className="size-4" aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="bg-sidebar w-64 p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              {sidebarBody(navigateAndClose)}
            </SheetContent>
          </Sheet>
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
    <div className="border-sidebar-border flex h-12 items-center gap-2.5 border-b px-4">
      <span
        aria-hidden
        className="relative inline-flex size-6 items-center justify-center rounded-full bg-[#1A1A1A]"
      >
        <span className="absolute top-[7px] flex gap-[3px]">
          <span className="size-[3px] rounded-full bg-white" />
          <span className="size-[3px] rounded-full bg-white" />
        </span>
      </span>
      <Link to="/" className="text-sidebar-foreground text-sm font-semibold tracking-tight">
        Iroha
      </Link>
    </div>
  )
}

function Navigation({
  activeId,
  onNavigate,
}: {
  readonly activeId: string
  readonly onNavigate: (id: string) => void
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
  const path = ROUTE_PATHS[item.id as keyof typeof ROUTE_PATHS] ?? '/'

  return (
    <Link
      to={path}
      onClick={(event) => {
        event.preventDefault()
        onSelect()
      }}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
        'text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        active && 'bg-active-subtle text-active font-medium hover:bg-active-subtle hover:text-active',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden strokeWidth={active ? 2 : 1.5} />
      <span className="truncate">{item.label}</span>
    </Link>
  )
}

function SidebarFooter({ version, onSignOut }: { version: string; onSignOut: () => void }) {
  return (
    <div className="border-sidebar-border mt-auto border-t p-2">
      <FooterLink icon={FileText} label="Documentation" href="/docs" />
      <FooterLink icon={Github} label="GitHub" href="https://github.com/hoangvu12/iroha" />
      <FooterLink icon={LogOut} label="Sign out" onClick={onSignOut} />
      <div className="border-sidebar-border mt-2 flex items-center justify-between border-t pt-2">
        <span className="text-muted-foreground text-[10px] font-mono opacity-70">v{version}</span>
        <ThemeToggle compact />
      </div>
    </div>
  )
}

function FooterLink({
  icon: Icon,
  label,
  href,
  onClick,
}: {
  icon: typeof FileText
  label: string
  href?: string
  onClick?: () => void
}) {
  const className =
    'text-muted-foreground hover:text-foreground hover:bg-sidebar-accent flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors'
  const icon = <Icon className="size-4 shrink-0" aria-hidden strokeWidth={1.5} />
  const text = <span className="truncate">{label}</span>

  if (href !== undefined) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {icon}
        {text}
      </a>
    )
  }
  if (onClick !== undefined) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {icon}
        {text}
      </button>
    )
  }
  return (
    <span className="text-muted-foreground flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm">
      {icon}
      {text}
    </span>
  )
}

function resolveActiveId(pathname: string): string {
  if (pathname.startsWith('/providers')) return 'providers'
  if (pathname.startsWith('/gateway-keys')) return 'gateway-keys'
  if (pathname.startsWith('/requests')) return 'requests'
  if (pathname.startsWith('/audit')) return 'audit'
  if (pathname.startsWith('/settings')) return 'settings'
  return 'overview'
}