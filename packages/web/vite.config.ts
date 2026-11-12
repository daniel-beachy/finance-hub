import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const demo = process.env.VITE_MODE === "demo";

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), tailwindcss()],
  // public/ holds only the synthetic demo database, so the local build skips it.
  publicDir: demo ? "public" : false,
  server: {
    port: 5201,
    strictPort: true,
    // The API only answers to its own host name, so rewrite Host on the way through.
    proxy: demo ? undefined : { "/api": { target: "http://127.0.0.1:5202", changeOrigin: true } },
  },
});
