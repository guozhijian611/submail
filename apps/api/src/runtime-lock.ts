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
};

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
      inode: stat.ino
    };
  } finally {
    fs.closeSync(fd);
  }
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
    startedAt: new Date().toISOString()
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
  fs.closeSync(fd);

  let released = false;
  return {
    path: lockPath,
    owner,
    release(): boolean {
      if (released) return false;
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
      released = true;
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

    if (!options.allowStaleBreak) {
      throw new RuntimeLockError(existingLockMessage(lockPath, snapshot), lockPath);
    }

    if (
      snapshot.owner?.hostname === os.hostname()
      && processIsAlive(snapshot.owner.pid)
    ) {
      throw new RuntimeLockError(
        `${existingLockMessage(lockPath, snapshot)}。该本机 PID 仍存活，即使设置人工接管开关也不会删除活锁`,
        lockPath
      );
    }

    const currentStat = fs.statSync(lockPath, { bigint: true });
    if (currentStat.dev !== snapshot.device || currentStat.ino !== snapshot.inode) continue;
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
