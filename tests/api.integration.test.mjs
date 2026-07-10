import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";

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

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("API did not become healthy");
}

async function request(baseUrl, route, init = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {})
    }
  });
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    body = raw;
  }
  return { response, body };
}

test("production bootstrap, auth, secret storage and API key scopes", { timeout: 30_000 }, async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "submail-api-test-"));
  const port = await freePort();
  const providerRequests = [];
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      providerRequests.push({ url: req.url, authorization: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/chat/completions") {
        const system = String(body.messages?.[0]?.content ?? "");
        const content = system.includes("JSON 对象")
          ? JSON.stringify({ subject: "自动生成主题", text: "自动生成正文" })
          : "连接成功";
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        return;
      }
      if (req.url === "/translate") {
        res.end(JSON.stringify({ translatedText: "你好，Submail！" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const providerAddress = provider.address();
  assert(providerAddress && typeof providerAddress === "object");
  const providerBaseUrl = `http://127.0.0.1:${providerAddress.port}`;
  const deliveredMessages = [];
  const smtpServer = new SMTPServer({
    secure: true,
    authOptional: false,
    logger: false,
    onAuth(_auth, _session, callback) {
      callback(null, { user: "test" });
    },
    onRcptTo(address, _session, callback) {
      if (address.address.toLowerCase() === "reject@example.com") {
        callback(Object.assign(new Error("recipient rejected"), { responseCode: 550 }));
        return;
      }
      callback();
    },
    onData(stream, _session, callback) {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.includes("permanent-reject")) {
          callback(Object.assign(new Error("mailbox rejected"), { responseCode: 550 }));
          return;
        }
        deliveredMessages.push(raw);
        callback();
      });
    }
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    smtpServer.once("error", onError);
    smtpServer.listen(0, "127.0.0.1", () => {
      smtpServer.off("error", onError);
      resolve();
    });
  });
  const smtpAddress = smtpServer.server.address();
  assert(smtpAddress && typeof smtpAddress === "object");
  const databasePath = path.join(tempDir, "submail.sqlite");
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      SUBMAIL_HOST: "127.0.0.1",
      SUBMAIL_PORT: String(port),
      SUBMAIL_DB_PATH: databasePath,
      SUBMAIL_QUEUE_DRIVER: "memory",
      SUBMAIL_STORAGE_DIR: path.join(tempDir, "storage"),
      SUBMAIL_SECRET: "test-secret-abcdefghijklmnopqrstuvwxyz-0123456789",
      SUBMAIL_DEMO_MODE: "false",
      NODE_TLS_REJECT_UNAUTHORIZED: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    await fs.rm(tempDir, { recursive: true, force: true });
    provider.close();
    await once(provider, "close");
    await new Promise((resolve) => smtpServer.close(resolve));
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl, child);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\n${output}`);
  }

  const schemaDb = new Database(databasePath, { readonly: true });
  assert.equal(schemaDb.pragma("user_version", { simple: true }), 6);
  const cursorColumns = new Set(schemaDb.pragma("table_info(mailbox_sync_cursors)").map((column) => column.name));
  assert(cursorColumns.has("backfill_before_uid"));
  assert(cursorColumns.has("backfill_complete"));
  schemaDb.close();

  const setupStatus = await request(baseUrl, "/api/setup/status");
  assert.equal(setupStatus.response.status, 200);
  assert.equal(setupStatus.body.requiresSetup, true);
  assert.equal(setupStatus.body.databaseDriver, "sqlite");

  const setup = await request(baseUrl, "/api/setup/admin", {
    method: "POST",
    body: JSON.stringify({
      name: "Owner",
      email: "owner@example.com",
      password: "owner123"
    })
  });
  assert.equal(setup.response.status, 201, JSON.stringify(setup.body));
  const sessionToken = setup.body.session.token;
  assert.match(sessionToken, /^sess_/);
  const adminHeaders = { authorization: `Bearer ${sessionToken}` };

  const repeatedSetup = await request(baseUrl, "/api/setup/admin", {
    method: "POST",
    body: JSON.stringify({
      name: "Second Owner",
      email: "second-owner@example.com",
      password: "owner456"
    })
  });
  assert.equal(repeatedSetup.response.status, 409, JSON.stringify(repeatedSetup.body));

  const accounts = await request(baseUrl, "/api/accounts", { headers: adminHeaders });
  assert.equal(accounts.response.status, 200);
  assert.deepEqual(accounts.body.accounts, []);

  const createdAccount = await request(baseUrl, "/api/accounts", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      email: "sender@example.com",
      displayName: "Sender",
      username: "sender@example.com",
      password: "smtp-password",
      imapHost: "\u00a0imap.invalid\u200b",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "\u00a0127.0.0.1\u200b",
      smtpPort: smtpAddress.port,
      smtpSecure: true
    })
  });
  assert.equal(createdAccount.response.status, 201, JSON.stringify(createdAccount.body));
  assert.equal(createdAccount.body.account.imap_host, "imap.invalid");
  assert.equal(createdAccount.body.account.smtp_host, "127.0.0.1");
  const accountId = createdAccount.body.account.id;

  const updatedAccount = await request(baseUrl, `/api/accounts/${accountId}`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({
      email: " sender@example.com ",
      displayName: " Sender ",
      notes: "Primary support mailbox",
      aliases: ["support@example.com", "billing@example.com"],
      username: " sender@example.com ",
      imapHost: "\u00a0imap.invalid\u200b",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "\u00a0127.0.0.1\u200b",
      smtpPort: smtpAddress.port,
      smtpSecure: true
    })
  });
  assert.equal(updatedAccount.response.status, 200, JSON.stringify(updatedAccount.body));
  assert.equal(updatedAccount.body.account.email, "sender@example.com");
  assert.equal(updatedAccount.body.account.imap_host, "imap.invalid");
  assert.equal(updatedAccount.body.account.smtp_host, "127.0.0.1");
  assert.equal(updatedAccount.body.account.notes, "Primary support mailbox");
  assert.deepEqual(updatedAccount.body.account.aliases.map((alias) => alias.email), ["support@example.com", "billing@example.com"]);
  assert(updatedAccount.body.account.aliases.every((alias) => alias.verification_status === "unverified"));
  const supportAliasId = updatedAccount.body.account.aliases[0].id;

  const deniedUnverifiedAlias = await request(baseUrl, "/api/send", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      accountId,
      fromAliasId: supportAliasId,
      to: ["receiver@example.com"],
      subject: "unverified alias must fail",
      text: "must not send"
    })
  });
  assert.equal(deniedUnverifiedAlias.response.status, 422, JSON.stringify(deniedUnverifiedAlias.body));
  assert.equal(deliveredMessages.length, 0);

  const permanentRejection = await request(baseUrl, "/api/send", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      accountId,
      to: ["receiver@example.com"],
      subject: "permanent-reject",
      text: "must not be retried"
    })
  });
  assert.equal(permanentRejection.response.status, 422, JSON.stringify(permanentRejection.body));
  assert.equal(permanentRejection.body.retryable, false);
  assert.equal(deliveredMessages.length, 0);

  const savedAi = await request(baseUrl, "/api/admin/ai-settings", {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({
      enabled: true,
      baseUrl: `${providerBaseUrl}/v1`,
      model: "example-model",
      temperature: 0.2,
      systemPrompt: "test",
      apiKey: "secret-provider-key"
    })
  });
  assert.equal(savedAi.response.status, 200, JSON.stringify(savedAi.body));
  assert.equal(savedAi.body.settings.api_key_configured, true);
  assert.equal("api_key" in savedAi.body.settings, false);
  assert.equal(JSON.stringify(savedAi.body).includes("secret-provider-key"), false);

  const aiTest = await request(baseUrl, "/api/admin/ai-settings/test", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({})
  });
  assert.equal(aiTest.response.status, 200, JSON.stringify(aiTest.body));
  assert.equal(aiTest.body.response, "连接成功");

  const composed = await request(baseUrl, "/api/ai/compose", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ prompt: "写一封测试邮件" })
  });
  assert.equal(composed.response.status, 200, JSON.stringify(composed.body));
  assert.deepEqual(composed.body, { subject: "自动生成主题", text: "自动生成正文" });

  const translationSettings = await request(baseUrl, "/api/admin/translation-settings", {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({
      enabled: true,
      provider: "custom",
      endpoint: `${providerBaseUrl}/translate`,
      defaultTargetLanguage: "zh-CN",
      apiKey: "translation-provider-key"
    })
  });
  assert.equal(translationSettings.response.status, 200, JSON.stringify(translationSettings.body));
  assert.equal(translationSettings.body.settings.api_key_configured, true);

  const translated = await request(baseUrl, "/api/translate", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ text: "Hello, Submail!", targetLanguage: "zh-CN" })
  });
  assert.equal(translated.response.status, 200, JSON.stringify(translated.body));
  assert.equal(translated.body.text, "你好，Submail！");
  assert(providerRequests.some((item) => item.url === "/v1/chat/completions" && item.authorization === "Bearer secret-provider-key"));
  assert(providerRequests.some((item) => item.url === "/translate" && item.authorization === "Bearer translation-provider-key"));

  const createdKey = await request(baseUrl, "/api/admin/api-keys", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      name: "read only",
      scopes: ["mcp:accounts:read", "mcp:mail:read"],
      dailySendLimit: 1
    })
  });
  assert.equal(createdKey.response.status, 201, JSON.stringify(createdKey.body));
  const apiKey = createdKey.body.apiKey.key;
  assert.match(apiKey, /^sk_submail_/);

  const keyAccounts = await request(baseUrl, "/api/accounts", {
    headers: { "x-submail-api-key": apiKey }
  });
  assert.equal(keyAccounts.response.status, 200);

  const deniedSend = await request(baseUrl, "/api/send", {
    method: "POST",
    headers: { "x-submail-api-key": apiKey },
    body: JSON.stringify({
      accountId: "missing",
      to: ["receiver@example.com"],
      subject: "test",
      text: "test"
    })
  });
  assert.equal(deniedSend.response.status, 403);

  const sendKeyResult = await request(baseUrl, "/api/admin/api-keys", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      name: "api send",
      scopes: ["mcp:mail:send"],
      accountIds: [accountId],
      dailySendLimit: 1
    })
  });
  assert.equal(sendKeyResult.response.status, 201, JSON.stringify(sendKeyResult.body));
  const sendKey = sendKeyResult.body.apiKey.key;
  const sendPayload = JSON.stringify({
    accountId,
    to: ["receiver@example.com"],
    subject: "idempotency test",
    text: "hello"
  });
  const sent = await request(baseUrl, "/api/send", {
    method: "POST",
    headers: { authorization: `Bearer ${sendKey}`, "idempotency-key": "test-send-0001" },
    body: sendPayload
  });
  assert.equal(sent.response.status, 200, JSON.stringify(sent.body));
  assert.equal(deliveredMessages.length, 1);

  const messagePage = await request(baseUrl, "/api/messages?folder=SENT&page=1&pageSize=1", { headers: adminHeaders });
  assert.equal(messagePage.response.status, 200, JSON.stringify(messagePage.body));
  assert.equal(messagePage.body.messages.length, 1);
  assert.equal(messagePage.body.pagination.page, 1);
  assert.equal(messagePage.body.pagination.pageSize, 1);
  assert.equal(messagePage.body.pagination.total >= 1, true);
  assert.equal(typeof messagePage.body.unreadTotal, "number");

  const bulkRead = await request(baseUrl, "/api/messages/bulk-state", {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ ids: [sent.body.message.id], state: { isRead: true } })
  });
  assert.equal(bulkRead.response.status, 200, JSON.stringify(bulkRead.body));
  assert.equal(bulkRead.body.updated, 1);
  assert.equal(bulkRead.body.messages[0].is_read, 1);

  const bulkTrash = await request(baseUrl, "/api/messages/bulk-state", {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ ids: [sent.body.message.id], state: { isDeleted: true } })
  });
  assert.equal(bulkTrash.response.status, 200, JSON.stringify(bulkTrash.body));
  assert.equal(bulkTrash.body.messages[0].is_deleted, 1);

  const bulkRestore = await request(baseUrl, "/api/messages/bulk-state", {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ ids: [sent.body.message.id], state: { isDeleted: false } })
  });
  assert.equal(bulkRestore.response.status, 200, JSON.stringify(bulkRestore.body));
  assert.equal(bulkRestore.body.messages[0].is_deleted, 0);

  const rawAttachedEmail = Buffer.from([
    "From: Original Sender <original@example.com>",
    "To: receiver@example.com",
    "Subject: Attached original email",
    "Date: Thu, 10 Jul 2026 08:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "This is the attached original message."
  ].join("\r\n"));
  const attachmentId = "test-rfc822-attachment";
  const directDb = new Database(databasePath);
  directDb.prepare(`
    INSERT INTO attachments (id, message_id, filename, content_type, size, content_id, content_blob, storage_path, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?)
  `).run(attachmentId, sent.body.message.id, "attachment", "message/rfc822", rawAttachedEmail.length, rawAttachedEmail, new Date().toISOString());
  directDb.prepare(`
    INSERT INTO attachments (id, message_id, filename, content_type, size, content_id, content_blob, storage_path, created_at)
    VALUES ('expired-attachment', ?, 'expired.txt', 'text/plain', 7, NULL, ?, NULL, '2000-01-01T00:00:00.000Z')
  `).run(sent.body.message.id, Buffer.from("expired"));
  directDb.prepare(`INSERT INTO sync_runs (id, account_id, trigger_type, status, imported, error, attempts, next_retry_at, started_at, finished_at)
    VALUES ('manual-delete-run', ?, 'manual', 'ok', 0, NULL, 1, NULL, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:01.000Z')`).run(accountId);
  directDb.prepare(`INSERT INTO sync_runs (id, account_id, trigger_type, status, imported, error, attempts, next_retry_at, started_at, finished_at)
    VALUES ('expired-sync-run', ?, 'scheduled', 'ok', 0, NULL, 1, NULL, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:01.000Z')`).run(accountId);
  const threadMessageId = "test-thread-inbound";
  directDb.prepare(`
    INSERT INTO messages (
      id, account_id, folder, uid, message_id, in_reply_to, subject, sender_name, sender_email,
      recipients, snippet, text_body, html_body, sent_at, flags, is_read, is_starred, is_archived, is_deleted,
      created_at, updated_at
    ) VALUES (?, ?, 'INBOX', NULL, ?, ?, ?, 'Receiver', 'receiver@example.com', ?, ?, ?, NULL, ?, '[]', 0, 0, 0, 0, ?, ?)
  `).run(
    threadMessageId,
    accountId,
    "<thread-inbound@example.com>",
    sent.body.messageId,
    "Re: idempotency test",
    JSON.stringify(["sender@example.com"]),
    "reply body",
    "reply body",
    new Date().toISOString(),
    new Date().toISOString(),
    new Date().toISOString()
  );
  const fallbackThreadMessageId = "test-thread-fallback-inbound";
  directDb.prepare(`
    INSERT INTO messages (
      id, account_id, folder, uid, message_id, in_reply_to, subject, sender_name, sender_email,
      recipients, snippet, text_body, html_body, sent_at, flags, is_read, is_starred, is_archived, is_deleted,
      created_at, updated_at
    ) VALUES (?, ?, 'INBOX', NULL, ?, NULL, ?, 'Receiver', 'receiver@example.com', ?, ?, ?, NULL, ?, '[]', 0, 0, 0, 0, ?, ?)
  `).run(
    fallbackThreadMessageId,
    accountId,
    "<thread-fallback@example.com>",
    "Re: idempotency test",
    JSON.stringify(["support@example.com"]),
    "fallback reply body",
    "fallback reply body",
    new Date().toISOString(),
    new Date().toISOString(),
    new Date().toISOString()
  );
  directDb.close();

  const threadView = await request(baseUrl, `/api/messages/${sent.body.message.id}/thread`, { headers: adminHeaders });
  assert.equal(threadView.response.status, 200, JSON.stringify(threadView.body));
  assert.equal(threadView.body.messages.some((message) => message.id === threadMessageId), true);
  assert.equal(threadView.body.messages.some((message) => message.id === fallbackThreadMessageId), true);

  const attachmentPreview = await request(baseUrl, `/api/attachments/${attachmentId}/preview`, { headers: adminHeaders });
  assert.equal(attachmentPreview.response.status, 200, JSON.stringify(attachmentPreview.body));
  assert.equal(attachmentPreview.body.preview.previewType, "email");
  assert.equal(attachmentPreview.body.preview.email.subject, "Attached original email");
  assert.match(attachmentPreview.body.preview.email.text, /attached original message/);

  const attachmentContent = await fetch(`${baseUrl}/api/attachments/${attachmentId}/content`, { headers: adminHeaders });
  assert.equal(attachmentContent.status, 200);
  assert.match(attachmentContent.headers.get("content-type") ?? "", /message\/rfc822/);
  assert.equal((await attachmentContent.arrayBuffer()).byteLength, rawAttachedEmail.length);

  const attachmentPage = await request(baseUrl, "/api/attachments?page=1&pageSize=1", { headers: adminHeaders });
  assert.equal(attachmentPage.response.status, 200, JSON.stringify(attachmentPage.body));
  assert.equal(attachmentPage.body.attachments.length, 1);
  assert.equal(attachmentPage.body.pagination.pageSize, 1);
  assert.equal(attachmentPage.body.pagination.total >= 1, true);

  const syncRunPage = await request(baseUrl, "/api/admin/sync-runs?page=1&pageSize=5", { headers: adminHeaders });
  assert.equal(syncRunPage.response.status, 200, JSON.stringify(syncRunPage.body));
  assert.equal(syncRunPage.body.pagination.page, 1);
  assert.equal(syncRunPage.body.pagination.pageSize, 5);

  const syncSettingsUpdate = await request(baseUrl, "/api/admin/sync-settings", {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({
      enabled: false,
      intervalMinutes: 15,
      initialLimit: 30,
      retryMaxAttempts: 1,
      retryDelayMinutes: 5,
      concurrencyLimit: 2,
      retentionDays: 45
    })
  });
  assert.equal(syncSettingsUpdate.response.status, 200, JSON.stringify(syncSettingsUpdate.body));
  assert.equal(syncSettingsUpdate.body.settings.retention_days, 45);

  const defaultEmailDisplaySettings = await request(baseUrl, "/api/admin/email-display-settings", { headers: adminHeaders });
  assert.equal(defaultEmailDisplaySettings.response.status, 200, JSON.stringify(defaultEmailDisplaySettings.body));
  assert.equal(defaultEmailDisplaySettings.body.settings.load_external_resources_by_default, false);
  const emailDisplaySettingsUpdate = await request(baseUrl, "/api/admin/email-display-settings", {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ loadExternalResourcesByDefault: true })
  });
  assert.equal(emailDisplaySettingsUpdate.response.status, 200, JSON.stringify(emailDisplaySettingsUpdate.body));
  assert.equal(emailDisplaySettingsUpdate.body.settings.load_external_resources_by_default, true);
  const savedEmailDisplaySettings = await request(baseUrl, "/api/admin/email-display-settings", { headers: adminHeaders });
  assert.equal(savedEmailDisplaySettings.body.settings.load_external_resources_by_default, true);

  const deletedSyncRun = await request(baseUrl, "/api/admin/sync-runs/manual-delete-run", { method: "DELETE", headers: adminHeaders });
  assert.equal(deletedSyncRun.response.status, 200, JSON.stringify(deletedSyncRun.body));
  const cleanedSyncRuns = await request(baseUrl, "/api/admin/sync-runs/cleanup", { method: "POST", headers: adminHeaders });
  assert.equal(cleanedSyncRuns.response.status, 200, JSON.stringify(cleanedSyncRuns.body));
  assert.equal(cleanedSyncRuns.body.deleted >= 1, true);

  const attachmentSettings = await request(baseUrl, "/api/admin/attachment-settings", {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ maxSizeMb: 10, retentionDays: 30 })
  });
  assert.equal(attachmentSettings.response.status, 200, JSON.stringify(attachmentSettings.body));
  assert.equal(attachmentSettings.body.settings.retention_days, 30);
  const cleanedAttachments = await request(baseUrl, "/api/admin/attachments/cleanup", { method: "POST", headers: adminHeaders });
  assert.equal(cleanedAttachments.response.status, 200, JSON.stringify(cleanedAttachments.body));
  assert.equal(cleanedAttachments.body.deleted, 1);

  const replayed = await request(baseUrl, "/api/send", {
    method: "POST",
    headers: { "x-submail-api-key": sendKey, "idempotency-key": "test-send-0001" },
    body: sendPayload
  });
  assert.equal(replayed.response.status, 200, JSON.stringify(replayed.body));
  assert.equal(replayed.response.headers.get("x-idempotent-replay"), "true");
  assert.equal(deliveredMessages.length, 1);

  const conflictingReplay = await request(baseUrl, "/api/send", {
    method: "POST",
    headers: { "x-submail-api-key": sendKey, "idempotency-key": "test-send-0001" },
    body: JSON.stringify({ ...JSON.parse(sendPayload), subject: "different request" })
  });
  assert.equal(conflictingReplay.response.status, 422, JSON.stringify(conflictingReplay.body));
  assert.equal(deliveredMessages.length, 1);

  const quotaRejected = await request(baseUrl, "/api/send", {
    method: "POST",
    headers: { "x-submail-api-key": sendKey, "idempotency-key": "test-send-0002" },
    body: sendPayload
  });
  assert.equal(quotaRejected.response.status, 429, JSON.stringify(quotaRejected.body));
  assert.equal(deliveredMessages.length, 1);

  const persistenceFailureKeyResult = await request(baseUrl, "/api/admin/api-keys", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      name: "post smtp persistence",
      scopes: ["mcp:mail:send"],
      accountIds: [accountId],
      dailySendLimit: 1
    })
  });
  assert.equal(persistenceFailureKeyResult.response.status, 201, JSON.stringify(persistenceFailureKeyResult.body));
  const persistenceFailureKey = persistenceFailureKeyResult.body.apiKey.key;
  const faultDb = new Database(databasePath);
  faultDb.exec(`
    CREATE TRIGGER force_sent_insert_failure
    BEFORE INSERT ON messages
    WHEN NEW.folder = 'Sent'
    BEGIN
      SELECT RAISE(FAIL, 'forced sent persistence failure');
    END;
  `);
  faultDb.close();
  const faultPayload = JSON.stringify({
    accountId,
    to: ["receiver@example.com"],
    subject: "post smtp persistence test",
    text: "accepted once"
  });
  const acceptedWithoutLocalRecord = await request(baseUrl, "/api/send", {
    method: "POST",
    headers: { "x-submail-api-key": persistenceFailureKey, "idempotency-key": "post-smtp-fault-0001" },
    body: faultPayload
  });
  assert.equal(acceptedWithoutLocalRecord.response.status, 202, JSON.stringify(acceptedWithoutLocalRecord.body));
  assert.equal(acceptedWithoutLocalRecord.body.localRecordSaved, false);
  assert.equal(deliveredMessages.length, 2);

  const repairDb = new Database(databasePath);
  repairDb.exec("DROP TRIGGER force_sent_insert_failure");
  repairDb.close();
  const replayAfterLocalFailure = await request(baseUrl, "/api/send", {
    method: "POST",
    headers: { "x-submail-api-key": persistenceFailureKey, "idempotency-key": "post-smtp-fault-0001" },
    body: faultPayload
  });
  assert.equal(replayAfterLocalFailure.response.status, 200, JSON.stringify(replayAfterLocalFailure.body));
  assert.equal(replayAfterLocalFailure.response.headers.get("x-idempotent-replay"), "true");
  assert.equal(replayAfterLocalFailure.body.localRecordSaved, false);
  assert.equal(deliveredMessages.length, 2);

  const quotaStillConsumed = await request(baseUrl, "/api/send", {
    method: "POST",
    headers: { "x-submail-api-key": persistenceFailureKey, "idempotency-key": "post-smtp-fault-0002" },
    body: faultPayload
  });
  assert.equal(quotaStillConsumed.response.status, 429, JSON.stringify(quotaStillConsumed.body));
  assert.equal(deliveredMessages.length, 2);

  const partialDelivery = await request(baseUrl, "/api/send", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      accountId,
      to: ["accepted@example.com", "reject@example.com"],
      subject: "partial delivery test",
      text: "one accepted, one rejected"
    })
  });
  assert.equal(partialDelivery.response.status, 200, JSON.stringify(partialDelivery.body));
  assert.equal(partialDelivery.body.partialDelivery, true);
  assert.deepEqual(partialDelivery.body.accepted, ["accepted@example.com"]);
  assert.deepEqual(partialDelivery.body.rejected, ["reject@example.com"]);
  assert.equal(deliveredMessages.length, 3);
  const partialDb = new Database(databasePath, { readonly: true });
  const partialRow = partialDb.prepare("SELECT recipients FROM messages WHERE subject = ?").get("partial delivery test");
  partialDb.close();
  assert.deepEqual(JSON.parse(partialRow.recipients), ["accepted@example.com"]);

  const verification = await request(baseUrl, `/api/accounts/${accountId}/aliases/${supportAliasId}/verification`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({})
  });
  assert.equal(verification.response.status, 200, JSON.stringify(verification.body));
  assert.equal(verification.body.alias.verification_status, "pending");
  assert.equal(deliveredMessages.length, 4);
  const verificationMail = await simpleParser(deliveredMessages.at(-1));
  const verificationCode = verificationMail.text?.match(/\b\d{6}\b/)?.[0];
  assert.match(verificationCode ?? "", /^\d{6}$/);
  const confirmedAlias = await request(baseUrl, `/api/accounts/${accountId}/aliases/${supportAliasId}/verification/confirm`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ code: verificationCode })
  });
  assert.equal(confirmedAlias.response.status, 200, JSON.stringify(confirmedAlias.body));
  assert.equal(confirmedAlias.body.alias.verification_status, "verified");

  const enabledAliasAccount = await request(baseUrl, `/api/accounts/${accountId}`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({
      email: "sender@example.com",
      displayName: "Sender",
      notes: "Primary support mailbox",
      aliases: [
        { id: supportAliasId, email: "support@example.com", displayName: "Support", replyTo: "sender@example.com", sendEnabled: true },
        { id: updatedAccount.body.account.aliases[1].id, email: "billing@example.com", displayName: "", replyTo: "", sendEnabled: false }
      ],
      username: "sender@example.com",
      imapHost: "imap.invalid",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "127.0.0.1",
      smtpPort: smtpAddress.port,
      smtpSecure: true
    })
  });
  assert.equal(enabledAliasAccount.response.status, 200, JSON.stringify(enabledAliasAccount.body));
  assert.equal(enabledAliasAccount.body.account.aliases[0].send_enabled, true);
  assert.equal(enabledAliasAccount.body.account.aliases[0].verification_status, "verified");

  const sentFromAlias = await request(baseUrl, "/api/send", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      accountId,
      fromAliasId: supportAliasId,
      to: ["receiver@example.com"],
      subject: "verified alias sender",
      text: "sent as verified alias"
    })
  });
  assert.equal(sentFromAlias.response.status, 200, JSON.stringify(sentFromAlias.body));
  assert.equal(sentFromAlias.body.message.sender_email, "support@example.com");
  assert.equal(deliveredMessages.length, 5);

  const noAccountKeyResult = await request(baseUrl, "/api/admin/api-keys", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ name: "no accounts", scopes: ["mcp:accounts:read"], accountIds: [] })
  });
  assert.equal(noAccountKeyResult.response.status, 201, JSON.stringify(noAccountKeyResult.body));
  const noAccountList = await request(baseUrl, "/api/accounts", {
    headers: { "x-submail-api-key": noAccountKeyResult.body.apiKey.key }
  });
  assert.deepEqual(noAccountList.body.accounts, []);

  child.kill("SIGTERM");
  await once(child, "exit");
  const restartPort = await freePort();
  const restarted = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      SUBMAIL_HOST: "127.0.0.1",
      SUBMAIL_PORT: String(restartPort),
      SUBMAIL_DB_PATH: databasePath,
      SUBMAIL_QUEUE_DRIVER: "memory",
      SUBMAIL_STORAGE_DIR: path.join(tempDir, "storage"),
      SUBMAIL_SECRET: "test-secret-abcdefghijklmnopqrstuvwxyz-0123456789",
      SUBMAIL_DEMO_MODE: "false",
      NODE_TLS_REJECT_UNAUTHORIZED: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let restartOutput = "";
  restarted.stdout.on("data", (chunk) => { restartOutput += chunk.toString(); });
  restarted.stderr.on("data", (chunk) => { restartOutput += chunk.toString(); });
  try {
    await waitForHealth(`http://127.0.0.1:${restartPort}`, restarted);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\n${restartOutput}`);
  }
  restarted.kill("SIGTERM");
  await once(restarted, "exit");
});

test("production rejects public example secrets", { timeout: 10_000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "submail-config-test-"));
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      SUBMAIL_DB_PATH: path.join(tempDir, "submail.sqlite"),
      SUBMAIL_QUEUE_DRIVER: "memory",
      SUBMAIL_STORAGE_DIR: path.join(tempDir, "storage"),
      SUBMAIL_SECRET: "change-me-to-a-long-random-secret"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const [code] = await once(child, "exit");
  await fs.rm(tempDir, { recursive: true, force: true });
  assert.notEqual(code, 0);
  assert.match(output, /生产环境必须设置至少 32 字符/);
});
