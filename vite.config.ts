import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

const projectRoot = import.meta.dirname;

export default defineConfig({
  plugins: [react(), tailwindcss()],

  root: path.resolve(projectRoot, "client"),

  resolve: {
    alias: {
      "@": path.resolve(projectRoot, "client", "src"),
      "@shared": path.resolve(projectRoot, "shared"),
      "@assets": path.resolve(projectRoot, "attached_assets"),
    },
  },

  envDir: projectRoot,
  publicDir: path.resolve(projectRoot, "client", "public"),

  build: {
    outDir: path.resolve(projectRoot, "dist/public"),
    emptyOutDir: true,
  },

  server: {
    host: true,
  },
});