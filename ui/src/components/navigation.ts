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
}

export const PRIMARY_NAVIGATION: readonly NavigationItem[] = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'providers', label: 'Providers', icon: Server },
  { id: 'gateway-keys', label: 'Gateway Keys', icon: KeyRound },
  { id: 'requests', label: 'Requests', icon: SquareChartGantt },
  { id: 'audit', label: 'Audit', icon: ScrollText },
  { id: 'settings', label: 'Settings', icon: Settings },
]