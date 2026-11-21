import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

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

const iroha = process.env.IROHA_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), tailwindcss(), keepPlaceholder()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  publicDir: false,
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
