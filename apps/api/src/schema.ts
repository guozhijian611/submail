import type { Knex } from "knex";
import { normalizeMailboxHost } from "./account-input.js";

export type DatabaseDriver = "sqlite" | "mysql";

async function createAccounts(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable("accounts")) return;
  await knex.schema.createTable("accounts", (table) => {
    table.string("id", 191).primary();
    table.string("email", 320).notNullable();
    table.string("display_name", 255).notNullable();
    table.text("notes").notNullable().defaultTo("");
    table.text("aliases").notNullable().defaultTo("[]");
    table.string("username", 320).notNullable();
    table.text("password_cipher").notNullable();
    table.string("incoming_protocol", 16).notNullable().defaultTo("imap");
    table.string("auth_mode", 32).notNullable().defaultTo("password");
    table.string("imap_host", 255).notNullable();
    table.integer("imap_port").notNullable();
    table.integer("imap_secure").notNullable();
    table.string("smtp_host", 255).notNullable();
    table.integer("smtp_port").notNullable();
    table.integer("smtp_secure").notNullable();
    table.string("sync_status", 32).notNullable().defaultTo("idle");
    table.string("last_sync_at", 40).nullable();
    table.bigInteger("sync_cursor_uid").notNullable().defaultTo(0);
    table.string("sync_uid_validity", 191).nullable();
    table.string("created_at", 40).notNullable();
    table.string("updated_at", 40).notNullable();
  });
}

async function createMessages(knex: Knex, driver: DatabaseDriver): Promise<void> {
  if (await knex.schema.hasTable("messages")) return;
  await knex.schema.createTable("messages", (table) => {
    table.string("id", 191).primary();
    table.string("account_id", 191).notNullable().references("id").inTable("accounts").onDelete("CASCADE");
    table.string("folder", 255).notNullable();
    table.bigInteger("uid").nullable();
    table.string("message_id", 998).nullable();
    table.string("in_reply_to", 998).nullable();
    table.text("reference_ids").notNullable().defaultTo("[]");
    table.text("subject").notNullable();
    table.string("sender_name", 255).nullable();
    table.string("sender_email", 320).nullable();
    table.text("recipients").notNullable().defaultTo("[]");
    table.text("snippet").notNullable();
    table.specificType("text_body", driver === "mysql" ? "longtext" : "text").notNullable();
    table.specificType("html_body", driver === "mysql" ? "longtext" : "text").nullable();
    table.string("sent_at", 40).nullable();
    table.text("flags").notNullable().defaultTo("[]");
    table.integer("is_read").notNullable().defaultTo(0);
    table.integer("is_starred").notNullable().defaultTo(0);
    table.integer("is_archived").notNullable().defaultTo(0);
    table.integer("is_deleted").notNullable().defaultTo(0);
    table.string("archived_at", 40).nullable();
    table.string("deleted_at", 40).nullable();
    table.string("created_at", 40).notNullable();
    table.string("updated_at", 40).notNullable();
    table.unique(["account_id", "folder", "uid"], { indexName: "uq_messages_account_folder_uid" });
    table.index(["account_id", "folder", "sent_at"], "idx_messages_account_folder_time");
    table.index(["is_deleted", "is_archived", "is_starred", "sent_at"], "idx_messages_local_state");
  });
}

async function createAttachments(knex: Knex, driver: DatabaseDriver): Promise<void> {
  if (await knex.schema.hasTable("attachments")) return;
  await knex.schema.createTable("attachments", (table) => {
    table.string("id", 191).primary();
    table.string("message_id", 191).notNullable().references("id").inTable("messages").onDelete("CASCADE");
    table.text("filename").notNullable();
    table.string("content_type", 255).notNullable();
    table.bigInteger("size").notNullable();
    table.string("content_id", 998).nullable();
    table.specificType("content_blob", driver === "mysql" ? "longblob" : "blob").nullable();
    table.text("storage_path").nullable();
    table.string("created_at", 40).notNullable();
    table.index(["message_id"], "idx_attachments_message_id");
  });
}

async function createAuthTables(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("admins"))) {
    await knex.schema.createTable("admins", (table) => {
      table.string("id", 191).primary();
      table.string("email", 320).notNullable().unique();
      table.string("name", 255).notNullable();
      table.text("password_hash").notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
    });
  }
  if (!(await knex.schema.hasTable("admin_sessions"))) {
    await knex.schema.createTable("admin_sessions", (table) => {
      table.string("id", 191).primary();
      table.string("admin_id", 191).notNullable().references("id").inTable("admins").onDelete("CASCADE");
      table.string("token_hash", 191).notNullable().unique();
      table.string("expires_at", 40).notNullable();
      table.string("created_at", 40).notNullable();
      table.index(["expires_at"], "idx_sessions_expires_at");
    });
  }
  if (!(await knex.schema.hasTable("api_keys"))) {
    await knex.schema.createTable("api_keys", (table) => {
      table.string("id", 191).primary();
      table.string("name", 255).notNullable();
      table.string("key_hash", 191).notNullable().unique();
      table.string("key_prefix", 64).notNullable();
      table.text("scopes").notNullable().defaultTo('["mcp"]');
      table.text("account_ids").notNullable().defaultTo("[]");
      table.integer("all_accounts").notNullable().defaultTo(0);
      table.string("expires_at", 40).nullable();
      table.string("revoked_at", 40).nullable();
      table.integer("daily_send_limit").notNullable().defaultTo(100);
      table.string("last_used_at", 40).nullable();
      table.bigInteger("call_count").notNullable().defaultTo(0);
      table.string("created_at", 40).notNullable();
    });
  }
  if (!(await knex.schema.hasTable("api_key_daily_usage"))) {
    await knex.schema.createTable("api_key_daily_usage", (table) => {
      table.string("api_key_id", 191).notNullable().references("id").inTable("api_keys").onDelete("CASCADE");
      table.string("usage_date", 10).notNullable();
      table.integer("send_count").notNullable().defaultTo(0);
      table.primary(["api_key_id", "usage_date"]);
    });
  }
}

async function createOperationsTables(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("mailbox_sync_cursors"))) {
    await knex.schema.createTable("mailbox_sync_cursors", (table) => {
      table.string("account_id", 191).notNullable().references("id").inTable("accounts").onDelete("CASCADE");
      table.string("mailbox_path", 255).notNullable();
      table.bigInteger("cursor_uid").notNullable().defaultTo(0);
      table.string("uid_validity", 191).nullable();
      table.bigInteger("backfill_before_uid").nullable();
      table.integer("backfill_complete").notNullable().defaultTo(0);
      table.string("updated_at", 40).notNullable();
      table.primary(["account_id", "mailbox_path"]);
    });
  }
  if (!(await knex.schema.hasTable("pop3_seen_messages"))) {
    await knex.schema.createTable("pop3_seen_messages", (table) => {
      table.string("account_id", 191).notNullable().references("id").inTable("accounts").onDelete("CASCADE");
      table.string("uidl", 512).notNullable();
      table.string("message_id", 191).nullable().references("id").inTable("messages").onDelete("SET NULL");
      table.string("synced_at", 40).notNullable();
      table.primary(["account_id", "uidl"]);
      table.index(["account_id", "synced_at"], "idx_pop3_seen_account_time");
    });
  }
  if (!(await knex.schema.hasTable("sync_settings"))) {
    await knex.schema.createTable("sync_settings", (table) => {
      table.string("id", 191).primary();
      table.integer("enabled").notNullable().defaultTo(0);
      table.integer("interval_minutes").notNullable().defaultTo(15);
      table.integer("initial_limit").notNullable().defaultTo(30);
      table.integer("retry_max_attempts").notNullable().defaultTo(1);
      table.integer("retry_delay_minutes").notNullable().defaultTo(5);
      table.integer("concurrency_limit").notNullable().defaultTo(2);
      table.integer("retention_days").notNullable().defaultTo(30);
      table.string("last_run_at", 40).nullable();
      table.string("next_run_at", 40).nullable();
      table.string("updated_at", 40).notNullable();
    });
  }
  if (!(await knex.schema.hasTable("sync_runs"))) {
    await knex.schema.createTable("sync_runs", (table) => {
      table.string("id", 191).primary();
      table.string("account_id", 191).nullable().references("id").inTable("accounts").onDelete("SET NULL");
      table.string("trigger_type", 32).notNullable();
      table.string("status", 32).notNullable();
      table.integer("imported").notNullable().defaultTo(0);
      table.text("error").nullable();
      table.integer("attempts").notNullable().defaultTo(1);
      table.string("next_retry_at", 40).nullable();
      table.string("started_at", 40).notNullable();
      table.string("finished_at", 40).nullable();
      table.index(["status", "next_retry_at"], "idx_sync_runs_status_retry");
    });
  }
  if (!(await knex.schema.hasTable("mcp_call_logs"))) {
    await knex.schema.createTable("mcp_call_logs", (table) => {
      table.string("id", 191).primary();
      table.string("tool_name", 191).notNullable();
      table.text("input_json").notNullable();
      table.string("status", 32).notNullable();
      table.string("created_at", 40).notNullable();
      table.index(["created_at"], "idx_mcp_logs_created_at");
    });
  }
  if (!(await knex.schema.hasTable("app_settings"))) {
    await knex.schema.createTable("app_settings", (table) => {
      table.string("key", 191).primary();
      table.specificType("value", "text").notNullable();
      table.string("updated_at", 40).notNullable();
    });
  }
  if (!(await knex.schema.hasTable("send_idempotency"))) {
    await knex.schema.createTable("send_idempotency", (table) => {
      table.string("idempotency_key", 191).primary();
      table.string("account_id", 191).notNullable().references("id").inTable("accounts").onDelete("CASCADE");
      table.string("request_hash", 191).notNullable().defaultTo("");
      table.specificType("response_json", "text").notNullable();
      table.string("created_at", 40).notNullable();
      table.index(["created_at"], "idx_idempotency_created_at");
    });
  }
  if (!(await knex.schema.hasTable("saved_searches"))) {
    await knex.schema.createTable("saved_searches", (table) => {
      table.string("id", 191).primary();
      table.string("name", 255).notNullable();
      table.text("criteria_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
    });
  }
}

async function addMissingColumns(knex: Knex): Promise<void> {
  const columns: Array<[string, string, (table: Knex.AlterTableBuilder) => void]> = [
    ["attachments", "content_id", (table) => table.string("content_id", 998).nullable()],
    ["attachments", "content_blob", (table) => table.binary("content_blob").nullable()],
    ["messages", "is_starred", (table) => table.integer("is_starred").notNullable().defaultTo(0)],
    ["messages", "is_archived", (table) => table.integer("is_archived").notNullable().defaultTo(0)],
    ["messages", "is_deleted", (table) => table.integer("is_deleted").notNullable().defaultTo(0)],
    ["messages", "archived_at", (table) => table.string("archived_at", 40).nullable()],
    ["messages", "deleted_at", (table) => table.string("deleted_at", 40).nullable()],
    ["messages", "in_reply_to", (table) => table.string("in_reply_to", 998).nullable()],
    ["messages", "reference_ids", (table) => table.text("reference_ids").notNullable().defaultTo("[]")],
    ["accounts", "notes", (table) => table.text("notes").notNullable().defaultTo("")],
    ["accounts", "aliases", (table) => table.text("aliases").notNullable().defaultTo("[]")],
    ["accounts", "incoming_protocol", (table) => table.string("incoming_protocol", 16).notNullable().defaultTo("imap")],
    ["accounts", "auth_mode", (table) => table.string("auth_mode", 32).notNullable().defaultTo("password")],
    ["accounts", "sync_cursor_uid", (table) => table.bigInteger("sync_cursor_uid").notNullable().defaultTo(0)],
    ["accounts", "sync_uid_validity", (table) => table.string("sync_uid_validity", 191).nullable()],
    ["mailbox_sync_cursors", "backfill_before_uid", (table) => table.bigInteger("backfill_before_uid").nullable()],
    ["mailbox_sync_cursors", "backfill_complete", (table) => table.integer("backfill_complete").notNullable().defaultTo(0)],
    ["sync_settings", "initial_limit", (table) => table.integer("initial_limit").notNullable().defaultTo(30)],
    ["sync_settings", "retry_max_attempts", (table) => table.integer("retry_max_attempts").notNullable().defaultTo(1)],
    ["sync_settings", "retry_delay_minutes", (table) => table.integer("retry_delay_minutes").notNullable().defaultTo(5)],
    ["sync_settings", "concurrency_limit", (table) => table.integer("concurrency_limit").notNullable().defaultTo(2)],
    ["sync_settings", "retention_days", (table) => table.integer("retention_days").notNullable().defaultTo(30)],
    ["sync_runs", "attempts", (table) => table.integer("attempts").notNullable().defaultTo(1)],
    ["sync_runs", "next_retry_at", (table) => table.string("next_retry_at", 40).nullable()],
    ["api_keys", "call_count", (table) => table.bigInteger("call_count").notNullable().defaultTo(0)],
    ["api_keys", "account_ids", (table) => table.text("account_ids").notNullable().defaultTo("[]")],
    ["api_keys", "expires_at", (table) => table.string("expires_at", 40).nullable()],
    ["api_keys", "revoked_at", (table) => table.string("revoked_at", 40).nullable()],
    ["api_keys", "daily_send_limit", (table) => table.integer("daily_send_limit").notNullable().defaultTo(100)],
    ["api_keys", "all_accounts", (table) => table.integer("all_accounts").notNullable().defaultTo(0)],
    ["send_idempotency", "request_hash", (table) => table.string("request_hash", 191).notNullable().defaultTo("")]
  ];
  for (const [tableName, columnName, add] of columns) {
    if (!(await knex.schema.hasColumn(tableName, columnName))) {
      await knex.schema.alterTable(tableName, add);
    }
  }
}

async function normalizeLegacyAccountHosts(knex: Knex): Promise<void> {
  const accounts = await knex("accounts").select("id", "imap_host", "smtp_host") as Array<{
    id: string;
    imap_host: string;
    smtp_host: string;
  }>;
  for (const account of accounts) {
    const imapHost = normalizeMailboxHost(account.imap_host);
    const smtpHost = normalizeMailboxHost(account.smtp_host);
    if (imapHost === account.imap_host && smtpHost === account.smtp_host) continue;
    await knex("accounts").where({ id: account.id }).update({ imap_host: imapHost, smtp_host: smtpHost });
  }
}

export async function ensureSchema(knex: Knex, driver: DatabaseDriver): Promise<void> {
  await createAccounts(knex);
  await createMessages(knex, driver);
  await createAttachments(knex, driver);
  await createAuthTables(knex);
  await createOperationsTables(knex);
  await addMissingColumns(knex);
  await normalizeLegacyAccountHosts(knex);

  if (driver === "sqlite") {
    await knex.raw(`
      CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
        message_id UNINDEXED,
        account_id UNINDEXED,
        folder UNINDEXED,
        subject,
        sender_name,
        sender_email,
        snippet,
        text_body,
        attachment_names,
        tokenize = 'unicode61'
      )
    `);
    const version = Number((await knex.raw("PRAGMA user_version"))?.[0]?.user_version ?? 0);
    if (version === 2) {
      await knex("api_keys")
        .where({ all_accounts: 1, account_ids: "[]" })
        .whereNull("revoked_at")
        .update({ revoked_at: new Date().toISOString() });
    }
    await knex.raw("PRAGMA user_version = 6");
  }
}
