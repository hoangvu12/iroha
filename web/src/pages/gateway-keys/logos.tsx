import { LogoTile } from "@/ui/LogoTile";

// Logo URLs served by Iroha, for the scope checklist. Ticket 22 serves them;
// until it merges every tile shows the name's first letter. These two
// functions are the one place to change.

export function providerLogo(_handle: string): string | undefined {
  return undefined;
}

export function poolLogo(_pool: string): string | undefined {
  return undefined;
}

export function ProviderTile({ handle, size = 24 }: { handle: string; size?: number }) {
  return <LogoTile name={handle} src={providerLogo(handle)} size={size} />;
}

export function PoolTile({ name, size = 24 }: { name: string; size?: number }) {
  return <LogoTile name={name} src={poolLogo(name)} shape="square" size={size} />;
}
