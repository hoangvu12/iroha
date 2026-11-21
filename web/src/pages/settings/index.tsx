import { Navigate, Route, Routes, useLocation } from "react-router";
import { PageHeader } from "@/app/PageHeader";
import { RouteTabs } from "@/ui/Tabs";
import { AdminTokensTab } from "./AdminTokens";
import { useAdminTokens } from "./api";
import { AuditEntriesTab } from "./AuditEntries";
import { SignInTab } from "./SignIn";

export default function SettingsPage() {
  const tokens = useAdminTokens();
  const tab = useLocation().pathname.split("/")[2] ?? "";
  return (
    <>
      <PageHeader title="Settings" description="Admin access to Iroha, and a record of every change" />
      <RouteTabs
        label="Settings sections"
        value={tab}
        panelClassName="pt-7"
        items={[
          {
            value: "admin-tokens",
            to: "/settings/admin-tokens",
            label: (
              <>
                Admin Tokens
                {tokens.data && <span className="ml-2 tabular text-fg-muted">{tokens.data.length}</span>}
              </>
            ),
          },
          { value: "audit-entries", to: "/settings/audit-entries", label: "Audit Entries" },
          { value: "sign-in", to: "/settings/sign-in", label: "Sign-in" },
        ]}
      >
        <Routes>
          <Route index element={<Navigate to="admin-tokens" replace />} />
          <Route path="admin-tokens" element={<AdminTokensTab />} />
          <Route path="audit-entries" element={<AuditEntriesTab />} />
          <Route path="sign-in" element={<SignInTab />} />
          <Route path="*" element={<Navigate to="admin-tokens" replace />} />
        </Routes>
      </RouteTabs>
    </>
  );
}
