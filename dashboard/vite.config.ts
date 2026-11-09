import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = "http://127.0.0.1:5199";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": target, "/events": target },
  },
});
