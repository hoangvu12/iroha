import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { isApiError } from "@/api/client";
import { Toaster } from "@/ui/toast";
import { AuthGate } from "./AuthGate";
import { ChatPanelProvider } from "./chat-panel";
import { Shell } from "./Shell";
import { SkeletonRoot } from "./skeletons";
import { ThemeProvider, useTheme } from "./theme";

// One line per page. Each page folder under src/pages owns everything below
// its path ("providers/*" lets ticket 22 add /providers/:handle/keys inside
// src/pages/providers without editing this file).
const ProvidersPage = lazy(() => import("@/pages/providers"));
const GatewayKeysPage = lazy(() => import("@/pages/gateway-keys"));
const RequestsPage = lazy(() => import("@/pages/requests"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const ChatPage = lazy(() => import("@/pages/chat"));
const StatesPage = lazy(() => import("@/pages/states"));
const NotFoundPage = lazy(() => import("@/pages/not-found"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retry only when Iroha did not answer or failed (5xx); a 4xx will not change.
      retry: (n, e) => n < 2 && isApiError(e) && (e.status === 0 || e.status >= 500),
      staleTime: 10_000,
      refetchOnWindowFocus: true,
    },
  },
});

function ThemedToaster() {
  const { resolved } = useTheme();
  return <Toaster theme={resolved} />;
}

export function App() {
  return (
    <ThemeProvider>
      {/* Skeletons follow Iroha's theme, so their provider sits inside it. */}
      <SkeletonRoot>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthGate>
            <ChatPanelProvider>
              <Suspense fallback={null}>
                <Routes>
                  <Route element={<Shell />}>
                    <Route index element={<Navigate to="/providers" replace />} />
                    <Route path="login" element={<Navigate to="/providers" replace />} />
                    <Route path="providers/*" element={<ProvidersPage />} />
                    <Route path="gateway-keys/*" element={<GatewayKeysPage />} />
                    <Route path="requests/*" element={<RequestsPage />} />
                    <Route path="settings/*" element={<SettingsPage />} />
                    <Route path="chat/*" element={<ChatPage />} />
                    <Route path="states" element={<StatesPage />} />
                    <Route path="*" element={<NotFoundPage />} />
                  </Route>
                </Routes>
              </Suspense>
            </ChatPanelProvider>
          </AuthGate>
        </BrowserRouter>
        <ThemedToaster />
      </QueryClientProvider>
      </SkeletonRoot>
    </ThemeProvider>
  );
}
