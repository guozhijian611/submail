import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { db } from "./db.js";

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
if (config.dbDriver !== "sqlite") {
  throw new Error("当前数据库为 MySQL。请使用 mysqldump 备份；此命令仅支持 SQLite");
}
const requestedPath = process.argv[2];
const backupPath = path.resolve(requestedPath || path.join(config.storageDir, "backups", `submail-${timestamp}.sqlite`));

if (backupPath === path.resolve(config.dbPath)) {
  throw new Error("备份目标不能与当前数据库相同");
}

fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
await db.backup(backupPath);
fs.chmodSync(backupPath, 0o600);

const verificationDb = new Database(backupPath, { readonly: true, fileMustExist: true });
const integrity = verificationDb.pragma("integrity_check", { simple: true });
const schemaVersion = verificationDb.pragma("user_version", { simple: true });
verificationDb.close();
if (integrity !== "ok") {
  fs.rmSync(backupPath, { force: true });
  throw new Error(`备份完整性检查失败：${String(integrity)}`);
}

const hash = await new Promise<string>((resolve, reject) => {
  const digest = crypto.createHash("sha256");
  const stream = fs.createReadStream(backupPath);
  stream.on("data", (chunk) => digest.update(chunk));
  stream.once("error", reject);
  stream.once("end", () => resolve(digest.digest("hex")));
});
const manifestPath = `${backupPath}.json`;
fs.writeFileSync(manifestPath, `${JSON.stringify({
  createdAt: new Date().toISOString(),
  database: path.basename(backupPath),
  sha256: hash,
  schemaVersion,
  note: "恢复此备份时必须同时使用创建备份时的 SUBMAIL_SECRET"
}, null, 2)}\n`, { mode: 0o600 });

console.log(JSON.stringify({ ok: true, backupPath, manifestPath, sha256: hash, schemaVersion }));
