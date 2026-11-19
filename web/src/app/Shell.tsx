import { NavLink, Outlet, useLocation } from "react-router";
import { LogOut, Monitor, Moon, Settings, Sun } from "lucide-react";
import { useSignOut } from "@/api/session";
import { useIsPhone } from "@/lib/media";
import { IconButton } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { Kbd } from "@/ui/bits";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/ui/Menu";
import { ScrollArea } from "@/ui/ScrollArea";
import { notify } from "@/ui/toast";
import { ChatPanel } from "@/pages/chat/ChatPanel";
import { Avatar, BANNER_SRC } from "./brand";
import { useChatPanel } from "./chat-panel";
import type { HealthState } from "./health";
import { healthLabel, useHealth } from "./health";
import { NAV, type NavItem } from "./nav";
import { PageBody } from "./PageBody";
import { useNavShortcuts } from "./shortcuts";
import { type ThemePref, useTheme } from "./theme";

export const SIDEBAR_WIDTH = 224;
export const CHAT_WIDTH = 460;

/**
 * The signed-in app: sidebar (desktop) or bottom tab bar (phone), the page
 * in the middle, and the chat panel slot on the right.
 */
export function Shell() {
  useNavShortcuts();
  const phone = useIsPhone();
  const chat = useChatPanel();
  const { pathname } = useLocation();
  const chatPage = pathname === "/chat" || pathname.startsWith("/chat/");

  return (
    <div className="min-h-dvh bg-bg">
      {!phone && <Sidebar />}
      <main
        className={cn("min-w-0", phone ? "pb-[calc(72px+env(safe-area-inset-bottom))]" : "")}
        style={phone ? undefined : { paddingLeft: SIDEBAR_WIDTH }}
      >
        {chatPage ? (
          <Outlet />
        ) : (
          <div className="px-4 pt-6 md:px-12 md:pb-12 md:pt-10">
            <PageBody width="wide">
              <Outlet />
            </PageBody>
          </div>
        )}
      </main>
      {chat.isOpen && !chatPage && (
        <aside
          aria-label="Chat"
          style={{ width: CHAT_WIDTH }}
          className="fixed inset-y-0 right-0 z-30 flex max-w-full flex-col border-l border-border bg-subtle shadow-elevated"
        >
          <ChatPanel mode="sheet" />
        </aside>
      )}
      {phone && <TabBar />}
    </div>
  );
}

// No transition: P, G, R and C move the highlight, and a key never animates
// (architecture.md "UI motion system"); hover is instant too, like menu items.
const navItemClass = (active: boolean) =>
  cn(
    "group flex h-9 select-none items-center gap-3 rounded-lg px-2.5 text-[14.5px]",
    active ? "bg-muted text-fg" : "text-fg hover:bg-muted/60",
  );

function SidebarItem({ item }: { item: NavItem }) {
  const chat = useChatPanel();
  const Icon = item.icon;
  const inner = (
    <>
      <Icon size={18} strokeWidth={1.75} className="text-fg-muted group-aria-[current=page]:text-fg" />
      <span className="flex-1">{item.label}</span>
      <Kbd>{item.key}</Kbd>
    </>
  );
  if (item.action === "chat") {
    return (
      <button
        type="button"
        onClick={chat.toggle}
        aria-pressed={chat.isOpen}
        aria-keyshortcuts={item.key}
        className={cn(navItemClass(chat.isOpen), "w-full text-left")}
      >
        {inner}
      </button>
    );
  }
  return (
    <NavLink to={item.to} aria-keyshortcuts={item.key} className={({ isActive }) => navItemClass(isActive)}>
      {inner}
    </NavLink>
  );
}

function Sidebar() {
  const health = useHealth();
  return (
    <aside
      style={{ width: SIDEBAR_WIDTH }}
      // Left padding clears a phone's notch in landscape (wide enough for the sidebar).
      className="fixed inset-y-0 left-0 z-20 flex flex-col border-r border-border bg-subtle pb-3 pl-[max(0.75rem,env(safe-area-inset-left))] pr-3 pt-3"
    >
      {/* Short windows: the banner and nav scroll; health, Settings and the Owner stay.
          Scrolling past its end doesn't scroll the page behind. */}
      <ScrollArea className="-mx-3 mb-2 flex-1" contentClassName="px-3" viewportClassName="overscroll-contain">
        <img src={BANNER_SRC} alt="Iroha" className="h-[84px] w-full rounded-lg object-cover" draggable={false} />
        <nav aria-label="Main" className="mt-4 flex flex-col gap-1">
          {NAV.map((item) => (
            <SidebarItem key={item.label} item={item} />
          ))}
        </nav>
      </ScrollArea>
      <HealthNotice health={health} />
      <NavLink to="/settings" className={({ isActive }) => navItemClass(isActive)}>
        <Settings size={18} strokeWidth={1.75} className="text-fg-muted" />
        <span className="flex-1">Settings</span>
      </NavLink>
      <div className="mt-2 border-t border-border pt-2">
        <OwnerRow health={health} />
      </div>
    </aside>
  );
}

/** Quiet when Iroha is ready (a dot on the avatar); a red line when it is not. */
function HealthNotice({ health }: { health: HealthState }) {
  if (health.state !== "not_ready" && health.state !== "unreachable") return null;
  return (
    <div
      role="status"
      className="mb-2 rounded-lg bg-danger-tint px-2.5 py-2 text-[13px] transition-[opacity,translate] duration-list-in ease-out starting:translate-y-(--motion-shift-sm) starting:opacity-0"
    >
      <p className="font-medium text-danger-text">{healthLabel(health)}</p>
      <p className="mt-0.5 font-mono text-[11px] text-fg-muted">{health.call}</p>
    </div>
  );
}

function useSignOutWithToast() {
  const signOut = useSignOut();
  return () =>
    signOut.mutate(undefined, {
      onError: (e) => notify.failure("Couldn't sign out", e),
    });
}

function OwnerRow({ health }: { health: HealthState }) {
  const signOut = useSignOutWithToast();
  const { pref, setPref } = useTheme();
  return (
    <div className="flex items-center gap-1">
      <Menu>
        <MenuTrigger className="flex h-9 min-w-0 flex-1 select-none items-center gap-2.5 rounded-lg px-2 text-left text-[14.5px] text-fg-muted hover:bg-muted/60 hover:text-fg data-open:bg-muted/60 data-open:text-fg">
          <Avatar size={22} health={health} />
          <span className="truncate">Owner</span>
        </MenuTrigger>
        <MenuContent align="start" side="top">
          <MenuLabel>{healthLabel(health)}</MenuLabel>
          <MenuSeparator />
          <MenuRadioGroup label="Theme" value={pref} onValueChange={(v) => setPref(v as ThemePref)}>
            <MenuRadioItem value="system">
              <Monitor size={15} className="text-fg-muted" /> System
            </MenuRadioItem>
            <MenuRadioItem value="light">
              <Sun size={15} className="text-fg-muted" /> Light
            </MenuRadioItem>
            <MenuRadioItem value="dark">
              <Moon size={15} className="text-fg-muted" /> Dark
            </MenuRadioItem>
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem icon={LogOut} onSelect={signOut}>
            Sign out
          </MenuItem>
        </MenuContent>
      </Menu>
      <IconButton icon={LogOut} label="Sign out" size="sm" onClick={signOut} />
    </div>
  );
}

/** Phones: the sidebar becomes a bottom tab bar (C30). Settings sits behind the avatar in each page header. */
function TabBar() {
  const { pathname } = useLocation();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      {NAV.map((item) => {
        const to = item.to ?? "/chat";
        const active = pathname === to || pathname.startsWith(to + "/");
        const Icon = item.icon;
        return (
          <NavLink
            key={item.label}
            to={to}
            // A tab, not a link to copy: long-press neither selects the label nor opens the link callout.
            className={cn(
              "flex h-[64px] select-none flex-col items-center justify-center gap-1 text-[11.5px] font-medium [-webkit-touch-callout:none]",
              active ? "text-fg" : "text-fg-muted",
            )}
          >
            <Icon size={23} strokeWidth={active ? 2 : 1.6} />
            {item.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
