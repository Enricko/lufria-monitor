import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Lowering xterm 6's prebuilt ESM below ES2021 corrupts requestMode and
  // freezes terminal output on OpenCode/vim capability queries (xtermjs#5800).
  build: { target: "es2022" },
  server: {
    host: true,
    proxy: {
      "/api": "http://localhost:8090",
      "/ws": { target: "ws://localhost:8090", ws: true },
    },
  },
});
