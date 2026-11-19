import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      // No CSS in tests, except the stylesheet's source for styles/motion.test.ts.
      css: { include: [/styles[\\/]index\.css/] },
    },
  }),
);
