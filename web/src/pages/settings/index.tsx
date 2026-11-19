import { Navigate, Route, Routes } from "react-router";
import { PageHeader } from "@/app/PageHeader";
import { Tabs } from "@/ui/bits";
import { AdminTokensTab } from "./AdminTokens";
import { useAdminTokens } from "./api";
import { AuditEntriesTab } from "./AuditEntries";
import { SignInTab } from "./SignIn";

// Settings (C28, C29): a title, underline tabs and a table, nothing more.
// Reached from the sidebar's Settings item, and on phones from the Iroha
// avatar in every page header (C30). Each tab is a route under /settings.

export default function SettingsPage() {
  const tokens = useAdminTokens();
  return (
    <>
      <PageHeader title="Settings" description="Admin access to Iroha, and a record of every change" />
      <Tabs
        items={[
          {
            to: "/settings/admin-tokens",
            label: (
              <>
                Admin Tokens
                {tokens.data && <span className="ml-2 tabular text-fg-muted">{tokens.data.length}</span>}
              </>
            ),
          },
          { to: "/settings/audit-entries", label: "Audit Entries" },
          { to: "/settings/sign-in", label: "Sign-in" },
        ]}
      />
      <div className="pt-7">
        <Routes>
          <Route index element={<Navigate to="admin-tokens" replace />} />
          <Route path="admin-tokens" element={<AdminTokensTab />} />
          <Route path="audit-entries" element={<AuditEntriesTab />} />
          <Route path="sign-in" element={<SignInTab />} />
          <Route path="*" element={<Navigate to="admin-tokens" replace />} />
        </Routes>
      </div>
    </>
  );
}
