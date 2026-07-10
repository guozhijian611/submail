import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("production serves the copied PDF module worker with a JavaScript MIME type", async () => {
  const [nginxConfig, viteConfig, deployScript] = await Promise.all([
    readFile(new URL("../apps/web/nginx.conf", import.meta.url), "utf8"),
    readFile(new URL("../apps/web/vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../deploy.sh", import.meta.url), "utf8")
  ]);

  assert.match(viteConfig, /fileViewerRenderers\([\s\S]*copyAssets:\s*true/u);
  assert.match(nginxConfig, /location\s+~\*\s+\\\.mjs\$\s*\{[\s\S]*default_type\s+application\/javascript;/u);
  assert.match(deployScript, /PDF_WORKER_HEADERS[\s\S]*Content-Type: application\/javascript/u);
  await access(new URL("../node_modules/pdfjs-dist/build/pdf.worker.mjs", import.meta.url));
});
