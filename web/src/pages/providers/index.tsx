import { Navigate, Route, Routes } from "react-router";
import { ProvidersList } from "./List";
import { PoolPage } from "./PoolPage";
import { ProviderPage } from "./ProviderPage";

export default function ProvidersPage() {
  return (
    <Routes>
      <Route index element={<ProvidersList />} />
      <Route path="pools/:name" element={<Navigate to="route" replace />} />
      <Route path="pools/:name/:tab" element={<PoolPage />} />
      <Route path=":handle" element={<Navigate to="keys" replace />} />
      <Route path=":handle/:tab" element={<ProviderPage />} />
      <Route path="*" element={<Navigate to="/providers" replace />} />
    </Routes>
  );
}
