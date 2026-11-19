import { KeyRound } from "lucide-react";
import { PageHeader } from "@/app/PageHeader";
import { EmptyState } from "@/ui/States";

// Placeholder for ticket 24, which owns this folder (mounted at /gateway-keys/*).

export default function GatewayKeysPage() {
  return (
    <>
      <PageHeader title="Gateway Keys" description="The keys Callers use to reach Iroha" />
      <EmptyState
        icon={KeyRound}
        title="No Gateway Keys yet"
        description="Issue a Gateway Key to each Caller, so every Request is attributed to it."
      />
    </>
  );
}
