import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  server.close();
  await once(server, "close");
  return address.port;
}

async function waitForHealth(baseUrl, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`MCP exited early\n${output()}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`MCP did not become healthy\n${output()}`);
}

test("HTTP MCP derives same-origin access from the reverse-proxy host without an allowlist", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "apps/mcp/src/index.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SUBMAIL_MCP_TRANSPORT: "http",
      SUBMAIL_MCP_HOST: "127.0.0.1",
      SUBMAIL_MCP_PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child, () => output);

  const sameOrigin = await fetch(`${baseUrl}/mcp`, {
    method: "OPTIONS",
    headers: {
      origin: "https://mail.example.com",
      "x-forwarded-host": "mail.example.com"
    }
  });
  assert.equal(sameOrigin.status, 204);
  assert.equal(sameOrigin.headers.get("access-control-allow-origin"), "https://mail.example.com");

  const crossOrigin = await fetch(`${baseUrl}/mcp`, {
    method: "OPTIONS",
    headers: {
      origin: "https://untrusted.example",
      "x-forwarded-host": "mail.example.com"
    }
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get("access-control-allow-origin"), null);
});
