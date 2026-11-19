import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The build goes straight into the Go package that embeds it
// (internal/webui/dist). Only dist/.gitkeep is committed there, so the
// plugin below puts it back after Vite empties the folder.
const outDir = fileURLToPath(new URL("../internal/webui/dist", import.meta.url));

function keepPlaceholder(): Plugin {
  return {
    name: "iroha-keep-gitkeep",
    apply: "build",
    closeBundle() {
      writeFileSync(`${outDir}/.gitkeep`, "");
    },
  };
}

// `npm run dev` serves the UI with hot reload and sends API calls to a
// running Iroha (default http://127.0.0.1:8080; set IROHA_URL to change).
const iroha = process.env.IROHA_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), tailwindcss(), keepPlaceholder()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  publicDir: false, // brand art is served by Iroha from internal/webui/brand
  build: {
    outDir,
    emptyOutDir: true,
    assetsDir: "assets",
  },
  server: {
    proxy: Object.fromEntries(
      ["/api", "/brand", "/readyz", "/healthz", "/skill.md"].map((p) => [p, { target: iroha, changeOrigin: false }]),
    ),
  },
});
