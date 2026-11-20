import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { reloadOnStaleChunks } from "@/app/stale-chunks";
import "@/styles/index.css";

reloadOnStaleChunks();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
