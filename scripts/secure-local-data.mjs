import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const projectRoot = path.resolve(import.meta.dirname, "..");
const apiDir = path.join(projectRoot, "apps", "api");
const envPath = path.join(apiDir, ".env");
const databasePath = path.join(apiDir, "data", "submail.sqlite");
const legacyDevelopmentSecret = "dev-secret-change-me";
const secretAad = Buffer.from("submail-secret:v1", "utf8");

function secretKey(secret) {
  return crypto.createHash("sha256").update(secret).digest();
}

function fingerprint(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex").slice(0, 24);
}

function decryptSecret(value, secret) {
  const versioned = value.startsWith("v1.");
  const payload = Buffer.from(versioned ? value.slice(3) : value, "base64url");
  if (payload.length < 29) throw new Error("存在无法识别的加密凭据，未修改任何数据");
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(secret), payload.subarray(0, 12));
  if (versioned) decipher.setAAD(secretAad);
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
}

function encryptSecret(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(secret), iv);
  cipher.setAAD(secretAad);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
}

function readEnvSecret() {
  if (!fs.existsSync(envPath)) return undefined;
  const line = fs.readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((item) => item.startsWith("SUBMAIL_SECRET="));
  const value = line?.slice("SUBMAIL_SECRET=".length).trim();
  if (!value || value.length < 32) throw new Error("apps/api/.env 中的 SUBMAIL_SECRET 必须至少 32 字符");
  return value;
}

function writeEnvAtomically(secret) {
  fs.mkdirSync(apiDir, { recursive: true, mode: 0o700 });
  const temporaryPath = `${envPath}.tmp-${process.pid}-${Date.now()}`;
  const existingLines = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8").split(/\r?\n/).filter((line) => line && !line.startsWith("SUBMAIL_SECRET="))
    : [];
  const content = [`SUBMAIL_SECRET=${secret}`, ...existingLines, ""].join("\n");
  fs.writeFileSync(temporaryPath, content, { mode: 0o600, flag: "wx" });
  const fd = fs.openSync(temporaryPath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporaryPath, envPath);
  fs.chmodSync(envPath, 0o600);
}

const existingEnvSecret = readEnvSecret();
if (!fs.existsSync(databasePath)) {
  if (!existingEnvSecret) writeEnvAtomically(crypto.randomBytes(32).toString("hex"));
  console.log(JSON.stringify({ ok: true, createdLocalSecret: !existingEnvSecret, rotatedCredentials: 0, databasePresent: false }));
  process.exit(0);
}

const db = new Database(databasePath);
db.pragma("foreign_keys = ON");
const storedFingerprint = db.prepare("SELECT value FROM app_settings WHERE key = 'secret_fingerprint_v1'").get()?.value;
if (existingEnvSecret && storedFingerprint && storedFingerprint !== fingerprint(existingEnvSecret)) {
  db.close();
  throw new Error("apps/api/.env 与当前数据库的主密钥指纹不匹配，未修改任何数据");
}
if (existingEnvSecret && storedFingerprint === fingerprint(existingEnvSecret)) {
  const integrity = db.pragma("integrity_check", { simple: true });
  db.close();
  if (integrity !== "ok") throw new Error(`本地数据库完整性检查失败：${String(integrity)}`);
  console.log(JSON.stringify({ ok: true, createdLocalSecret: false, rotatedCredentials: 0, databasePresent: true, alreadySecured: true, integrity }));
  process.exit(0);
}

const sourceSecret = existingEnvSecret ?? process.env.SUBMAIL_CURRENT_SECRET ?? legacyDevelopmentSecret;
const targetSecret = existingEnvSecret ?? crypto.randomBytes(32).toString("hex");
const accounts = db.prepare("SELECT id, password_cipher FROM accounts").all();
const settings = db.prepare("SELECT key, value FROM app_settings WHERE key IN ('ai_settings_v1', 'translation_settings_v1')").all();

const decryptedAccounts = accounts.map((account) => ({
  id: account.id,
  password: decryptSecret(account.password_cipher, sourceSecret)
}));
const decryptedSettings = settings.map((setting) => {
  const value = JSON.parse(setting.value);
  return {
    key: setting.key,
    value,
    apiKey: value.api_key_cipher ? decryptSecret(value.api_key_cipher, sourceSecret) : undefined
  };
});

const backupDir = path.join(apiDir, "data", "backups");
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const rollbackBackupPath = path.join(backupDir, `before-local-secret-${timestamp}.sqlite`);
await db.backup(rollbackBackupPath);
fs.chmodSync(rollbackBackupPath, 0o600);

const rotate = db.transaction(() => {
  const updateAccount = db.prepare("UPDATE accounts SET password_cipher = ?, updated_at = ? WHERE id = ?");
  const updateSetting = db.prepare("UPDATE app_settings SET value = ?, updated_at = ? WHERE key = ?");
  const now = new Date().toISOString();
  for (const account of decryptedAccounts) {
    updateAccount.run(encryptSecret(account.password, targetSecret), now, account.id);
  }
  for (const setting of decryptedSettings) {
    if (setting.apiKey) setting.value.api_key_cipher = encryptSecret(setting.apiKey, targetSecret);
    updateSetting.run(JSON.stringify(setting.value), now, setting.key);
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('secret_fingerprint_v1', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(fingerprint(targetSecret), now);
});

rotate();
if (!existingEnvSecret) writeEnvAtomically(targetSecret);
const integrity = db.pragma("integrity_check", { simple: true });
if (integrity !== "ok") throw new Error(`本地主密钥初始化后数据库完整性检查失败：${String(integrity)}`);
const backupPath = path.join(backupDir, `after-local-secret-${timestamp}.sqlite`);
await db.backup(backupPath);
fs.chmodSync(backupPath, 0o600);
db.close();
// The rollback copy is encrypted with the previous key. Once the rotated DB
// and a new-key backup are verified, do not retain that weaker artifact.
fs.rmSync(rollbackBackupPath, { force: true });

console.log(JSON.stringify({
  ok: true,
  createdLocalSecret: !existingEnvSecret,
  rotatedCredentials: decryptedAccounts.length + decryptedSettings.filter((item) => item.apiKey).length,
  databasePresent: true,
  backupPath,
  integrity
}));
