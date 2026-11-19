import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      // Page-level tests (sheet stacks, feeds) take 1-2 s alone; under a loaded machine 5 s is too tight.
      testTimeout: 15_000,
      include: ["src/**/*.test.{ts,tsx}"],
      // No CSS in tests, except the stylesheet's source for styles/motion.test.ts.
      css: { include: [/styles[\\/]index\.css/] },
    },
  }),
);
