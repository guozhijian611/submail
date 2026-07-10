import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import knexFactory, { type Knex } from "knex";
import { config } from "./config.js";
import { ensureSchema } from "./schema.js";

export type RunResult = { changes: number; lastInsertRowid?: number | string };
type Bindings = readonly unknown[] | Record<string, unknown>;

fs.mkdirSync(config.storageDir, { recursive: true });
if (config.dbDriver === "sqlite") fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
try {
  fs.chmodSync(config.storageDir, 0o700);
  if (config.dbDriver === "sqlite") fs.chmodSync(path.dirname(config.dbPath), 0o700);
} catch {
  // Some mounted filesystems do not support POSIX modes.
}

function createKnex(): Knex {
  if (config.dbDriver === "sqlite") {
    return knexFactory({
      client: "better-sqlite3",
      connection: { filename: config.dbPath },
      useNullAsDefault: true,
      pool: {
        min: 1,
        max: 1,
        afterCreate(connection: { pragma: (sql: string) => unknown }, done: (error: Error | null, connection: unknown) => void) {
          try {
            connection.pragma("journal_mode = WAL");
            connection.pragma("foreign_keys = ON");
            connection.pragma("busy_timeout = 5000");
            done(null, connection);
          } catch (error) {
            done(error as Error, connection);
          }
        }
      }
    });
  }

  const connection = config.mysqlUrl
    ? config.mysqlUrl
    : {
        host: config.mysqlHost,
        port: config.mysqlPort,
        database: config.mysqlDatabase,
        user: config.mysqlUser,
        password: config.mysqlPassword,
        charset: "utf8mb4",
        ssl: config.mysqlSsl ? {} : undefined
      };
  return knexFactory({
    client: "mysql2",
    connection,
    pool: { min: 0, max: config.mysqlConnectionLimit }
  });
}

const knex = createKnex();
const transactionStorage = new AsyncLocalStorage<Knex.Transaction>();

function queryClient(): Knex | Knex.Transaction {
  return transactionStorage.getStore() ?? knex;
}

function normalizeNamedSql(sql: string): string {
  return sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, ":$1");
}

function normalizeMysqlSql(sql: string): string {
  if (config.dbDriver !== "mysql") return sql;
  let value = sql
    .replace(/\bMAX\s*\(\s*0\s*,/gi, "GREATEST(0,")
    .replace(/\bINSERT\s+OR\s+IGNORE\b/gi, "INSERT IGNORE")
    .replace(/\bapp_settings\s*\.\s*key\b/g, "app_settings.`key`");
  value = value.replace(/\bON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+NOTHING\b/gi, (_match, keys: string) => {
    const firstKey = keys.split(",")[0]?.trim() || "id";
    return `ON DUPLICATE KEY UPDATE ${firstKey} = ${firstKey}`;
  });
  value = value.replace(/\bON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+UPDATE\s+SET\s+/gi, "ON DUPLICATE KEY UPDATE ");
  value = value.replace(/\bexcluded\.([A-Za-z_][A-Za-z0-9_]*)\b/gi, "VALUES($1)");
  if (/\bapp_settings\b/i.test(value)) {
    value = value
      .replace(/\bWHERE\s+key\s*=/gi, "WHERE `key` =")
      .replace(/\(\s*key\s*,\s*value\s*,\s*updated_at\s*\)/gi, "(`key`, value, updated_at)");
  }
  return value;
}

function normalizeBindings(args: unknown[]): Bindings | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0]) && !Buffer.isBuffer(args[0])) {
    return args[0] as Record<string, unknown>;
  }
  return args;
}

function rowsFromRaw(result: unknown): unknown[] {
  if (config.dbDriver === "mysql") {
    const rows = Array.isArray(result) ? result[0] : undefined;
    return Array.isArray(rows) ? rows : [];
  }
  return Array.isArray(result) ? result : [];
}

function runResultFromRaw(result: unknown): RunResult {
  if (config.dbDriver === "mysql") {
    const packet = Array.isArray(result) ? result[0] as { affectedRows?: number; insertId?: number } : undefined;
    return { changes: Number(packet?.affectedRows ?? 0), lastInsertRowid: packet?.insertId };
  }
  const packet = result as { changes?: number; lastInsertRowid?: number | string } | undefined;
  return { changes: Number(packet?.changes ?? 0), lastInsertRowid: packet?.lastInsertRowid };
}

async function raw(sql: string, args: unknown[]): Promise<unknown> {
  const normalizedSql = normalizeMysqlSql(normalizeNamedSql(sql));
  const bindings = normalizeBindings(args);
  return bindings === undefined ? queryClient().raw(normalizedSql) : queryClient().raw(normalizedSql, bindings as never);
}

export const db = {
  driver: config.dbDriver,
  prepare(sql: string) {
    return {
      async all<T = unknown>(...args: unknown[]): Promise<T[]> {
        return rowsFromRaw(await raw(sql, args)) as T[];
      },
      async get<T = unknown>(...args: unknown[]): Promise<T | undefined> {
        return rowsFromRaw(await raw(sql, args))[0] as T | undefined;
      },
      async run(...args: unknown[]): Promise<RunResult> {
        return runResultFromRaw(await raw(sql, args));
      }
    };
  },
  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    const active = transactionStorage.getStore();
    if (active) return callback();
    return knex.transaction((trx) => transactionStorage.run(trx, callback));
  },
  async healthCheck(): Promise<void> {
    await knex.raw("SELECT 1");
  },
  async checkpoint(): Promise<void> {
    if (config.dbDriver === "sqlite") await knex.raw("PRAGMA wal_checkpoint(TRUNCATE)");
  },
  async backup(targetPath: string): Promise<void> {
    if (config.dbDriver !== "sqlite") {
      throw new Error("MySQL 备份请使用 mysqldump；内置 backup 命令仅支持 SQLite");
    }
    const connection = await knex.client.acquireConnection() as { backup: (target: string) => Promise<void> };
    try {
      await connection.backup(targetPath);
    } finally {
      await knex.client.releaseConnection(connection);
    }
  },
  async close(): Promise<void> {
    await knex.destroy();
  },
  get open(): boolean {
    return true;
  },
  get knex(): Knex {
    return knex;
  }
};

await ensureSchema(knex, config.dbDriver);

if (config.dbDriver === "sqlite") {
  try {
    fs.chmodSync(config.dbPath, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      const file = `${config.dbPath}${suffix}`;
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    }
  } catch {
    // Some mounted filesystems do not support POSIX modes.
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
