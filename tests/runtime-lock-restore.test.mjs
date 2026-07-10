import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

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

function spawnApi({ databasePath, storagePath, port, breakStale = false }) {
  return spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "development",
      SUBMAIL_HOST: "127.0.0.1",
      SUBMAIL_PORT: String(port),
      SUBMAIL_DB_PATH: databasePath,
      SUBMAIL_STORAGE_DIR: storagePath,
      SUBMAIL_SECRET: "runtime-lock-test-secret",
      SUBMAIL_BREAK_STALE_RUNTIME_LOCK: breakStale ? "YES" : ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function captureOutput(child) {
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  return () => output;
}

async function waitForHealth(port, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited early (${child.exitCode})\n${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`API health timeout\n${output()}`);
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("process exit timeout"));
    }, timeoutMs);
    timeout.unref();
    const onExit = (code) => {
      clearTimeout(timeout);
      resolve(code);
    };
    child.once("exit", onExit);
  });
}

test("runtime lock is exclusive, rejects live-lock override, and archives only explicitly broken stale locks", { timeout: 45_000 }, async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "submail-runtime-lock-"));
  const databasePath = path.join(tempDir, "submail.sqlite");
  const storagePath = path.join(tempDir, "storage");
  const lockPath = `${databasePath}.runtime-lock`;
  let first;
  let staleOwner;
  t.after(async () => {
    for (const child of [first, staleOwner]) {
      if (child?.exitCode === null) child.kill("SIGTERM");
      if (child?.exitCode === null) await once(child, "exit");
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const firstPort = await freePort();
  first = spawnApi({ databasePath, storagePath, port: firstPort });
  const firstOutput = captureOutput(first);
  await waitForHealth(firstPort, first, firstOutput);
  const firstLock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.equal(firstLock.pid, first.pid);
  assert.equal(firstLock.purpose, "api");
  assert.match(firstLock.ownerToken, /^[a-f0-9]{64}$/);

  const contender = spawnApi({ databasePath, storagePath, port: await freePort(), breakStale: true });
  const contenderOutput = captureOutput(contender);
  const contenderCode = await waitForExit(contender);
  assert.notEqual(contenderCode, 0);
  assert.match(contenderOutput(), /本机 PID 仍存活/);
  assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).ownerToken, firstLock.ownerToken);
  assert.equal((await fetch(`http://127.0.0.1:${firstPort}/health`)).status, 200);

  first.kill("SIGTERM");
  assert.equal(await waitForExit(first), 0, firstOutput());
  await assert.rejects(fs.access(lockPath), { code: "ENOENT" });

  const fakeStaleLock = {
    version: 1,
    pid: 1,
    hostname: "confirmed-stale-on-another-host.example",
    ownerToken: "0".repeat(64),
    purpose: "api",
    startedAt: "2000-01-01T00:00:00.000Z"
  };
  await fs.writeFile(lockPath, `${JSON.stringify(fakeStaleLock)}\n`, { mode: 0o600 });

  const staleRejected = spawnApi({ databasePath, storagePath, port: await freePort() });
  const staleRejectedOutput = captureOutput(staleRejected);
  assert.notEqual(await waitForExit(staleRejected), 0);
  assert.match(staleRejectedOutput(), /SUBMAIL_BREAK_STALE_RUNTIME_LOCK=YES|数据库运行锁/);
  assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).ownerToken, fakeStaleLock.ownerToken);

  const stalePort = await freePort();
  staleOwner = spawnApi({ databasePath, storagePath, port: stalePort, breakStale: true });
  const staleOwnerOutput = captureOutput(staleOwner);
  await waitForHealth(stalePort, staleOwner, staleOwnerOutput);
  const replacementLock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.notEqual(replacementLock.ownerToken, fakeStaleLock.ownerToken);
  const directoryEntries = await fs.readdir(tempDir);
  const archivedLock = directoryEntries.find((entry) => entry.startsWith("submail.sqlite.runtime-lock.stale-"));
  assert(archivedLock, "stale lock should be retained as an audit artifact");
  assert.equal(JSON.parse(await fs.readFile(path.join(tempDir, archivedLock), "utf8")).ownerToken, fakeStaleLock.ownerToken);

  const foreignOwner = { ...replacementLock, ownerToken: "f".repeat(64) };
  await fs.writeFile(lockPath, `${JSON.stringify(foreignOwner)}\n`, { mode: 0o600 });
  staleOwner.kill("SIGTERM");
  assert.equal(await waitForExit(staleOwner), 0, staleOwnerOutput());
  assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).ownerToken, foreignOwner.ownerToken);
  assert.match(staleOwnerOutput(), /lock ownership changed|owner 已变更/i);
  await fs.rm(lockPath);
});

test("restore preserves a corrupt main database and WAL/SHM artifacts, then installs a valid backup", { timeout: 20_000 }, async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "submail-corrupt-restore-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const sourcePath = path.join(tempDir, "backup.sqlite");
  const destinationPath = path.join(tempDir, "submail.sqlite");
  const originalMain = Buffer.from("this is intentionally not a sqlite database\n");
  const originalWal = Buffer.from("corrupt-wal-evidence\n");
  const originalShm = Buffer.from("corrupt-shm-evidence\n");

  const sourceDb = new Database(sourcePath);
  sourceDb.exec("CREATE TABLE restore_marker (value TEXT NOT NULL)");
  sourceDb.prepare("INSERT INTO restore_marker (value) VALUES (?)").run("restored-from-valid-backup");
  sourceDb.pragma("user_version = 27");
  sourceDb.close();
  await fs.writeFile(destinationPath, originalMain);
  await fs.writeFile(`${destinationPath}-wal`, originalWal);
  await fs.writeFile(`${destinationPath}-shm`, originalShm);

  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/restore.ts", sourcePath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "development",
      SUBMAIL_DB_PATH: destinationPath,
      SUBMAIL_STORAGE_DIR: path.join(tempDir, "storage"),
      SUBMAIL_CONFIRM_RESTORE: "YES",
      SUBMAIL_BREAK_STALE_RUNTIME_LOCK: "",
      SUBMAIL_IGNORE_RUNTIME_LOCK: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const code = await waitForExit(child);
  assert.equal(code, 0, stderr || stdout);
  const result = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(result.ok, true);
  assert.equal(result.previousPath, undefined);
  assert.equal(result.corruptArtifactPaths.length, 3);

  const restoredDb = new Database(destinationPath, { readonly: true });
  assert.equal(restoredDb.prepare("SELECT value FROM restore_marker").pluck().get(), "restored-from-valid-backup");
  assert.equal(restoredDb.pragma("user_version", { simple: true }), 27);
  assert.equal(restoredDb.pragma("integrity_check", { simple: true }), "ok");
  restoredDb.close();

  const mainArtifact = result.corruptArtifactPaths.find((item) => !item.endsWith("-wal") && !item.endsWith("-shm"));
  const walArtifact = result.corruptArtifactPaths.find((item) => item.endsWith("-wal"));
  const shmArtifact = result.corruptArtifactPaths.find((item) => item.endsWith("-shm"));
  assert.deepEqual(await fs.readFile(mainArtifact), originalMain);
  assert.deepEqual(await fs.readFile(walArtifact), originalWal);
  assert.deepEqual(await fs.readFile(shmArtifact), originalShm);
  await assert.rejects(fs.access(`${destinationPath}.runtime-lock`), { code: "ENOENT" });
});
