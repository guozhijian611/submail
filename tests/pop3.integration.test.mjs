import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function request(baseUrl, route, init = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) }
  });
  const raw = await response.text();
  return { response, body: raw ? JSON.parse(raw) : undefined };
}

async function waitForHealth(baseUrl, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited early with code ${child.exitCode}\n${output()}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`API did not become healthy\n${output()}`);
}

function createPop3Server(expectedPassword) {
  const source = [
    "From: Sender <sender@example.com>",
    "To: pop-user@example.com",
    "Message-ID: <pop-test-1@example.com>",
    "Date: Fri, 10 Jul 2026 08:00:00 +0000",
    "Subject: POP3 integration message",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello from the POP3 integration test."
  ].join("\r\n");
  const passwords = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.write("+OK Submail POP3 test server ready\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\r\n")) {
        const index = buffer.indexOf("\r\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const [command = "", ...parts] = line.split(" ");
        const argument = parts.join(" ");
        switch (command.toUpperCase()) {
          case "USER": socket.write("+OK user accepted\r\n"); break;
          case "PASS":
            passwords.push(argument);
            socket.write(argument === expectedPassword ? "+OK authenticated\r\n" : "-ERR authentication failed\r\n");
            break;
          case "UIDL": socket.write("+OK unique-id listing follows\r\n1 uidl-pop-test-1\r\n.\r\n"); break;
          case "RETR": socket.write(`+OK ${Buffer.byteLength(source)} octets\r\n${source}\r\n.\r\n`); break;
          case "QUIT": socket.end("+OK goodbye\r\n"); break;
          default: socket.write("-ERR unsupported command\r\n");
        }
      }
    });
  });
  return { server, passwords };
}

test("POP3 sync uses app-password normalization and UIDL deduplication", { timeout: 30_000 }, async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "submail-pop3-test-"));
  const apiPort = await freePort();
  const { server: pop3Server, passwords } = createPop3Server("abcd1234efgh5678");
  pop3Server.listen(0, "127.0.0.1");
  await once(pop3Server, "listening");
  const pop3Address = pop3Server.address();
  assert(pop3Address && typeof pop3Address === "object");

  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      SUBMAIL_HOST: "127.0.0.1",
      SUBMAIL_PORT: String(apiPort),
      SUBMAIL_DB_PATH: path.join(tempDir, "submail.sqlite"),
      SUBMAIL_QUEUE_DRIVER: "memory",
      SUBMAIL_STORAGE_DIR: path.join(tempDir, "storage"),
      SUBMAIL_SECRET: "test-secret-abcdefghijklmnopqrstuvwxyz-0123456789",
      SUBMAIL_DEMO_MODE: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    pop3Server.close();
    await once(pop3Server, "close");
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${apiPort}`;
  await waitForHealth(baseUrl, child, () => output);
  const setup = await request(baseUrl, "/api/setup/admin", {
    method: "POST",
    body: JSON.stringify({ name: "Owner", email: "owner@example.com", password: "owner123" })
  });
  assert.equal(setup.response.status, 201, JSON.stringify(setup.body));
  const headers = { authorization: `Bearer ${setup.body.session.token}` };
  const created = await request(baseUrl, "/api/accounts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: "pop-user@example.com",
      displayName: "POP User",
      username: "pop-user@example.com",
      password: "abcd 1234 efgh 5678",
      incomingProtocol: "pop3",
      authMode: "app_password",
      imapHost: "127.0.0.1",
      imapPort: pop3Address.port,
      imapSecure: false,
      smtpHost: "smtp.invalid",
      smtpPort: 465,
      smtpSecure: true
    })
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.account.incoming_protocol, "pop3");
  assert.equal(created.body.account.auth_mode, "app_password");

  const accountId = created.body.account.id;
  const firstSync = await request(baseUrl, `/api/accounts/${accountId}/sync`, { method: "POST", headers });
  assert.equal(firstSync.response.status, 200, `${JSON.stringify(firstSync.body)}\n${output}`);
  assert.equal(firstSync.body.imported, 1);
  assert.equal(passwords[0], "abcd1234efgh5678");

  const secondSync = await request(baseUrl, `/api/accounts/${accountId}/sync`, { method: "POST", headers });
  assert.equal(secondSync.response.status, 200, JSON.stringify(secondSync.body));
  assert.equal(secondSync.body.imported, 0);

  const messages = await request(baseUrl, `/api/messages?accountId=${accountId}`, { headers });
  assert.equal(messages.response.status, 200, JSON.stringify(messages.body));
  assert.equal(messages.body.messages.length, 1);
  assert.equal(messages.body.messages[0].subject, "POP3 integration message");
});
