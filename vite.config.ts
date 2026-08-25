import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: ".",
  base: "./",
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@typing-game": path.resolve(__dirname, "apps/typing-game/src"),
      "@leaderboard": path.resolve(__dirname, "apps/leaderboard/src")
    }
  },
  build: {
    outDir: "dist-renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "index.html")
    }
  }
});
