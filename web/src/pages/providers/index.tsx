import { Navigate, Route, Routes } from "react-router";
import { ProvidersList } from "./List";
import { PoolPage } from "./PoolPage";
import { ProviderPage } from "./ProviderPage";

// Providers (ticket 22). App.tsx mounts this at /providers/*:
//   /providers                         Providers and Model Pools (C05, C30)
//   /providers/<handle>/<tab>          a Provider: keys, endpoints, models, rules, settings
//   /providers/pools/<name>/<tab>      a Model Pool: route, members, settings
// "pools" is reserved as a Provider handle so the two never collide.

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
