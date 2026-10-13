import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` serves the app on 5173 and sends API calls to a console started with `npm start -- --port 7013`.
// Open http://127.0.0.1:7013/?key=… once first so the cookie is set for 127.0.0.1.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: {
    host: "127.0.0.1",
    proxy: { "/f/": "http://127.0.0.1:7013", "/console/": "http://127.0.0.1:7013" },
  },
});
