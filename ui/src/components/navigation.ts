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
  readonly hint: string
}

export const PRIMARY_NAVIGATION: readonly NavigationItem[] = [
  { id: 'overview', label: 'Overview', icon: Activity, hint: 'O' },
  { id: 'providers', label: 'Providers', icon: Server, hint: 'P' },
  { id: 'gateway-keys', label: 'Gateway Keys', icon: KeyRound, hint: 'G' },
  { id: 'requests', label: 'Requests', icon: SquareChartGantt, hint: 'R' },
  { id: 'audit', label: 'Audit', icon: ScrollText, hint: 'A' },
  { id: 'settings', label: 'Settings', icon: Settings, hint: 'S' },
]