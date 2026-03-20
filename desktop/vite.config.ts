import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// When building for Tauri, stub out Capacitor plugins so they don't cause import errors
const isTauri = !!process.env.TAURI_PLATFORM;

const capacitorStubs: Record<string, string> = isTauri
  ? Object.fromEntries(
      [
        "@capacitor/preferences",
        "@capacitor/network",
        "@capacitor/app",
        "@capacitor/haptics",
        "@capacitor/keyboard",
        "@capacitor/status-bar",
        "@capacitor/splash-screen",
        "@capacitor-mlkit/barcode-scanning",
      ].map((pkg) => [pkg, path.resolve(__dirname, "src/lib/capacitor-stub.ts")]),
    )
  : {};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      ...capacitorStubs,
    },
  },
  server: {
    host: "0.0.0.0",
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
});
