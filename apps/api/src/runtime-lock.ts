import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RuntimeLockPurpose = "api" | "restore";

export type RuntimeLockOwner = {
  version: 1;
  pid: number;
  hostname: string;
  ownerToken: string;
  purpose: RuntimeLockPurpose;
  startedAt: string;
  processStartedAt?: string;
  leaseTimeoutMs?: number;
};

export type RuntimeLock = {
  path: string;
  owner: RuntimeLockOwner;
  staleLockPath?: string;
  release(): boolean;
};

export class RuntimeLockError extends Error {
  constructor(message: string, readonly lockPath: string) {
    super(message);
    this.name = "RuntimeLockError";
  }
}

type LockSnapshot = {
  raw: string;
  owner?: RuntimeLockOwner;
  device: bigint;
  inode: bigint;
  modifiedAtMs: number;
  modifiedAtNs: bigint;
};

const HEARTBEAT_INTERVAL_MS = 10_000;
const LEASE_TIMEOUT_MS = 60_000;
const LEGACY_LEASE_TIMEOUT_MS = 10 * 60_000;
const MAX_LEASE_TIMEOUT_MS = 24 * 60 * 60_000;
const PROCESS_START_TOLERANCE_MS = 2_000;
const currentProcessStartedAtMs = Date.now() - process.uptime() * 1_000;

function parseOwner(raw: string): RuntimeLockOwner | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeLockOwner>;
    if (
      parsed.version !== 1
      || !Number.isSafeInteger(parsed.pid)
      || Number(parsed.pid) <= 0
      || typeof parsed.hostname !== "string"
      || !parsed.hostname
      || typeof parsed.ownerToken !== "string"
      || parsed.ownerToken.length < 16
      || (parsed.purpose !== "api" && parsed.purpose !== "restore")
      || typeof parsed.startedAt !== "string"
      || !Number.isFinite(Date.parse(parsed.startedAt))
      || (parsed.processStartedAt !== undefined && (
        typeof parsed.processStartedAt !== "string"
        || !Number.isFinite(Date.parse(parsed.processStartedAt))
      ))
      || (parsed.leaseTimeoutMs !== undefined && (
        !Number.isSafeInteger(parsed.leaseTimeoutMs)
        || parsed.leaseTimeoutMs < LEASE_TIMEOUT_MS
        || parsed.leaseTimeoutMs > MAX_LEASE_TIMEOUT_MS
      ))
    ) return undefined;
    return parsed as RuntimeLockOwner;
  } catch {
    return undefined;
  }
}

function readSnapshot(lockPath: string): LockSnapshot {
  const fd = fs.openSync(lockPath, "r");
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    return {
      raw: fs.readFileSync(fd, "utf8"),
      owner: undefined,
      device: stat.dev,
      inode: stat.ino,
      modifiedAtMs: Number(stat.mtimeMs),
      modifiedAtNs: stat.mtimeNs
    };
  } finally {
    fs.closeSync(fd);
  }
}

function ownerProcessIsAlive(owner: RuntimeLockOwner): boolean {
  if (owner.hostname !== os.hostname()) return false;
  if (owner.pid === process.pid) {
    const recordedProcessStart = Date.parse(owner.processStartedAt ?? owner.startedAt);
    if (recordedProcessStart < currentProcessStartedAtMs - PROCESS_START_TOLERANCE_MS) {
      return false;
    }
  }
  return processIsAlive(owner.pid);
}

function staleAfterMs(owner: RuntimeLockOwner): number {
  return owner.leaseTimeoutMs ?? LEGACY_LEASE_TIMEOUT_MS;
}

function lockLeaseExpired(snapshot: LockSnapshot): boolean {
  if (!snapshot.owner) return false;
  return Date.now() - snapshot.modifiedAtMs >= staleAfterMs(snapshot.owner);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM still proves that a process with this PID exists.
    return true;
  }
}

function existingLockMessage(lockPath: string, snapshot: LockSnapshot): string {
  const owner = snapshot.owner;
  if (!owner) {
    return `数据库运行锁 ${lockPath} 已存在，但内容无法校验。请确认没有 API/restore 进程后，显式设置 SUBMAIL_BREAK_STALE_RUNTIME_LOCK=YES 人工接管`;
  }
  return `数据库运行锁 ${lockPath} 已由 ${owner.purpose} 持有（host=${owner.hostname}, pid=${owner.pid}, startedAt=${owner.startedAt}）`;
}

function createLock(lockPath: string, purpose: RuntimeLockPurpose): RuntimeLock {
  const owner: RuntimeLockOwner = {
    version: 1,
    pid: process.pid,
    hostname: os.hostname(),
    ownerToken: crypto.randomBytes(32).toString("hex"),
    purpose,
    startedAt: new Date().toISOString(),
    processStartedAt: new Date(currentProcessStartedAtMs).toISOString(),
    leaseTimeoutMs: LEASE_TIMEOUT_MS
  };
  const fd = fs.openSync(lockPath, "wx", 0o600);
  let stat: fs.BigIntStats;
  try {
    fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
    fs.fsyncSync(fd);
    stat = fs.fstatSync(fd, { bigint: true });
  } catch (error) {
    try {
      fs.closeSync(fd);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
    throw error;
  }

  const heartbeatTimer = setInterval(() => {
    try {
      const now = new Date();
      fs.futimesSync(fd, now, now);
    } catch {
      // A transient heartbeat failure is retried. If it persists, another
      // process may recover the expired lease after the safety timeout.
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  let finished = false;
  return {
    path: lockPath,
    owner,
    release(): boolean {
      if (finished) return false;
      finished = true;
      clearInterval(heartbeatTimer);
      fs.closeSync(fd);
      let current: LockSnapshot;
      try {
        current = readSnapshot(lockPath);
        current.owner = parseOwner(current.raw);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      if (
        current.device !== stat.dev
        || current.inode !== stat.ino
        || current.owner?.ownerToken !== owner.ownerToken
        || current.owner.pid !== owner.pid
        || current.owner.hostname !== owner.hostname
      ) return false;
      fs.unlinkSync(lockPath);
      return true;
    }
  };
}

export function acquireRuntimeLock(
  databasePath: string,
  options: { purpose: RuntimeLockPurpose; allowStaleBreak?: boolean }
): RuntimeLock {
  const lockPath = `${path.resolve(databasePath)}.runtime-lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  let staleLockPath: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const lock = createLock(lockPath, options.purpose);
      return staleLockPath ? { ...lock, staleLockPath } : lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let snapshot: LockSnapshot;
    try {
      snapshot = readSnapshot(lockPath);
      snapshot.owner = parseOwner(snapshot.raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    if (snapshot.owner && ownerProcessIsAlive(snapshot.owner)) {
      throw new RuntimeLockError(
        `${existingLockMessage(lockPath, snapshot)}。该本机 PID 仍存活，即使设置人工接管开关也不会删除活锁`,
        lockPath
      );
    }

    const leaseExpired = lockLeaseExpired(snapshot);
    if (!options.allowStaleBreak && !leaseExpired) {
      throw new RuntimeLockError(existingLockMessage(lockPath, snapshot), lockPath);
    }

    const currentStat = fs.statSync(lockPath, { bigint: true });
    if (
      currentStat.dev !== snapshot.device
      || currentStat.ino !== snapshot.inode
      || currentStat.mtimeNs !== snapshot.modifiedAtNs
    ) continue;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const candidate = `${lockPath}.stale-${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
    try {
      fs.renameSync(lockPath, candidate);
      fs.chmodSync(candidate, 0o600);
      staleLockPath = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }

  throw new RuntimeLockError(`无法安全获取数据库运行锁 ${lockPath}，请检查是否有并发启动`, lockPath);
}
