import { Settings } from "lucide-react";
import { PageHeader } from "@/app/PageHeader";
import { EmptyState } from "@/ui/States";

// Placeholder for ticket 28, which owns this folder (mounted at /settings/*):
// Admin Tokens and Audit Entries as two underline tabs (ui/bits Tabs).

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <EmptyState
        icon={Settings}
        title="Admin Tokens and Audit Entries"
        description="Tokens for your agents, and every change made to Iroha with a way to revert it, will be here."
      />
    </>
  );
}
