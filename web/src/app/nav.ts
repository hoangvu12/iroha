import { Activity, KeyRound, MessageCircle, Server } from "lucide-react";
import type { ComponentType } from "react";

export type NavItem = {
  label: string;
  key: string;
  icon: ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
} & ({ to: string; action?: never } | { to?: never; action: "chat" });

export const NAV: NavItem[] = [
  { label: "Providers", key: "P", icon: Server, to: "/providers" },
  { label: "Gateway Keys", key: "G", icon: KeyRound, to: "/gateway-keys" },
  { label: "Requests", key: "R", icon: Activity, to: "/requests" },
  { label: "Chat", key: "C", icon: MessageCircle, action: "chat" },
];
