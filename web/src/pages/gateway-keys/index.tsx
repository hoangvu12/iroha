import { Route, Routes } from "react-router";
import { KeyPage } from "./KeyPage";
import { KeysList } from "./List";

// Gateway Keys (ticket 24): the list with the create dialog at
// /gateway-keys, and each key's page at /gateway-keys/<key ID>.

export default function GatewayKeysPage() {
  return (
    <Routes>
      <Route index element={<KeysList />} />
      <Route path=":key" element={<KeyPage />} />
    </Routes>
  );
}
