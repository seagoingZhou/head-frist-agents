import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import base from "./vitest.base.ts";

export default mergeConfig(base, defineConfig({
  test: {
    environment: "node"
  }
}));
