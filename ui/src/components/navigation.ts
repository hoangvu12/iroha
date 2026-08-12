import {
  Activity,
  KeyRound,
  ScrollText,
  Server,
  Settings,
  SquareChartGantt,
  type LucideIcon,
} from 'lucide-react'

export interface NavigationItem {
  readonly id: string
  readonly label: string
  readonly icon: LucideIcon
  /** False until the ticket that builds the area lands. */
  readonly available: boolean
}

/**
 * Primary navigation, fixed by the version-one information architecture.
 * Areas appear from the start so the shell's shape is honest, and are marked
 * unavailable until their ticket delivers them.
 */
export const PRIMARY_NAVIGATION: readonly NavigationItem[] = [
  { id: 'overview', label: 'Overview', icon: Activity, available: true },
  { id: 'providers', label: 'Providers', icon: Server, available: false },
  { id: 'gateway-keys', label: 'Gateway Keys', icon: KeyRound, available: false },
  { id: 'requests', label: 'Requests', icon: SquareChartGantt, available: false },
  { id: 'audit', label: 'Audit', icon: ScrollText, available: false },
  { id: 'settings', label: 'Settings', icon: Settings, available: true },
]
