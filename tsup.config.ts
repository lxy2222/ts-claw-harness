import { defineConfig } from "tsup";

export default defineConfig({
  entry: { claw: "src/cli/main.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
