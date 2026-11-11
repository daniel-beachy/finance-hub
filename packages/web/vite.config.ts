import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5201,
    strictPort: true,
    // The API only answers to its own host name, so rewrite Host on the way through.
    proxy: { "/api": { target: "http://127.0.0.1:5202", changeOrigin: true } },
  },
});
