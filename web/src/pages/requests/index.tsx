import { Navigate, Route, Routes } from "react-router";
import { RequestsFeed } from "./Feed";
import { RouteViewPage } from "./RouteView";

// Requests (ticket 25). /requests is the feed with its drawer
// (?request=<id>); /requests/<id>/route, /details and /captured are a
// Request's full-page Route view and its other tabs.

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
