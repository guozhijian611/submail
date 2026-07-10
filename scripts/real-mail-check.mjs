import process from "node:process";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  for (const field of ["email", "password", "host", "recipient"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`缺少 ${field}`);
  }
  return value;
}

function safeError(error, password) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(password, "[REDACTED]").slice(0, 600);
}

async function verifyImap(input) {
  const client = new ImapFlow({
    host: input.host,
    port: Number(input.imapPort || 143),
    secure: false,
    doSTARTTLS: true,
    auth: { user: input.email, pass: input.password },
    tls: { servername: input.host, minVersion: "TLSv1.2", ecdhCurve: "X25519:P-256:P-384" },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    logger: false
  });
  try {
    await client.connect();
    const mailbox = await client.mailboxOpen("INBOX");
    return { ok: true, exists: mailbox.exists, uidValidity: mailbox.uidValidity.toString() };
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function smtpTransport(input) {
  return nodemailer.createTransport({
    host: input.host,
    port: Number(input.smtpPort || 25),
    secure: false,
    requireTLS: true,
    auth: { user: input.email, pass: input.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    tls: { servername: input.host, rejectUnauthorized: true, minVersion: "TLSv1.2", ecdhCurve: "X25519:P-256:P-384" }
  });
}

const input = await readInput();
const result = { imap: { ok: false }, smtp: { ok: false }, persisted: false, sent: false, synced: false };

try {
  result.imap = await verifyImap(input);
} catch (error) {
  result.imap = { ok: false, error: safeError(error, input.password) };
}

const transporter = await smtpTransport(input);
try {
  await transporter.verify();
  result.smtp = { ok: true };
} catch (error) {
  result.smtp = { ok: false, error: safeError(error, input.password) };
} finally {
  transporter.close();
}

if (result.imap.ok && result.smtp.ok && input.persist) {
  const { accountRepo, messageRepo } = await import("../apps/api/src/repositories.ts");
  const { sendMail, syncInbox } = await import("../apps/api/src/mail.ts");
  const existing = accountRepo.internalList().find((account) => account.email.toLowerCase() === input.email.toLowerCase());
  const accountInput = {
    email: input.email,
    displayName: input.displayName || "OpenB8 邮件通知",
    username: input.email,
    password: input.password,
    imapHost: input.host,
    imapPort: Number(input.imapPort || 143),
    imapSecure: false,
    smtpHost: input.host,
    smtpPort: Number(input.smtpPort || 25),
    smtpSecure: false
  };
  const saved = existing
    ? accountRepo.update(existing.id, accountInput)
    : accountRepo.create(accountInput);
  if (!saved) throw new Error("邮箱账号保存失败");
  const account = accountRepo.get(saved.id);
  if (!account) throw new Error("邮箱账号保存后无法读取");
  result.accountId = account.id;
  result.persisted = true;

  if (input.sendTest) {
    const now = new Date().toISOString();
    const subject = `Submail 真实 SMTP 接入测试 ${now}`;
    const text = [
      "这是一封由 Submail 项目发出的真实 SMTP 接入测试邮件。",
      `发信账号：${input.email}`,
      `发送时间：${now}`,
      "如果你收到此邮件，说明 SMTP STARTTLS、账号认证和项目发信链路均正常。"
    ].join("\n");
    const sent = await sendMail({ account, to: [input.recipient], subject, text });
    messageRepo.createSent({ account, to: [input.recipient], subject, text }, sent.messageId);
    result.sent = true;
    result.messageId = sent.messageId;
    result.subject = subject;
  }

  if (input.syncInbox) {
    const sync = await syncInbox(account, Number(input.syncLimit || 10));
    result.synced = true;
    result.imported = sync.imported;
    result.cursorUid = sync.cursorUid;
  }
}

process.stdout.write(`${JSON.stringify(result)}\n`);
