import { Route, Routes } from "react-router";
import { KeyPage } from "./KeyPage";
import { KeysList } from "./List";

export default function GatewayKeysPage() {
  return (
    <Routes>
      <Route index element={<KeysList />} />
      <Route path=":key" element={<KeyPage />} />
    </Routes>
  );
}
