import { Activity } from "lucide-react";
import { PageHeader } from "@/app/PageHeader";
import { EmptyState } from "@/ui/States";

// Placeholder for ticket 25, which owns this folder (mounted at /requests/*).

export default function RequestsPage() {
  return (
    <>
      <PageHeader title="Requests" description="Everything Callers sent through Iroha" />
      <EmptyState icon={Activity} title="No Requests yet" description="Requests show here as Callers send them." />
    </>
  );
}
