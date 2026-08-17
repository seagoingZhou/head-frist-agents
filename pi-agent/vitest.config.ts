import { defineConfig } from "vitest/config";
import base from "./vitest.base.ts";

export default defineConfig({
  ...base,
  test: {
    environment: "node",
    reporters: ["verbose"]
  }
});
