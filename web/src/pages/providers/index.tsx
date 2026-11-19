import { Server } from "lucide-react";
import { PageHeader } from "@/app/PageHeader";
import { EmptyState } from "@/ui/States";

// Placeholder for ticket 22, which owns this folder. App.tsx mounts this
// component at /providers/*, so sub-pages (/providers/:handle/keys...) go in
// a <Routes> here, without touching App.tsx.

export default function ProvidersPage() {
  return (
    <>
      <PageHeader title="Providers" description="The AI services Iroha sends requests to" />
      <EmptyState
        icon={Server}
        title="No Providers yet"
        description="Add a Provider and paste its Upstream Keys, and Iroha starts routing to them."
      />
    </>
  );
}
