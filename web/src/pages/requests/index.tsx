import { Navigate, Route, Routes } from "react-router";
import { RequestsFeed } from "./Feed";
import { RouteViewPage } from "./RouteView";

export default function RequestsPage() {
  return (
    <Routes>
      <Route index element={<RequestsFeed />} />
      <Route path=":id" element={<Navigate to="route" replace />} />
      <Route path=":id/:tab" element={<RouteViewPage />} />
      <Route path="*" element={<Navigate to="/requests" replace />} />
    </Routes>
  );
}
