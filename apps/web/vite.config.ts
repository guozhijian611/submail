import react from "@vitejs/plugin-react";
import { fileViewerRenderers } from "@file-viewer/vite-plugin";
import { defineConfig } from "vite";

const apiTarget = process.env.VITE_DEV_API_TARGET ?? "http://127.0.0.1:8787";
const mcpTarget = process.env.VITE_DEV_MCP_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [
    react(),
    fileViewerRenderers({ preset: "all", copyAssets: true, chunkStrategy: "renderer", missingRenderer: "warn" })
  ],
  define: {
    "import.meta.env.VITE_API_BASE_URL": JSON.stringify(process.env.VITE_API_BASE_URL ?? "")
  },
  server: {
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false
      },
      "/health": {
        target: apiTarget,
        changeOrigin: false
      },
      "/mcp": {
        target: mcpTarget,
        changeOrigin: false,
        timeout: 10 * 60_000,
        proxyTimeout: 10 * 60_000
      }
    }
  }
});
