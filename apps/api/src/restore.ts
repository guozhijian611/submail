import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { acquireRuntimeLock } from "./runtime-lock.js";

const sourceArgument = process.argv[2];
if (config.dbDriver !== "sqlite") {
  throw new Error("当前数据库为 MySQL。请使用 mysql 客户端恢复；此命令仅支持 SQLite");
}
if (!sourceArgument) throw new Error("用法：npm --workspace apps/api run restore -- /path/to/backup.sqlite");
if (process.env.SUBMAIL_CONFIRM_RESTORE !== "YES") {
  throw new Error("恢复会替换当前数据库。确认后设置 SUBMAIL_CONFIRM_RESTORE=YES 再执行");
}

const sourcePath = path.resolve(sourceArgument);
const destinationPath = path.resolve(config.dbPath);
if (sourcePath === destinationPath) throw new Error("备份源不能与当前数据库相同");

const allowStaleBreak = process.env.SUBMAIL_BREAK_STALE_RUNTIME_LOCK === "YES"
  || process.env.SUBMAIL_IGNORE_RUNTIME_LOCK === "YES";
const runtimeLock = acquireRuntimeLock(destinationPath, { purpose: "restore", allowStaleBreak });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const temporaryPath = `${destinationPath}.restore-${process.pid}-${Date.now()}.tmp`;

function closeDatabase(database: Database.Database | undefined): void {
  if (!database?.open) return;
  try {
    database.close();
  } catch {
    // The restore flow must still be able to preserve a damaged database.
  }
}

function verifyDatabase(databasePath: string): void {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`${databasePath} 完整性检查失败：${String(integrity)}`);
  } finally {
    closeDatabase(database);
  }
}

function syncFile(filePath: string): void {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncDirectory(directoryPath: string): void {
  const fd = fs.openSync(directoryPath, "r");
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function preserveCorruptCurrentDatabase(): string[] {
  const artifactBase = `${destinationPath}.corrupt-before-restore-${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
  const candidates = [
    { source: destinationPath, target: artifactBase },
    { source: `${destinationPath}-wal`, target: `${artifactBase}-wal` },
    { source: `${destinationPath}-shm`, target: `${artifactBase}-shm` }
  ];
  const artifacts: string[] = [];
  try {
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate.source)) continue;
      fs.copyFileSync(candidate.source, candidate.target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(candidate.target, 0o600);
      syncFile(candidate.target);
      artifacts.push(candidate.target);
    }
    syncDirectory(path.dirname(destinationPath));
    return artifacts;
  } catch (error) {
    for (const artifact of artifacts) fs.rmSync(artifact, { force: true });
    throw new Error(`无法保全损坏的当前数据库，已中止恢复：${error instanceof Error ? error.message : String(error)}`);
  }
}

let previousPath: string | undefined;
let corruptArtifactPaths: string[] = [];
let replacementCompleted = false;

try {
  let sourceDb: Database.Database | undefined;
  try {
    sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
    const integrity = sourceDb.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`备份完整性检查失败：${String(integrity)}`);
    await sourceDb.backup(temporaryPath);
  } finally {
    closeDatabase(sourceDb);
  }
  fs.chmodSync(temporaryPath, 0o600);
  verifyDatabase(temporaryPath);
  syncFile(temporaryPath);

  const currentFilesExist = [destinationPath, `${destinationPath}-wal`, `${destinationPath}-shm`]
    .some((filePath) => fs.existsSync(filePath));
  if (fs.existsSync(destinationPath)) {
    // Snapshot raw files before SQLite opens the current database. Even a
    // read-only open may rewrite SHM metadata for an invalid WAL pair.
    const provisionalCorruptArtifacts = preserveCorruptCurrentDatabase();
    previousPath = `${destinationPath}.before-restore-${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
    let currentDb: Database.Database | undefined;
    let currentBackupSucceeded = false;
    try {
      // Read-only is deliberate: opening a damaged database read-write can make
      // SQLite delete an invalid WAL/SHM before we have a chance to preserve it.
      currentDb = new Database(destinationPath, { readonly: true, fileMustExist: true, timeout: 1_000 });
      await currentDb.backup(previousPath);
      closeDatabase(currentDb);
      currentDb = undefined;
      fs.chmodSync(previousPath, 0o600);
      verifyDatabase(previousPath);
      syncFile(previousPath);
      currentBackupSucceeded = true;
    } catch {
      closeDatabase(currentDb);
      fs.rmSync(previousPath, { force: true });
      previousPath = undefined;
      corruptArtifactPaths = provisionalCorruptArtifacts;
    }
    if (currentBackupSucceeded) {
      for (const artifact of provisionalCorruptArtifacts) fs.rmSync(artifact, { force: true });
      syncDirectory(path.dirname(destinationPath));
    }
  } else if (currentFilesExist) {
    corruptArtifactPaths = preserveCorruptCurrentDatabase();
  }

  for (const suffix of ["-wal", "-shm"]) {
    fs.rmSync(`${destinationPath}${suffix}`, { force: true });
  }
  fs.renameSync(temporaryPath, destinationPath);
  replacementCompleted = true;
  fs.chmodSync(destinationPath, 0o600);
  syncDirectory(path.dirname(destinationPath));

  console.log(JSON.stringify({
    ok: true,
    restoredFrom: sourcePath,
    destinationPath,
    previousPath,
    corruptArtifactPaths,
    staleLockPath: runtimeLock.staleLockPath
  }));
} finally {
  if (!replacementCompleted) fs.rmSync(temporaryPath, { force: true });
  if (!runtimeLock.release()) {
    process.stderr.write(`警告：恢复运行锁 ${runtimeLock.path} 的 owner 已变更，未删除非本进程持有的锁\n`);
  }
}
