import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      testTimeout: 15_000,
      include: ["src/**/*.test.{ts,tsx}"],
      css: { include: [/styles[\\/]index\.css/] },
    },
  }),
);
