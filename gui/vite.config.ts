import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // cargo/turbo writes thousands of files into src-tauri/target; watching
    // it starves the compiler and burns CPU.
    watch: {
      ignored: ["**/src-tauri/target/**", "**/src-tauri/gen/**", "**/dist/**", "**/node_modules/**"],
    },
  },
  build: {
    target: "safari15",
    minify: "esbuild",
    sourcemap: false,
  },
});
