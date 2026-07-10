import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// Keep local API credentials beside the API workspace so imports launched from
// the repository root and npm workspace scripts resolve the same secret.
dotenv.config({ path: path.resolve(moduleDir, "../.env") });
dotenv.config();

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function booleanEnv(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const requestedDbDriver = (process.env.SUBMAIL_DB_DRIVER ?? "sqlite").trim().toLowerCase();
if (requestedDbDriver !== "sqlite" && requestedDbDriver !== "mysql") {
  throw new Error("SUBMAIL_DB_DRIVER 仅支持 sqlite 或 mysql");
}
const dbDriver = requestedDbDriver as "sqlite" | "mysql";
const requestedQueueDriver = (process.env.SUBMAIL_QUEUE_DRIVER ?? (nodeEnv === "production" ? "redis" : "memory")).trim().toLowerCase();
if (requestedQueueDriver !== "memory" && requestedQueueDriver !== "redis") {
  throw new Error("SUBMAIL_QUEUE_DRIVER 仅支持 memory 或 redis");
}
const queueDriver = requestedQueueDriver as "memory" | "redis";

export const config = {
  nodeEnv,
  isProduction: nodeEnv === "production",
  host: process.env.SUBMAIL_HOST ?? "0.0.0.0",
  port: numberEnv("SUBMAIL_PORT", 8787),
  dbDriver,
  dbPath: process.env.SUBMAIL_DB_PATH ?? path.resolve(moduleDir, "../data/submail.sqlite"),
  mysqlUrl: process.env.SUBMAIL_MYSQL_URL?.trim(),
  mysqlHost: process.env.SUBMAIL_MYSQL_HOST?.trim() || "127.0.0.1",
  mysqlPort: numberEnv("SUBMAIL_MYSQL_PORT", 3306),
  mysqlDatabase: process.env.SUBMAIL_MYSQL_DATABASE?.trim() || "submail",
  mysqlUser: process.env.SUBMAIL_MYSQL_USER?.trim() || "submail",
  mysqlPassword: process.env.SUBMAIL_MYSQL_PASSWORD ?? "",
  mysqlSsl: booleanEnv("SUBMAIL_MYSQL_SSL"),
  mysqlConnectionLimit: numberEnv("SUBMAIL_MYSQL_CONNECTION_LIMIT", 10),
  storageDir: process.env.SUBMAIL_STORAGE_DIR ?? path.resolve(moduleDir, "../storage"),
  secret: process.env.SUBMAIL_SECRET ?? "dev-secret-change-me",
  adminName: process.env.SUBMAIL_ADMIN_NAME ?? "管理员",
  adminEmail: process.env.SUBMAIL_ADMIN_EMAIL,
  adminPassword: process.env.SUBMAIL_ADMIN_PASSWORD,
  mcpApiKey: process.env.SUBMAIL_MCP_API_KEY,
  trustProxy: booleanEnv("SUBMAIL_TRUST_PROXY"),
  demoMode: booleanEnv("SUBMAIL_DEMO_MODE"),
  maxIncomingMessageBytes: numberEnv("SUBMAIL_MAX_INCOMING_MESSAGE_BYTES", 25 * 1024 * 1024),
  maxIncomingBodyBytes: numberEnv("SUBMAIL_MAX_INCOMING_BODY_BYTES", 2 * 1024 * 1024),
  maxOutgoingMessageBytes: numberEnv("SUBMAIL_MAX_OUTGOING_MESSAGE_BYTES", 25 * 1024 * 1024),
  mailConnectionTimeoutMs: numberEnv("SUBMAIL_MAIL_CONNECTION_TIMEOUT_MS", 30_000),
  auditRetentionDays: numberEnv("SUBMAIL_AUDIT_RETENTION_DAYS", 30),
  syncRunRetentionDays: numberEnv("SUBMAIL_SYNC_RUN_RETENTION_DAYS", 90),
  queueDriver,
  redisUrl: process.env.SUBMAIL_REDIS_URL?.trim() || "redis://127.0.0.1:6379",
  queuePrefix: process.env.SUBMAIL_QUEUE_PREFIX?.trim() || "submail",
  queueConcurrency: numberEnv("SUBMAIL_QUEUE_CONCURRENCY", 4)
};

function looksLikeExampleSecret(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes("change-me") || normalized.includes("example") || normalized === "dev-secret-change-me";
}

export function validateProductionConfig(): void {
  if (!config.isProduction) return;
  if (config.secret.length < 32 || looksLikeExampleSecret(config.secret)) {
    throw new Error("生产环境必须设置至少 32 字符且非示例值的 SUBMAIL_SECRET");
  }
  if (config.adminPassword && (config.adminPassword.length < 8 || looksLikeExampleSecret(config.adminPassword))) {
    throw new Error("生产环境管理员密码必须至少 8 字符且不能使用示例值");
  }
  if (config.mcpApiKey && (config.mcpApiKey.length < 24 || looksLikeExampleSecret(config.mcpApiKey))) {
    throw new Error("SUBMAIL_MCP_API_KEY 必须使用随机生成的安全值");
  }
  if (config.dbDriver === "mysql" && !config.mysqlUrl && (!config.mysqlPassword || config.mysqlPassword.length < 12)) {
    throw new Error("生产环境 MySQL 必须设置 SUBMAIL_MYSQL_URL，或至少 12 字符的 SUBMAIL_MYSQL_PASSWORD");
  }
}
