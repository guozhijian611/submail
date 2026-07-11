import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { db, nowIso } from "./db.js";
import { normalizeMailboxHost } from "./account-input.js";
import { config } from "./config.js";
import { createApiKey, createSessionToken, decryptSecret, encryptSecret, hashApiKey, hashPassword, verifyPassword } from "./crypto.js";
import type { AccountRecord, MessageRecord } from "./types.js";
export type AdminRecord = {
    id: string;
    email: string;
    name: string;
    password_hash: string;
    created_at: string;
    updated_at: string;
};
export type PublicAdmin = Omit<AdminRecord, "password_hash">;
export type ApiKeyRecord = {
    id: string;
    name: string;
    key_hash: string;
    key_prefix: string;
    scopes: string;
    account_ids: string;
    all_accounts: number;
    expires_at: string | null;
    revoked_at: string | null;
    daily_send_limit: number;
    last_used_at: string | null;
    call_count: number;
    created_at: string;
};
export type PublicApiKey = Omit<ApiKeyRecord, "key_hash" | "scopes" | "account_ids" | "all_accounts"> & {
    scopes: string[];
    account_ids: string[];
    all_accounts: boolean;
};
export type PublicAccount = Omit<AccountRecord, "password_cipher" | "imap_secure" | "smtp_secure" | "aliases"> & {
    imap_secure: boolean;
    smtp_secure: boolean;
    aliases: PublicAccountAlias[];
};
export type AccountAliasVerificationStatus = "unverified" | "pending" | "verified";
export type PublicAccountAlias = {
    id: string;
    email: string;
    display_name: string;
    reply_to: string;
    send_enabled: boolean;
    verification_status: AccountAliasVerificationStatus;
    verification_expires_at: string | null;
    verified_at: string | null;
};
type StoredAccountAlias = PublicAccountAlias & { verification_code_hash: string | null };
export type AccountAliasInput = {
    id?: string;
    email: string;
    displayName?: string;
    replyTo?: string;
    sendEnabled?: boolean;
};
export type AttachmentRecord = {
    id: string;
    message_id: string;
    filename: string;
    content_type: string;
    size: number;
    content_id: string | null;
    content_blob: Buffer | null;
    storage_path: string | null;
    created_at: string;
};
export type PublicAttachment = Omit<AttachmentRecord, "content_blob"> & {
    message_subject?: string;
    sender_email?: string | null;
    sent_at?: string | null;
};
export type AttachmentListParams = {
    page?: number;
    pageSize?: number;
    query?: string;
    type?: "image" | "text" | "pdf" | "archive" | "other";
};
export type SavedSearchCriteria = {
    query?: string;
    sender?: string;
    dateFrom?: string;
    dateTo?: string;
    hasAttachment?: boolean;
    folder?: string;
    accountId?: string;
};
export type SavedSearchRecord = {
    id: string;
    name: string;
    criteria_json: string;
    created_at: string;
    updated_at: string;
};
export type PublicSavedSearch = Omit<SavedSearchRecord, "criteria_json"> & {
    criteria: SavedSearchCriteria;
};
export type CreateAccountInput = {
    email: string;
    displayName: string;
    notes: string;
    aliases: AccountAliasInput[];
    username: string;
    password: string;
    incomingProtocol: "imap" | "pop3";
    authMode: "password" | "app_password";
    imapHost: string;
    imapPort: number;
    imapSecure: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
};
export type UpdateAccountInput = Omit<CreateAccountInput, "password"> & {
    password?: string;
};
function aliasIdFor(email: string): string {
    return `alias_${crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16)}`;
}
function normalizeMailSecret(value: string, authMode: "password" | "app_password"): string {
    return authMode === "app_password" ? value.replace(/\s+/g, "") : value;
}
function parseStoredAliases(value: string): StoredAccountAlias[] {
    try {
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed))
            return [];
        return parsed.flatMap((item): StoredAccountAlias[] => {
            if (typeof item === "string") {
                const email = item.trim().toLowerCase();
                return email ? [{
                    id: aliasIdFor(email), email, display_name: "", reply_to: "", send_enabled: false,
                    verification_status: "unverified", verification_expires_at: null, verified_at: null,
                    verification_code_hash: null
                }] : [];
            }
            if (!item || typeof item !== "object")
                return [];
            const source = item as Partial<StoredAccountAlias>;
            const email = String(source.email ?? "").trim().toLowerCase();
            if (!email)
                return [];
            const status: AccountAliasVerificationStatus = ["pending", "verified"].includes(String(source.verification_status))
                ? source.verification_status as AccountAliasVerificationStatus
                : "unverified";
            return [{
                id: String(source.id || aliasIdFor(email)),
                email,
                display_name: String(source.display_name ?? ""),
                reply_to: String(source.reply_to ?? ""),
                send_enabled: Boolean(source.send_enabled),
                verification_status: status,
                verification_expires_at: source.verification_expires_at ?? null,
                verified_at: source.verified_at ?? null,
                verification_code_hash: source.verification_code_hash ?? null
            }];
        });
    }
    catch {
        return [];
    }
}
function normalizedAliases(primaryEmail: string, aliases: AccountAliasInput[], existing: StoredAccountAlias[] = []): StoredAccountAlias[] {
    const primary = primaryEmail.trim().toLowerCase();
    const seen = new Set<string>();
    return aliases.flatMap((input): StoredAccountAlias[] => {
        const email = input.email.trim().toLowerCase();
        if (!email || email === primary || seen.has(email))
            return [];
        seen.add(email);
        const previous = existing.find((item) => item.id === input.id || item.email === email);
        const keepsVerification = previous?.email === email;
        return [{
            id: keepsVerification ? previous.id : aliasIdFor(email),
            email,
            display_name: input.displayName?.trim() ?? previous?.display_name ?? "",
            reply_to: input.replyTo?.trim().toLowerCase() ?? previous?.reply_to ?? "",
            send_enabled: Boolean(input.sendEnabled ?? previous?.send_enabled),
            verification_status: keepsVerification ? previous.verification_status : "unverified",
            verification_expires_at: keepsVerification ? previous.verification_expires_at : null,
            verified_at: keepsVerification ? previous.verified_at : null,
            verification_code_hash: keepsVerification ? previous.verification_code_hash : null
        }];
    });
}
export function toPublicAccount(account: AccountRecord): PublicAccount {
    const { password_cipher: _password, aliases: _aliases, ...rest } = account;
    const aliases = parseStoredAliases(account.aliases).map(({ verification_code_hash: _hash, ...alias }) => alias);
    return {
        ...rest,
        aliases,
        imap_secure: Boolean(account.imap_secure),
        smtp_secure: Boolean(account.smtp_secure)
    };
}
export const accountRepo = {
    async list() {
        return (await db.prepare("SELECT * FROM accounts ORDER BY created_at DESC").all()).map((row) => toPublicAccount(row as AccountRecord));
    },
    async get(id: string) {
        return await db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRecord | undefined;
    },
    async internalList() {
        return await db.prepare("SELECT * FROM accounts ORDER BY created_at ASC").all() as AccountRecord[];
    },
    async incomingIdentityMatches(snapshot: AccountRecord) {
        const lockClause = config.dbDriver === "mysql" ? " FOR UPDATE" : "";
        const current = await db.prepare(`
      SELECT username, password_cipher, incoming_protocol, auth_mode, imap_host, imap_port, imap_secure
      FROM accounts WHERE id = ?${lockClause}
    `).get(snapshot.id) as Pick<AccountRecord,
            "username" | "password_cipher" | "incoming_protocol" | "auth_mode" | "imap_host" | "imap_port" | "imap_secure"
        > | undefined;
        return Boolean(current)
            && current!.username === snapshot.username
            && current!.password_cipher === snapshot.password_cipher
            && current!.incoming_protocol === snapshot.incoming_protocol
            && current!.auth_mode === snapshot.auth_mode
            && current!.imap_host === snapshot.imap_host
            && Number(current!.imap_port) === Number(snapshot.imap_port)
            && Number(current!.imap_secure) === Number(snapshot.imap_secure);
    },
    async create(input: CreateAccountInput) {
        const id = nanoid();
        const now = nowIso();
        const account: AccountRecord = {
            id,
            email: input.email,
            display_name: input.displayName,
            notes: input.notes,
            aliases: JSON.stringify(normalizedAliases(input.email, input.aliases)),
            username: input.username,
            password_cipher: encryptSecret(normalizeMailSecret(input.password, input.authMode)),
            incoming_protocol: input.incomingProtocol,
            auth_mode: input.authMode,
            imap_host: normalizeMailboxHost(input.imapHost),
            imap_port: input.imapPort,
            imap_secure: input.imapSecure ? 1 : 0,
            smtp_host: normalizeMailboxHost(input.smtpHost),
            smtp_port: input.smtpPort,
            smtp_secure: input.smtpSecure ? 1 : 0,
            sync_status: "idle",
            last_sync_at: null,
            sync_cursor_uid: 0,
            sync_uid_validity: null,
            created_at: now,
            updated_at: now
        };
        await db.prepare(`
      INSERT INTO accounts (
        id, email, display_name, notes, aliases, username, password_cipher, incoming_protocol, auth_mode, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, sync_status, last_sync_at, sync_cursor_uid, sync_uid_validity, created_at, updated_at
      ) VALUES (
        @id, @email, @display_name, @notes, @aliases, @username, @password_cipher, @incoming_protocol, @auth_mode, @imap_host, @imap_port, @imap_secure,
        @smtp_host, @smtp_port, @smtp_secure, @sync_status, @last_sync_at, @sync_cursor_uid, @sync_uid_validity, @created_at, @updated_at
      )
    `).run(account);
        return toPublicAccount(account);
    },
    async update(id: string, input: UpdateAccountInput) {
        const existing = await this.get(id);
        if (!existing)
            return undefined;
        const normalizedImapHost = normalizeMailboxHost(input.imapHost);
        const incomingMailboxChanged = existing.username !== input.username
            || existing.incoming_protocol !== input.incomingProtocol
            || existing.imap_host !== normalizedImapHost
            || existing.imap_port !== input.imapPort
            || existing.imap_secure !== (input.imapSecure ? 1 : 0);
        const incomingCredentialsChanged = existing.auth_mode !== input.authMode || Boolean(input.password);
        const next: AccountRecord = {
            ...existing,
            email: input.email,
            display_name: input.displayName,
            notes: input.notes,
            aliases: JSON.stringify(normalizedAliases(input.email, input.aliases, parseStoredAliases(existing.aliases))),
            username: input.username,
            password_cipher: input.password ? encryptSecret(normalizeMailSecret(input.password, input.authMode)) : existing.password_cipher,
            incoming_protocol: input.incomingProtocol,
            auth_mode: input.authMode,
            imap_host: normalizedImapHost,
            imap_port: input.imapPort,
            imap_secure: input.imapSecure ? 1 : 0,
            smtp_host: normalizeMailboxHost(input.smtpHost),
            smtp_port: input.smtpPort,
            smtp_secure: input.smtpSecure ? 1 : 0,
            sync_status: incomingMailboxChanged || incomingCredentialsChanged ? "idle" : existing.sync_status,
            sync_cursor_uid: incomingMailboxChanged ? 0 : existing.sync_cursor_uid,
            sync_uid_validity: incomingMailboxChanged ? null : existing.sync_uid_validity,
            updated_at: nowIso()
        };
        await db.transaction(async () => {
            await db.prepare(`
      UPDATE accounts SET
        email = @email,
        display_name = @display_name,
        notes = @notes,
        aliases = @aliases,
        username = @username,
        password_cipher = @password_cipher,
        incoming_protocol = @incoming_protocol,
        auth_mode = @auth_mode,
        imap_host = @imap_host,
        imap_port = @imap_port,
        imap_secure = @imap_secure,
        smtp_host = @smtp_host,
        smtp_port = @smtp_port,
        smtp_secure = @smtp_secure,
        sync_status = @sync_status,
        sync_cursor_uid = @sync_cursor_uid,
        sync_uid_validity = @sync_uid_validity,
        updated_at = @updated_at
      WHERE id = @id
            `).run(next);
            if (incomingMailboxChanged) {
                const remoteMessages = await db.prepare(`
          SELECT id FROM messages
          WHERE account_id = ? AND (
            uid IS NOT NULL
            OR remote_mailbox IS NOT NULL
            OR id IN (
              SELECT message_id FROM pop3_seen_messages
              WHERE account_id = ? AND message_id IS NOT NULL
            )
          )
        `).all(id, id) as Array<{ id: string }>;
                if (config.dbDriver === "sqlite") {
                    for (let offset = 0; offset < remoteMessages.length; offset += 250) {
                        const ids = remoteMessages.slice(offset, offset + 250).map((message) => message.id);
                        const placeholders = ids.map(() => "?").join(", ");
                        await db.prepare(`DELETE FROM message_search WHERE message_id IN (${placeholders})`).run(...ids);
                    }
                }
                await db.prepare(`
          DELETE FROM messages
          WHERE account_id = ? AND (
            uid IS NOT NULL
            OR remote_mailbox IS NOT NULL
            OR id IN (
              SELECT message_id FROM pop3_seen_messages
              WHERE account_id = ? AND message_id IS NOT NULL
            )
          )
        `).run(id, id);
                await db.prepare("DELETE FROM mailbox_sync_cursors WHERE account_id = ?").run(id);
                await pop3SeenRepo.clear(id);
            }
        });
        return toPublicAccount(next);
    },
    async delete(id: string) {
        const result = await db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
        return result.changes > 0;
    },
    async decryptedPassword(account: AccountRecord) {
        return decryptSecret(account.password_cipher);
    },
    async resolveSender(account: AccountRecord, aliasId?: string) {
        if (!aliasId)
            return { email: account.email, displayName: account.display_name, replyTo: undefined as string | undefined, aliasId: undefined as string | undefined };
        const alias = parseStoredAliases(account.aliases).find((item) => item.id === aliasId);
        if (!alias)
            throw new Error("发信别名不存在");
        if (alias.verification_status !== "verified" || !alias.send_enabled)
            throw new Error("发信别名尚未验证或未启用");
        return { email: alias.email, displayName: alias.display_name || account.display_name, replyTo: alias.reply_to || undefined, aliasId: alias.id };
    },
    async resolveSenderByEmail(account: AccountRecord, email?: string | null) {
        if (!email || email.trim().toLowerCase() === account.email.trim().toLowerCase())
            return this.resolveSender(account);
        const alias = parseStoredAliases(account.aliases).find((item) => item.email === email.trim().toLowerCase());
        return this.resolveSender(account, alias?.id);
    },
    async beginAliasVerification(accountId: string, aliasId: string) {
        const account = await this.get(accountId);
        if (!account)
            return undefined;
        const aliases = parseStoredAliases(account.aliases);
        const alias = aliases.find((item) => item.id === aliasId);
        if (!alias)
            return undefined;
        const code = String(crypto.randomInt(100000, 1000000));
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        alias.verification_status = "pending";
        alias.verification_expires_at = expiresAt;
        alias.verification_code_hash = crypto.createHmac("sha256", config.secret).update(`${accountId}:${aliasId}:${code}`).digest("hex");
        await db.prepare("UPDATE accounts SET aliases = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(aliases), nowIso(), accountId);
        return { alias: toPublicAccount({ ...account, aliases: JSON.stringify(aliases) }).aliases.find((item) => item.id === aliasId)!, code };
    },
    async confirmAliasVerification(accountId: string, aliasId: string, code: string) {
        const account = await this.get(accountId);
        if (!account)
            return undefined;
        const aliases = parseStoredAliases(account.aliases);
        const alias = aliases.find((item) => item.id === aliasId);
        if (!alias)
            return undefined;
        const expected = crypto.createHmac("sha256", config.secret).update(`${accountId}:${aliasId}:${code}`).digest("hex");
        const validHash = Boolean(alias.verification_code_hash)
            && crypto.timingSafeEqual(Buffer.from(alias.verification_code_hash!, "hex"), Buffer.from(expected, "hex"));
        if (!validHash || !alias.verification_expires_at || new Date(alias.verification_expires_at).getTime() < Date.now())
            return null;
        alias.verification_status = "verified";
        alias.verification_expires_at = null;
        alias.verification_code_hash = null;
        alias.verified_at = nowIso();
        await db.prepare("UPDATE accounts SET aliases = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(aliases), nowIso(), accountId);
        return toPublicAccount({ ...account, aliases: JSON.stringify(aliases) }).aliases.find((item) => item.id === aliasId);
    },
    async markSync(id: string, status: "idle" | "syncing" | "error", lastSyncAt?: string) {
        await db.prepare("UPDATE accounts SET sync_status = ?, last_sync_at = COALESCE(?, last_sync_at), updated_at = ? WHERE id = ?")
            .run(status, lastSyncAt ?? null, nowIso(), id);
    },
    async markSyncCursor(id: string, cursorUid: number, uidValidity: string) {
        await db.prepare("UPDATE accounts SET sync_cursor_uid = ?, sync_uid_validity = ?, updated_at = ? WHERE id = ?")
            .run(cursorUid, uidValidity, nowIso(), id);
    }
};
export const mailboxCursorRepo = {
    async get(accountId: string, mailboxPath: string) {
        return await db.prepare("SELECT cursor_uid, uid_validity, backfill_before_uid, backfill_complete, last_reconcile_at FROM mailbox_sync_cursors WHERE account_id = ? AND mailbox_path = ?")
            .get(accountId, mailboxPath) as { cursor_uid: number; uid_validity: string | null; backfill_before_uid: number | null; backfill_complete: number; last_reconcile_at: string | null } | undefined;
    },
    async matchesSnapshot(accountId: string, mailboxPath: string, expected: {
        cursor_uid: number;
        uid_validity: string | null;
        backfill_before_uid: number | null;
        backfill_complete: number;
        last_reconcile_at: string | null;
    } | undefined) {
        const lockClause = config.dbDriver === "mysql" ? " FOR UPDATE" : "";
        const current = await db.prepare(`
      SELECT cursor_uid, uid_validity, backfill_before_uid, backfill_complete, last_reconcile_at
      FROM mailbox_sync_cursors WHERE account_id = ? AND mailbox_path = ?${lockClause}
    `).get(accountId, mailboxPath) as typeof expected;
        if (!expected || !current)
            return expected === current;
        return Number(current.cursor_uid) === Number(expected.cursor_uid)
            && current.uid_validity === expected.uid_validity
            && Number(current.backfill_before_uid ?? 0) === Number(expected.backfill_before_uid ?? 0)
            && Boolean(current.backfill_complete) === Boolean(expected.backfill_complete)
            && current.last_reconcile_at === expected.last_reconcile_at;
    },
    async oldestLocalUid(accountId: string, folder: string) {
        const row = await db.prepare("SELECT MIN(uid) AS uid FROM messages WHERE account_id = ? AND folder = ? AND uid IS NOT NULL")
            .get(accountId, folder) as { uid: number | null } | undefined;
        return row?.uid === null || row?.uid === undefined ? undefined : Number(row.uid);
    },
    async set(accountId: string, mailboxPath: string, input: {
        cursorUid: number;
        uidValidity: string;
        backfillBeforeUid: number;
        backfillComplete: boolean;
        lastReconcileAt?: string;
    }) {
        await db.prepare(`
      INSERT INTO mailbox_sync_cursors (account_id, mailbox_path, cursor_uid, uid_validity, backfill_before_uid, backfill_complete, last_reconcile_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, mailbox_path) DO UPDATE SET
        cursor_uid = excluded.cursor_uid,
        uid_validity = excluded.uid_validity,
        backfill_before_uid = excluded.backfill_before_uid,
        backfill_complete = excluded.backfill_complete,
        last_reconcile_at = COALESCE(excluded.last_reconcile_at, last_reconcile_at),
        updated_at = excluded.updated_at
    `).run(accountId, mailboxPath, input.cursorUid, input.uidValidity, input.backfillBeforeUid, input.backfillComplete ? 1 : 0, input.lastReconcileAt ?? null, nowIso());
    }
};
export const pop3SeenRepo = {
    async count(accountId: string): Promise<number> {
        const row = await db.prepare("SELECT COUNT(*) AS count FROM pop3_seen_messages WHERE account_id = ?").get(accountId) as { count: number } | undefined;
        return Number(row?.count ?? 0);
    },
    async existing(accountId: string, uidls: string[]): Promise<Set<string>> {
        if (uidls.length === 0)
            return new Set();
        const found = new Set<string>();
        for (let offset = 0; offset < uidls.length; offset += 250) {
            const batch = uidls.slice(offset, offset + 250);
            const placeholders = batch.map(() => "?").join(", ");
            const rows = await db.prepare(`SELECT uidl FROM pop3_seen_messages WHERE account_id = ? AND uidl IN (${placeholders})`).all(accountId, ...batch) as Array<{ uidl: string }>;
            for (const row of rows)
                found.add(row.uidl);
        }
        return found;
    },
    async mark(accountId: string, uidl: string, messageId?: string): Promise<void> {
        await db.prepare(`
      INSERT INTO pop3_seen_messages (account_id, uidl, message_id, synced_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, uidl) DO UPDATE SET
        message_id = COALESCE(excluded.message_id, pop3_seen_messages.message_id),
        synced_at = excluded.synced_at
    `).run(accountId, uidl, messageId ?? null, nowIso());
    },
    async clear(accountId: string): Promise<void> {
        await db.prepare("DELETE FROM pop3_seen_messages WHERE account_id = ?").run(accountId);
    }
};
function toPublicAdmin(admin: AdminRecord): PublicAdmin {
    const { password_hash: _passwordHash, ...rest } = admin;
    return rest;
}
function toPublicApiKey(apiKey: ApiKeyRecord): PublicApiKey {
    const { key_hash: _keyHash, account_ids: _accountIds, all_accounts: _allAccounts, ...rest } = apiKey;
    return {
        ...rest,
        scopes: parseApiKeyScopes(apiKey.scopes),
        account_ids: parseApiKeyScopes(apiKey.account_ids),
        all_accounts: Boolean(apiKey.all_accounts)
    };
}
function parseApiKeyScopes(scopes: string): string[] {
    try {
        const value = JSON.parse(scopes) as unknown;
        if (Array.isArray(value))
            return value.filter((item): item is string => typeof item === "string");
    }
    catch {
        return [];
    }
    return [];
}
export const adminRepo = {
    async count() {
        const row = await db.prepare("SELECT COUNT(*) AS count FROM admins").get() as {
            count: number;
        };
        return row.count;
    },
    async list() {
        return (await db.prepare("SELECT * FROM admins ORDER BY created_at ASC").all()).map((row) => toPublicAdmin(row as AdminRecord));
    },
    async create(input: {
        email: string;
        name: string;
        password: string;
    }) {
        const id = nanoid();
        const now = nowIso();
        const record: AdminRecord = {
            id,
            email: input.email.toLowerCase(),
            name: input.name,
            password_hash: hashPassword(input.password),
            created_at: now,
            updated_at: now
        };
        await db.prepare("INSERT INTO admins (id, email, name, password_hash, created_at, updated_at) VALUES (@id, @email, @name, @password_hash, @created_at, @updated_at)")
            .run(record);
        return toPublicAdmin(record);
    },
    async getByEmail(email: string) {
        return await db.prepare("SELECT * FROM admins WHERE email = ?").get(email.toLowerCase()) as AdminRecord | undefined;
    },
    async getById(id: string) {
        return await db.prepare("SELECT * FROM admins WHERE id = ?").get(id) as AdminRecord | undefined;
    },
    async verifyLogin(email: string, password: string) {
        const admin = await this.getByEmail(email);
        if (!admin || !verifyPassword(password, admin.password_hash))
            return undefined;
        return toPublicAdmin(admin);
    },
    async changePassword(id: string, oldPassword: string, newPassword: string) {
        const admin = await this.getById(id);
        if (!admin || !verifyPassword(oldPassword, admin.password_hash))
            return false;
        await db.prepare("UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?")
            .run(hashPassword(newPassword), nowIso(), id);
        return true;
    },
    async resetPassword(id: string, newPassword: string) {
        const admin = await this.getById(id);
        if (!admin)
            return undefined;
        await db.prepare("UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?")
            .run(hashPassword(newPassword), nowIso(), id);
        const updated = await this.getById(id);
        return updated ? toPublicAdmin(updated) : undefined;
    }
};
export const sessionRepo = {
    async create(adminId: string) {
        const token = createSessionToken();
        const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
        await db.prepare("INSERT INTO admin_sessions (id, admin_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(nanoid(), adminId, hashApiKey(token), expiresAt, nowIso());
        return { token, expiresAt };
    },
    async getAdminByToken(token: string) {
        const tokenHash = hashApiKey(token);
        const admin = await db.prepare(`
      SELECT admins.* FROM admin_sessions
      JOIN admins ON admins.id = admin_sessions.admin_id
      WHERE admin_sessions.token_hash = ? AND admin_sessions.expires_at > ?
    `).get(tokenHash, nowIso()) as AdminRecord | undefined;
        return admin ? toPublicAdmin(admin) : undefined;
    },
    async delete(token: string) {
        await db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(hashApiKey(token));
    },
    async deleteOtherForAdmin(adminId: string, keepToken: string) {
        await db.prepare("DELETE FROM admin_sessions WHERE admin_id = ? AND token_hash != ?")
            .run(adminId, hashApiKey(keepToken));
    },
    async deleteForAdmin(adminId: string) {
        await db.prepare("DELETE FROM admin_sessions WHERE admin_id = ?").run(adminId);
    }
};
export const apiKeyRepo = {
    async list() {
        return (await db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all()).map((row) => toPublicApiKey(row as ApiKeyRecord));
    },
    async create(input: {
        name: string;
        scopes?: string[];
        accountIds?: string[];
        allAccounts?: boolean;
        expiresAt?: string;
        dailySendLimit?: number;
        key?: string;
    }) {
        const key = input.key ?? createApiKey();
        const record: ApiKeyRecord = {
            id: nanoid(),
            name: input.name,
            key_hash: hashApiKey(key),
            key_prefix: key.slice(0, 18),
            scopes: JSON.stringify(input.scopes ?? ["mcp"]),
            account_ids: JSON.stringify(input.accountIds ?? []),
            all_accounts: input.allAccounts ? 1 : 0,
            expires_at: input.expiresAt ?? null,
            revoked_at: null,
            daily_send_limit: Math.max(0, Math.min(10000, input.dailySendLimit ?? 100)),
            last_used_at: null,
            call_count: 0,
            created_at: nowIso()
        };
        await db.prepare(`
      INSERT INTO api_keys (
        id, name, key_hash, key_prefix, scopes, account_ids, all_accounts, expires_at, revoked_at, daily_send_limit,
        last_used_at, call_count, created_at
      ) VALUES (
        @id, @name, @key_hash, @key_prefix, @scopes, @account_ids, @all_accounts, @expires_at, @revoked_at, @daily_send_limit,
        @last_used_at, @call_count, @created_at
      )
    `)
            .run(record);
        return { ...toPublicApiKey(record), key };
    },
    async verify(key: string) {
        const record = await db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(hashApiKey(key)) as ApiKeyRecord | undefined;
        if (!record || record.revoked_at || (record.expires_at && record.expires_at <= nowIso()))
            return undefined;
        return toPublicApiKey(record);
    },
    async markUsed(id: string) {
        await db.prepare("UPDATE api_keys SET last_used_at = ?, call_count = call_count + 1 WHERE id = ?").run(nowIso(), id);
    },
    async allowsAccount(apiKey: PublicApiKey, accountId: string) {
        return apiKey.all_accounts || apiKey.account_ids.includes(accountId);
    },
    async consumeSendQuota(apiKey: PublicApiKey) {
        if (apiKey.daily_send_limit === 0)
            return false;
        const usageDate = nowIso().slice(0, 10);
        return db.transaction(async () => {
            const row = await db.prepare("SELECT send_count FROM api_key_daily_usage WHERE api_key_id = ? AND usage_date = ?")
                .get(apiKey.id, usageDate) as {
                send_count: number;
            } | undefined;
            if ((row?.send_count ?? 0) >= apiKey.daily_send_limit)
                return false;
            await db.prepare(`
        INSERT INTO api_key_daily_usage (api_key_id, usage_date, send_count)
        VALUES (?, ?, 1)
        ON CONFLICT(api_key_id, usage_date) DO UPDATE SET send_count = send_count + 1
      `).run(apiKey.id, usageDate);
            return true;
        });
    },
    async refundSendQuota(apiKey: PublicApiKey) {
        const usageDate = nowIso().slice(0, 10);
        await db.prepare(`
      UPDATE api_key_daily_usage
      SET send_count = MAX(0, send_count - 1)
      WHERE api_key_id = ? AND usage_date = ?
    `).run(apiKey.id, usageDate);
    },
    async delete(id: string) {
        await db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
    },
    async existsByHash(key: string) {
        const row = await db.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE key_hash = ?").get(hashApiKey(key)) as {
            count: number;
        };
        return row.count > 0;
    }
};
export const bootstrapRepo = {
    async setupStatus() {
        return {
            requiresSetup: await adminRepo.count() === 0,
            envAdminConfigured: Boolean(config.adminEmail && config.adminPassword),
            mcpApiKeyConfigured: Boolean(config.mcpApiKey),
            databaseDriver: config.dbDriver
        };
    },
    async createFirstAdmin(input: { email: string; name: string; password: string }) {
        return db.transaction(async () => {
            if (await adminRepo.count() > 0)
                return undefined;
            const claim = await db.prepare(`
        INSERT OR IGNORE INTO app_settings (key, value, updated_at)
        VALUES ('admin_initialized_v1', '1', ?)
      `).run(nowIso());
            if (claim.changes === 0)
                return undefined;
            return adminRepo.create(input);
        });
    },
    async initialize() {
        const secretFingerprint = crypto.createHash("sha256").update(config.secret).digest("hex").slice(0, 24);
        const storedFingerprint = await db.prepare("SELECT value FROM app_settings WHERE key = 'secret_fingerprint_v1'").get() as {
            value: string;
        } | undefined;
        if (storedFingerprint && storedFingerprint.value !== secretFingerprint) {
            throw new Error("SUBMAIL_SECRET 与当前数据库不匹配；请恢复原密钥后重启，避免邮箱及第三方凭据无法解密");
        }
        if (!storedFingerprint) {
            await db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('secret_fingerprint_v1', ?, ?)")
                .run(secretFingerprint, nowIso());
        }
        if (await adminRepo.count() === 0 && config.adminEmail && config.adminPassword) {
            await this.createFirstAdmin({
                email: config.adminEmail,
                name: config.adminName,
                password: config.adminPassword
            });
        }
        if (config.mcpApiKey && !await apiKeyRepo.existsByHash(config.mcpApiKey)) {
            await apiKeyRepo.create({
                name: "环境变量 MCP Key",
                scopes: ["mcp"],
                allAccounts: true,
                key: config.mcpApiKey
            });
        }
    }
};
export type UpsertMessageInput = {
    id?: string;
    accountId: string;
    folder: string;
    uid?: number;
    messageId?: string;
    inReplyTo?: string;
    references?: string[];
    subject: string;
    senderName?: string;
    senderEmail?: string;
    recipients?: string[];
    snippet?: string;
    textBody?: string;
    htmlBody?: string;
    sentAt?: string;
    flags?: string[];
    isRead?: boolean;
    isStarred?: boolean;
    isArchived?: boolean;
    isDeleted?: boolean;
    remoteMailbox?: string;
    remoteUidValidity?: string;
};
export type RemoteMessageState = {
    uid: number;
    flags: string[];
    isRead: boolean;
    isStarred: boolean;
    isArchived: boolean;
    isDeleted: boolean;
};
type OutgoingMessageInput = {
    account: AccountRecord;
    senderEmail?: string;
    senderName?: string;
    to: string[];
    subject: string;
    text: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
};
function textSnippet(value: string): string {
    return value.replace(/\s+/g, " ").trim().slice(0, 180);
}
function normalizedThreadSubject(value: string): string {
    return value
        .replace(/^\s*((re|fw|fwd|答复|回复|转发)\s*[:：]\s*)+/iu, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}
function parseStringArray(value: string): string[] {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    }
    catch {
        return [];
    }
}
type MessageStateOverrides = Partial<{
    isRead: boolean;
    isStarred: boolean;
    isArchived: boolean;
    isDeleted: boolean;
}>;
function parseMessageStateOverrides(value: string | null | undefined): MessageStateOverrides {
    try {
        const parsed = JSON.parse(value ?? "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        const result: MessageStateOverrides = {};
        for (const key of ["isRead", "isStarred", "isArchived", "isDeleted"] as const) {
            if (typeof parsed[key] === "boolean")
                result[key] = parsed[key];
        }
        return result;
    }
    catch {
        return {};
    }
}
type ThreadMessageMetadata = Pick<MessageRecord,
    "id" | "account_id" | "folder" | "message_id" | "in_reply_to" | "reference_ids" |
    "subject" | "sender_email" | "recipients" | "sent_at" | "created_at"
>;
function messageParticipants(message: ThreadMessageMetadata): Set<string> {
    return new Set([message.sender_email, ...parseStringArray(message.recipients)]
        .filter((item): item is string => Boolean(item))
        .map((item) => item.trim().toLowerCase()));
}
function messageCounterparts(message: ThreadMessageMetadata, selfAddresses: Set<string>): Set<string> {
    return new Set([...messageParticipants(message)].filter((address) => !selfAddresses.has(address)));
}
function messageHeaderIds(message: ThreadMessageMetadata): Set<string> {
    return new Set([message.message_id, message.in_reply_to, ...parseStringArray(message.reference_ids)]
        .filter((item): item is string => Boolean(item)));
}
function applyMessageViewFilters(view: string | undefined, clauses: string[], values: unknown[], table = "messages"): void {
    const prefix = table ? `${table}.` : "";
    switch (view) {
        case "STARRED":
            clauses.push(`${prefix}is_starred = 1`);
            clauses.push(`${prefix}is_deleted = 0`);
            break;
        case "ARCHIVED":
            clauses.push(`${prefix}is_archived = 1`);
            clauses.push(`${prefix}is_deleted = 0`);
            break;
        case "TRASH":
            clauses.push(`${prefix}is_deleted = 1`);
            break;
        case "JUNK":
        case "SENT":
        case "DRAFTS":
            clauses.push(`${prefix}folder = ?`);
            clauses.push(`${prefix}is_deleted = 0`);
            values.push(view === "SENT" ? "Sent" : view === "DRAFTS" ? "Drafts" : "Junk");
            break;
        case "INBOX":
        default:
            clauses.push(`${prefix}folder = ?`);
            clauses.push(`${prefix}is_archived = 0`);
            clauses.push(`${prefix}is_deleted = 0`);
            values.push(view ?? "INBOX");
            break;
    }
}
function applyMessageFieldFilters(params: {
    sender?: string;
    dateFrom?: string;
    dateTo?: string;
    hasAttachment?: boolean;
}, clauses: string[], values: unknown[], table = "messages"): void {
    const prefix = table ? `${table}.` : "";
    const idRef = table ? `${table}.id` : "messages.id";
    if (params.sender?.trim()) {
        clauses.push(`(${prefix}sender_email LIKE ? OR ${prefix}sender_name LIKE ?)`);
        const sender = `%${params.sender.trim()}%`;
        values.push(sender, sender);
    }
    if (params.dateFrom) {
        clauses.push(`COALESCE(${prefix}sent_at, ${prefix}created_at) >= ?`);
        values.push(params.dateFrom);
    }
    if (params.dateTo) {
        clauses.push(`COALESCE(${prefix}sent_at, ${prefix}created_at) <= ?`);
        values.push(params.dateTo);
    }
    if (params.hasAttachment) {
        clauses.push(`EXISTS (SELECT 1 FROM attachments WHERE attachments.message_id = ${idRef})`);
    }
}
function makeFtsQuery(query: string): string {
    return query
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 12)
        .map((term) => `"${term.replace(/"/g, '""')}"`)
        .join(" AND ");
}
async function updateMessageSearchIndex(messageId: string) {
    if (config.dbDriver !== "sqlite")
        return;
    const message = await db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRecord | undefined;
    if (!message)
        return;
    const attachments = await db.prepare("SELECT filename FROM attachments WHERE message_id = ? ORDER BY filename ASC")
        .all(messageId) as Array<{
        filename: string;
    }>;
    await db.prepare("DELETE FROM message_search WHERE message_id = ?").run(messageId);
    await db.prepare(`
    INSERT INTO message_search (
      message_id, account_id, folder, subject, sender_name, sender_email, snippet, text_body, attachment_names
    ) VALUES (
      @message_id, @account_id, @folder, @subject, @sender_name, @sender_email, @snippet, @text_body, @attachment_names
    )
  `).run({
        message_id: message.id,
        account_id: message.account_id,
        folder: message.folder,
        subject: message.subject,
        sender_name: message.sender_name ?? "",
        sender_email: message.sender_email ?? "",
        snippet: message.snippet,
        text_body: message.text_body,
        attachment_names: attachments.map((attachment) => attachment.filename).join(" ")
    });
}
export const searchIndexRepo = {
    async ensure() {
        if (config.dbDriver !== "sqlite")
            return;
        const messageCount = (await db.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
            count: number;
        }).count;
        const indexCount = (await db.prepare("SELECT COUNT(*) AS count FROM message_search").get() as {
            count: number;
        }).count;
        if (messageCount !== indexCount)
            await this.rebuild();
    },
    async rebuild() {
        if (config.dbDriver !== "sqlite")
            return;
        await db.prepare("DELETE FROM message_search").run();
        const rows = await db.prepare("SELECT id FROM messages ORDER BY created_at ASC").all() as Array<{
            id: string;
        }>;
        for (const row of rows)
            await updateMessageSearchIndex(row.id);
    },
    async refreshMessage(messageId: string) {
        await updateMessageSearchIndex(messageId);
    }
};
export const messageRepo = {
    async seedIfEmpty() {
        const count = await db.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
            count: number;
        };
        if (count.count > 0)
            return;
        const now = nowIso();
        const accountId = "demo-account";
        await db.prepare(`
      INSERT OR IGNORE INTO accounts (
        id, email, display_name, username, password_cipher, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, sync_status, last_sync_at, sync_cursor_uid, sync_uid_validity, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(accountId, "demo@submail.local", "演示邮箱", "demo@submail.local", encryptSecret("demo"), "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "idle", now, 0, null, now, now);
        const samples: UpsertMessageInput[] = [
            {
                accountId,
                folder: "INBOX",
                subject: "欢迎使用 Submail",
                senderName: "Submail",
                senderEmail: "hello@submail.local",
                recipients: ["demo@submail.local"],
                snippet: "你可以添加 IMAP/SMTP 邮箱，通过 Web、App 和 MCP 统一管理邮件。",
                textBody: "你可以添加 IMAP/SMTP 邮箱，通过 Web、App 和 MCP 统一管理邮件。",
                sentAt: now,
                flags: ["seen"],
                isRead: false
            },
            {
                accountId,
                folder: "INBOX",
                subject: "MCP 工具已准备好",
                senderName: "系统通知",
                senderEmail: "system@submail.local",
                recipients: ["demo@submail.local"],
                snippet: "外部 Agent 可以调用 list_accounts、search_mail、read_mail 和 send_mail。",
                textBody: "外部 Agent 可以调用 list_accounts、search_mail、read_mail 和 send_mail。",
                sentAt: now,
                flags: [],
                isRead: true
            }
        ];
        for (const sample of samples) await this.upsert(sample);
    },
    async list(params: {
        query?: string;
        accountId?: string;
        accountIds?: string[];
        folder?: string;
        sender?: string;
        dateFrom?: string;
        dateTo?: string;
        hasAttachment?: boolean;
        limit?: number;
        page?: number;
    }) {
        if (!params.accountId && params.accountIds?.length === 0)
            return [];
        const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
        const page = Math.max(1, Math.trunc(params.page ?? 1));
        const offset = (page - 1) * limit;
        if (config.dbDriver === "sqlite" && params.query?.trim()) {
            const ftsQuery = makeFtsQuery(params.query);
            if (ftsQuery) {
                const clauses: string[] = [];
                const values: unknown[] = [ftsQuery];
                if (params.accountId) {
                    clauses.push("messages.account_id = ?");
                    values.push(params.accountId);
                }
                else if (params.accountIds) {
                    clauses.push(`messages.account_id IN (${params.accountIds.map(() => "?").join(",")})`);
                    values.push(...params.accountIds);
                }
                applyMessageViewFilters(params.folder, clauses, values);
                applyMessageFieldFilters(params, clauses, values);
                const where = clauses.length ? `AND ${clauses.join(" AND ")}` : "";
                values.push(limit, offset);
                try {
                    const results = await db.prepare(`
            SELECT messages.* FROM message_search
            JOIN messages ON messages.id = message_search.message_id
            WHERE message_search MATCH ? ${where}
            ORDER BY rank, COALESCE(messages.sent_at, messages.created_at) DESC
            LIMIT ? OFFSET ?
          `).all(...values) as MessageRecord[];
                    return results;
                }
                catch {
                    // Fall through to LIKE search if FTS syntax/tokenization rejects a query.
                }
            }
        }
        const clauses: string[] = [];
        const values: unknown[] = [];
        if (params.accountId) {
            clauses.push("account_id = ?");
            values.push(params.accountId);
        }
        else if (params.accountIds) {
            clauses.push(`account_id IN (${params.accountIds.map(() => "?").join(",")})`);
            values.push(...params.accountIds);
        }
        applyMessageViewFilters(params.folder, clauses, values, "");
        applyMessageFieldFilters(params, clauses, values, "");
        if (params.query) {
            clauses.push(`(
        subject LIKE ? OR sender_email LIKE ? OR sender_name LIKE ? OR snippet LIKE ? OR text_body LIKE ?
        OR EXISTS (
          SELECT 1 FROM attachments
          WHERE attachments.message_id = messages.id AND attachments.filename LIKE ?
        )
      )`);
            const like = `%${params.query}%`;
            values.push(like, like, like, like, like, like);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        values.push(limit, offset);
        return await db.prepare(`SELECT * FROM messages ${where} ORDER BY COALESCE(sent_at, created_at) DESC LIMIT ? OFFSET ?`).all(...values) as MessageRecord[];
    },
    async count(params: {
        query?: string;
        accountId?: string;
        accountIds?: string[];
        folder?: string;
        sender?: string;
        dateFrom?: string;
        dateTo?: string;
        hasAttachment?: boolean;
    }) {
        if (!params.accountId && params.accountIds?.length === 0)
            return 0;
        if (config.dbDriver === "sqlite" && params.query?.trim()) {
            const ftsQuery = makeFtsQuery(params.query);
            if (ftsQuery) {
                const clauses: string[] = [];
                const values: unknown[] = [ftsQuery];
                if (params.accountId) {
                    clauses.push("messages.account_id = ?");
                    values.push(params.accountId);
                }
                else if (params.accountIds) {
                    clauses.push(`messages.account_id IN (${params.accountIds.map(() => "?").join(",")})`);
                    values.push(...params.accountIds);
                }
                applyMessageViewFilters(params.folder, clauses, values);
                applyMessageFieldFilters(params, clauses, values);
                const where = clauses.length ? `AND ${clauses.join(" AND ")}` : "";
                try {
                    const row = await db.prepare(`
            SELECT COUNT(*) AS count FROM message_search
            JOIN messages ON messages.id = message_search.message_id
            WHERE message_search MATCH ? ${where}
          `).get(...values) as { count: number };
                    return Number(row.count);
                }
                catch {
                    // Fall through to LIKE search if FTS syntax/tokenization rejects a query.
                }
            }
        }
        const clauses: string[] = [];
        const values: unknown[] = [];
        if (params.accountId) {
            clauses.push("account_id = ?");
            values.push(params.accountId);
        }
        else if (params.accountIds) {
            clauses.push(`account_id IN (${params.accountIds.map(() => "?").join(",")})`);
            values.push(...params.accountIds);
        }
        applyMessageViewFilters(params.folder, clauses, values, "");
        applyMessageFieldFilters(params, clauses, values, "");
        if (params.query) {
            clauses.push(`(
        subject LIKE ? OR sender_email LIKE ? OR sender_name LIKE ? OR snippet LIKE ? OR text_body LIKE ?
        OR EXISTS (
          SELECT 1 FROM attachments
          WHERE attachments.message_id = messages.id AND attachments.filename LIKE ?
        )
      )`);
            const like = `%${params.query}%`;
            values.push(like, like, like, like, like, like);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const row = await db.prepare(`SELECT COUNT(*) AS count FROM messages ${where}`).get(...values) as { count: number };
        return Number(row.count);
    },
    async countUnreadInbox(params: { accountId?: string; accountIds?: string[] }) {
        if (!params.accountId && params.accountIds?.length === 0)
            return 0;
        const clauses = ["folder = 'INBOX'", "is_archived = 0", "is_deleted = 0", "is_read = 0"];
        const values: unknown[] = [];
        if (params.accountId) {
            clauses.push("account_id = ?");
            values.push(params.accountId);
        }
        else if (params.accountIds) {
            clauses.push(`account_id IN (${params.accountIds.map(() => "?").join(",")})`);
            values.push(...params.accountIds);
        }
        const row = await db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${clauses.join(" AND ")}`).get(...values) as { count: number };
        return Number(row.count);
    },
    async markAllInboxRead(params: { accountId?: string }) {
        const clauses = ["folder = 'INBOX'", "is_archived = 0", "is_deleted = 0", "is_read = 0"];
        const values: unknown[] = [nowIso()];
        if (params.accountId) {
            clauses.push("account_id = ?");
            values.push(params.accountId);
        }
        const overrideExpression = config.dbDriver === "mysql"
            ? "JSON_SET(CASE WHEN JSON_VALID(local_state_overrides) THEN local_state_overrides ELSE JSON_OBJECT() END, '$.isRead', TRUE)"
            : "json_set(CASE WHEN json_valid(local_state_overrides) THEN local_state_overrides ELSE '{}' END, '$.isRead', json('true'))";
        const result = await db.prepare(`
      UPDATE messages SET
        is_read = 1,
        local_state_overrides = ${overrideExpression},
        updated_at = ?
      WHERE ${clauses.join(" AND ")}
    `).run(...values);
        return result.changes;
    },
    async get(id: string) {
        return await db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRecord | undefined;
    },
    async threadFor(id: string, limit = 100) {
        const anchor = await this.get(id);
        if (!anchor)
            return [];
        const account = await accountRepo.get(anchor.account_id);
        const selfAddresses = new Set([
            account?.email,
            ...parseStoredAliases(account?.aliases ?? "[]").map((alias) => alias.email)
        ].filter((item): item is string => Boolean(item)).map((item) => item.trim().toLowerCase()));
        const anchorSubject = normalizedThreadSubject(anchor.subject);
        const anchorCounterparts = messageCounterparts(anchor, selfAddresses);
        // Sort only the small fields used for thread detection. Sorting complete
        // message bodies can exceed the container's temporary storage once a
        // mailbox has accumulated a few thousand messages.
        const anchorTime = anchor.sent_at ?? anchor.created_at;
        const olderCandidates = await db.prepare(`
      SELECT id, account_id, folder, message_id, in_reply_to, reference_ids,
             subject, sender_email, recipients, sent_at, created_at
      FROM messages
      WHERE account_id = ? AND is_deleted = 0
        AND COALESCE(sent_at, created_at) <= ?
      ORDER BY COALESCE(sent_at, created_at) DESC
      LIMIT 1000
    `).all(anchor.account_id, anchorTime) as ThreadMessageMetadata[];
        const newerCandidates = await db.prepare(`
      SELECT id, account_id, folder, message_id, in_reply_to, reference_ids,
             subject, sender_email, recipients, sent_at, created_at
      FROM messages
      WHERE account_id = ? AND is_deleted = 0
        AND COALESCE(sent_at, created_at) > ?
      ORDER BY COALESCE(sent_at, created_at) ASC
      LIMIT 1000
    `).all(anchor.account_id, anchorTime) as ThreadMessageMetadata[];
        const candidates = [...new Map(
            [...olderCandidates, anchor, ...newerCandidates].map((candidate) => [candidate.id, candidate])
        ).values()].sort((left, right) => {
                const leftTime = Date.parse(left.sent_at ?? left.created_at);
                const rightTime = Date.parse(right.sent_at ?? right.created_at);
                return leftTime - rightTime || left.id.localeCompare(right.id);
        });
        const linkedIds = new Set<string>([anchor.id]);
        const linkedHeaders = messageHeaderIds(anchor);
        let expanded = true;
        while (expanded) {
            expanded = false;
            for (const candidate of candidates) {
                if (linkedIds.has(candidate.id))
                    continue;
                const headers = messageHeaderIds(candidate);
                if (![...headers].some((value) => linkedHeaders.has(value)))
                    continue;
                linkedIds.add(candidate.id);
                for (const value of headers)
                    linkedHeaders.add(value);
                expanded = true;
            }
        }
        const threadCandidates = candidates.filter((candidate) => {
            if (linkedIds.has(candidate.id))
                return true;
            if (!anchorSubject || normalizedThreadSubject(candidate.subject) !== anchorSubject || anchorCounterparts.size === 0)
                return false;
            const counterparts = messageCounterparts(candidate, selfAddresses);
            const sameContact = [...counterparts].some((address) => anchorCounterparts.has(address));
            if (!sameContact)
                return false;
            const replyLike = /^\s*(re|fw|fwd|答复|回复|转发)\s*[:：]/iu.test(anchor.subject)
                || /^\s*(re|fw|fwd|答复|回复|转发)\s*[:：]/iu.test(candidate.subject);
            const oppositeDirection = (anchor.folder === "Sent") !== (candidate.folder === "Sent");
            return replyLike || oppositeDirection;
        });
        const maxThreadSize = Math.max(1, Math.min(limit, 200));
        let selectedCandidates = threadCandidates.slice(-maxThreadSize);
        if (!selectedCandidates.some((candidate) => candidate.id === anchor.id)) {
            selectedCandidates = maxThreadSize === 1
                ? [anchor]
                : [...selectedCandidates.slice(-(maxThreadSize - 1)), anchor].sort((left, right) => {
                    const leftTime = Date.parse(left.sent_at ?? left.created_at);
                    const rightTime = Date.parse(right.sent_at ?? right.created_at);
                    return leftTime - rightTime || left.id.localeCompare(right.id);
                });
        }
        if (selectedCandidates.length === 0)
            return [];
        const placeholders = selectedCandidates.map(() => "?").join(", ");
        const messages = await db.prepare(`SELECT * FROM messages WHERE id IN (${placeholders})`)
            .all(...selectedCandidates.map((candidate) => candidate.id)) as MessageRecord[];
        const messagesById = new Map(messages.map((message) => [message.id, message]));
        return selectedCandidates
            .map((candidate) => messagesById.get(candidate.id))
            .filter((message): message is MessageRecord => Boolean(message));
    },
    async upsert(input: UpsertMessageInput) {
        const id = input.id ?? nanoid();
        const now = nowIso();
        const localSent = input.folder === "Sent" && input.uid !== undefined && input.messageId
            ? await db.prepare(`
        SELECT id, local_state_overrides FROM messages
        WHERE account_id = ? AND folder = 'Sent' AND message_id = ? AND uid IS NULL
        ORDER BY created_at DESC LIMIT 1
      `).get(input.accountId, input.messageId) as { id: string; local_state_overrides: string } | undefined
            : undefined;
        const existingRemote = input.uid !== undefined
            ? await db.prepare(`
        SELECT local_state_overrides, remote_mailbox, remote_uid_validity FROM messages
        WHERE account_id = ? AND folder = ? AND uid = ?
      `).get(input.accountId, input.folder, input.uid) as {
                local_state_overrides: string;
                remote_mailbox: string | null;
                remote_uid_validity: string | null;
            } | undefined
            : undefined;
        const sameRemoteGeneration = existingRemote
            && existingRemote.remote_mailbox === (input.remoteMailbox ?? null)
            && existingRemote.remote_uid_validity === (input.remoteUidValidity ?? null);
        const stateOverrides = parseMessageStateOverrides(
            sameRemoteGeneration ? existingRemote.local_state_overrides : localSent?.local_state_overrides
        );
        const remoteState = {
            isRead: Boolean(input.isRead),
            isStarred: Boolean(input.isStarred),
            isArchived: Boolean(input.isArchived),
            isDeleted: Boolean(input.isDeleted)
        };
        const effectiveState = {
            isRead: stateOverrides.isRead ?? remoteState.isRead,
            isStarred: stateOverrides.isStarred ?? remoteState.isStarred,
            isArchived: stateOverrides.isArchived ?? remoteState.isArchived,
            isDeleted: stateOverrides.isDeleted ?? remoteState.isDeleted
        };
        const record = {
            id,
            account_id: input.accountId,
            folder: input.folder,
            uid: input.uid ?? null,
            message_id: input.messageId ?? null,
            in_reply_to: input.inReplyTo ?? null,
            reference_ids: JSON.stringify(input.references ?? []),
            subject: input.subject || "(无主题)",
            sender_name: input.senderName ?? null,
            sender_email: input.senderEmail ?? null,
            recipients: JSON.stringify(input.recipients ?? []),
            snippet: input.snippet ?? "",
            text_body: input.textBody ?? "",
            html_body: input.htmlBody ?? null,
            sent_at: input.sentAt ?? null,
            flags: JSON.stringify(input.flags ?? []),
            remote_mailbox: input.remoteMailbox ?? null,
            remote_uid_validity: input.remoteUidValidity ?? null,
            remote_state: JSON.stringify(remoteState),
            local_state_overrides: JSON.stringify(stateOverrides),
            is_read: effectiveState.isRead ? 1 : 0,
            is_starred: effectiveState.isStarred ? 1 : 0,
            is_archived: effectiveState.isArchived ? 1 : 0,
            is_deleted: effectiveState.isDeleted ? 1 : 0,
            archived_at: effectiveState.isArchived ? now : null,
            deleted_at: effectiveState.isDeleted ? now : null,
            created_at: now,
            updated_at: now
        };
        if (localSent && !existingRemote) {
                await db.prepare(`
          UPDATE messages SET
            uid = @uid,
            in_reply_to = @in_reply_to,
            reference_ids = @reference_ids,
            subject = @subject,
            sender_name = @sender_name,
            sender_email = @sender_email,
            recipients = @recipients,
            snippet = @snippet,
            text_body = @text_body,
            html_body = @html_body,
            sent_at = @sent_at,
            flags = @flags,
            remote_mailbox = @remote_mailbox,
            remote_uid_validity = @remote_uid_validity,
            remote_state = @remote_state,
            is_read = @is_read,
            is_starred = @is_starred,
            is_archived = @is_archived,
            is_deleted = @is_deleted,
            archived_at = @archived_at,
            deleted_at = @deleted_at,
            updated_at = @updated_at
          WHERE id = @id
        `).run({ ...record, id: localSent.id });
                await updateMessageSearchIndex(localSent.id);
                return await this.get(localSent.id) as MessageRecord;
        }
        await db.prepare(`
      INSERT INTO messages (
        id, account_id, folder, uid, message_id, in_reply_to, reference_ids, subject, sender_name, sender_email,
        recipients, snippet, text_body, html_body, sent_at, flags, remote_mailbox, remote_uid_validity, remote_state, local_state_overrides,
        is_read, is_starred, is_archived, is_deleted, archived_at, deleted_at, created_at, updated_at
      ) VALUES (
        @id, @account_id, @folder, @uid, @message_id, @in_reply_to, @reference_ids, @subject, @sender_name, @sender_email,
        @recipients, @snippet, @text_body, @html_body, @sent_at, @flags, @remote_mailbox, @remote_uid_validity, @remote_state, @local_state_overrides,
        @is_read, @is_starred, @is_archived, @is_deleted, @archived_at, @deleted_at, @created_at, @updated_at
      )
      ON CONFLICT(account_id, folder, uid) DO UPDATE SET
        message_id = excluded.message_id,
        in_reply_to = excluded.in_reply_to,
        reference_ids = excluded.reference_ids,
        subject = excluded.subject,
        sender_name = excluded.sender_name,
        sender_email = excluded.sender_email,
        recipients = excluded.recipients,
        snippet = excluded.snippet,
        text_body = excluded.text_body,
        html_body = excluded.html_body,
        sent_at = excluded.sent_at,
        flags = excluded.flags,
        remote_mailbox = excluded.remote_mailbox,
        remote_uid_validity = excluded.remote_uid_validity,
        remote_state = excluded.remote_state,
        local_state_overrides = excluded.local_state_overrides,
        is_read = excluded.is_read,
        is_starred = excluded.is_starred,
        is_archived = excluded.is_archived,
        is_deleted = excluded.is_deleted,
        archived_at = excluded.archived_at,
        deleted_at = excluded.deleted_at,
        updated_at = excluded.updated_at
    `).run(record);
        if (input.uid !== undefined) {
            const existing = await db.prepare("SELECT * FROM messages WHERE account_id = ? AND folder = ? AND uid = ?")
                .get(input.accountId, input.folder, input.uid) as MessageRecord | undefined;
            if (existing) {
                await updateMessageSearchIndex(existing.id);
                return existing;
            }
        }
        const saved = await this.get(id) ?? (record as MessageRecord);
        await updateMessageSearchIndex(saved.id);
        return saved;
    },
    async removeStaleRemoteIdentity(accountId: string, folder: string, remoteMailbox: string, uidValidity: string, options: {
        adoptLegacyIdentity: boolean;
    }) {
        const unknownIdentityClause = options.adoptLegacyIdentity
            ? ""
            : "remote_mailbox IS NULL OR remote_uid_validity IS NULL OR";
        const staleRows = await db.prepare(`
      SELECT id FROM messages
      WHERE account_id = ? AND folder = ? AND uid IS NOT NULL AND (
        ${unknownIdentityClause}
        (remote_mailbox IS NOT NULL AND remote_mailbox != ?)
        OR (remote_uid_validity IS NOT NULL AND remote_uid_validity != ?)
      )
    `).all(accountId, folder, remoteMailbox, uidValidity) as Array<{ id: string }>;
        if (config.dbDriver === "sqlite") {
            for (let offset = 0; offset < staleRows.length; offset += 250) {
                const ids = staleRows.slice(offset, offset + 250).map((message) => message.id);
                const placeholders = ids.map(() => "?").join(", ");
                await db.prepare(`DELETE FROM message_search WHERE message_id IN (${placeholders})`).run(...ids);
            }
        }
        const result = await db.prepare(`
      DELETE FROM messages
      WHERE account_id = ? AND folder = ? AND uid IS NOT NULL AND (
        ${unknownIdentityClause}
        (remote_mailbox IS NOT NULL AND remote_mailbox != ?)
        OR (remote_uid_validity IS NOT NULL AND remote_uid_validity != ?)
      )
    `).run(accountId, folder, remoteMailbox, uidValidity);
        return result.changes;
    },
    async reconcileRemoteMailbox(accountId: string, folder: string, remoteMailbox: string, states: RemoteMessageState[], options: {
        uidValidity: string;
        adoptLegacyIdentity: boolean;
    }) {
        const remoteByUid = new Map(states.map((state) => [state.uid, state]));
        return db.transaction(async () => {
            const local = await db.prepare(`
        SELECT id, uid, flags, remote_mailbox, remote_uid_validity, remote_state, local_state_overrides,
               is_read, is_starred, is_archived, is_deleted
        FROM messages
        WHERE account_id = ? AND folder = ? AND uid IS NOT NULL
      `).all(accountId, folder) as Array<Pick<MessageRecord,
                "id" | "uid" | "flags" | "remote_mailbox" | "remote_uid_validity" | "remote_state" | "local_state_overrides" |
                "is_read" | "is_starred" | "is_archived" | "is_deleted"
            >>;
            let updated = 0;
            let removed = 0;
            const now = nowIso();
            for (const message of local) {
                const remote = message.uid === null ? undefined : remoteByUid.get(Number(message.uid));
                const missingRemoteIdentity = !options.adoptLegacyIdentity
                    && (message.remote_mailbox === null || message.remote_uid_validity === null);
                const staleRemoteIdentity = missingRemoteIdentity
                    || (message.remote_mailbox !== null && message.remote_mailbox !== remoteMailbox)
                    || (message.remote_uid_validity !== null && message.remote_uid_validity !== options.uidValidity);
                if (!remote || staleRemoteIdentity) {
                    await db.prepare("DELETE FROM messages WHERE id = ?").run(message.id);
                    if (config.dbDriver === "sqlite")
                        await db.prepare("DELETE FROM message_search WHERE message_id = ?").run(message.id);
                    removed += 1;
                    continue;
                }
                const flags = JSON.stringify(remote.flags);
                const remoteState = JSON.stringify({
                    isRead: remote.isRead,
                    isStarred: remote.isStarred,
                    isArchived: remote.isArchived,
                    isDeleted: remote.isDeleted
                });
                const overrides = parseMessageStateOverrides(message.local_state_overrides);
                const nextRead = (overrides.isRead ?? remote.isRead) ? 1 : 0;
                const nextStarred = (overrides.isStarred ?? remote.isStarred) ? 1 : 0;
                const nextArchived = (overrides.isArchived ?? remote.isArchived) ? 1 : 0;
                const nextDeleted = (overrides.isDeleted ?? remote.isDeleted) ? 1 : 0;
                if (message.flags === flags
                    && message.remote_mailbox === remoteMailbox
                    && message.remote_uid_validity === options.uidValidity
                    && message.remote_state === remoteState
                    && message.is_read === nextRead
                    && message.is_starred === nextStarred
                    && message.is_archived === nextArchived
                    && message.is_deleted === nextDeleted)
                    continue;
                await db.prepare(`
          UPDATE messages SET
            flags = ?, remote_mailbox = ?, remote_uid_validity = ?, remote_state = ?,
            is_read = ?, is_starred = ?, is_archived = ?, is_deleted = ?,
            archived_at = ?, deleted_at = ?, updated_at = ?
          WHERE id = ?
        `).run(
                    flags,
                    remoteMailbox,
                    options.uidValidity,
                    remoteState,
                    nextRead,
                    nextStarred,
                    nextArchived,
                    nextDeleted,
                    nextArchived ? now : null,
                    nextDeleted ? now : null,
                    now,
                    message.id
                );
                updated += 1;
            }
            return { updated, removed };
        });
    },
    async remoteUids(accountId: string, folder: string, remoteMailbox: string, uidValidity: string): Promise<Set<number>> {
        const rows = await db.prepare(`
      SELECT uid FROM messages
      WHERE account_id = ? AND folder = ? AND remote_mailbox = ? AND remote_uid_validity = ? AND uid IS NOT NULL
    `).all(accountId, folder, remoteMailbox, uidValidity) as Array<{ uid: number }>;
        return new Set(rows.map((row) => Number(row.uid)));
    },
    async markRead(id: string, isRead: boolean) {
        await this.updateState(id, { isRead });
    },
    async createDraft(input: OutgoingMessageInput) {
        return await this.upsert({
            accountId: input.account.id,
            folder: "Drafts",
            subject: input.subject || "(无主题)",
            senderName: input.senderName ?? input.account.display_name,
            senderEmail: input.senderEmail ?? input.account.email,
            recipients: input.to,
            snippet: textSnippet(input.text),
            textBody: input.text,
            htmlBody: input.html,
            flags: [],
            isRead: true
        });
    },
    async updateDraft(id: string, input: OutgoingMessageInput) {
        const existing = await this.get(id);
        if (!existing || existing.folder !== "Drafts" || existing.remote_mailbox)
            return undefined;
        const now = nowIso();
        await db.prepare(`
      UPDATE messages SET
        account_id = @account_id,
        subject = @subject,
        sender_name = @sender_name,
        sender_email = @sender_email,
        recipients = @recipients,
        snippet = @snippet,
        text_body = @text_body,
        updated_at = @updated_at
      WHERE id = @id AND folder = 'Drafts'
    `).run({
            id,
            account_id: input.account.id,
            subject: input.subject || "(无主题)",
            sender_name: input.senderName ?? input.account.display_name,
            sender_email: input.senderEmail ?? input.account.email,
            recipients: JSON.stringify(input.to),
            snippet: textSnippet(input.text),
            text_body: input.text,
            updated_at: now
        });
        await updateMessageSearchIndex(id);
        return await this.get(id);
    },
    async createSent(input: OutgoingMessageInput, messageId?: string) {
        return await this.upsert({
            accountId: input.account.id,
            folder: "Sent",
            messageId,
            inReplyTo: input.inReplyTo,
            references: input.references,
            subject: input.subject || "(无主题)",
            senderName: input.senderName ?? input.account.display_name,
            senderEmail: input.senderEmail ?? input.account.email,
            recipients: input.to,
            snippet: textSnippet(input.text || (input.html ?? "").replace(/<[^>]*>/g, " ")),
            textBody: input.text,
            htmlBody: input.html,
            sentAt: nowIso(),
            flags: ["seen"],
            isRead: true
        });
    },
    async convertDraftToSent(id: string, messageId?: string) {
        const existing = await this.get(id);
        if (!existing || existing.folder !== "Drafts" || existing.remote_mailbox)
            return undefined;
        const now = nowIso();
        await db.prepare(`
      UPDATE messages SET
        folder = 'Sent',
        uid = NULL,
        remote_mailbox = NULL,
        remote_uid_validity = NULL,
        remote_state = '{}',
        local_state_overrides = '{}',
        message_id = ?,
        sent_at = ?,
        flags = ?,
        is_read = 1,
        is_archived = 0,
        is_deleted = 0,
        archived_at = NULL,
        deleted_at = NULL,
        updated_at = ?
      WHERE id = ? AND folder = 'Drafts'
    `).run(messageId ?? existing.message_id, now, JSON.stringify(["seen"]), now, id);
        await updateMessageSearchIndex(id);
        return await this.get(id);
    },
    async deleteDraft(id: string) {
        const result = await db.prepare("DELETE FROM messages WHERE id = ? AND folder = 'Drafts' AND remote_mailbox IS NULL").run(id);
        if (config.dbDriver === "sqlite")
            await db.prepare("DELETE FROM message_search WHERE message_id = ?").run(id);
        return result.changes > 0;
    },
    async updateState(id: string, input: {
        isRead?: boolean;
        isStarred?: boolean;
        isArchived?: boolean;
        isDeleted?: boolean;
    }) {
        const existing = await this.get(id);
        if (!existing)
            return undefined;
        let isArchived = input.isArchived === undefined ? existing.is_archived : input.isArchived ? 1 : 0;
        let isDeleted = input.isDeleted === undefined ? existing.is_deleted : input.isDeleted ? 1 : 0;
        let archivedAt = input.isArchived === undefined ? existing.archived_at : input.isArchived ? nowIso() : null;
        let deletedAt = input.isDeleted === undefined ? existing.deleted_at : input.isDeleted ? nowIso() : null;
        if (input.isDeleted === true) {
            isArchived = 0;
            archivedAt = null;
        }
        if (input.isDeleted === false) {
            isArchived = 0;
            archivedAt = null;
            deletedAt = null;
        }
        if (input.isArchived === true) {
            isDeleted = 0;
            deletedAt = null;
        }
        const stateOverrides = parseMessageStateOverrides(existing.local_state_overrides);
        if (input.isRead !== undefined)
            stateOverrides.isRead = input.isRead;
        if (input.isStarred !== undefined)
            stateOverrides.isStarred = input.isStarred;
        if (input.isArchived !== undefined)
            stateOverrides.isArchived = input.isArchived;
        if (input.isDeleted !== undefined)
            stateOverrides.isDeleted = input.isDeleted;
        if (input.isDeleted !== undefined)
            stateOverrides.isArchived = false;
        if (input.isArchived === true)
            stateOverrides.isDeleted = false;
        const next = {
            is_read: input.isRead === undefined ? existing.is_read : input.isRead ? 1 : 0,
            is_starred: input.isStarred === undefined ? existing.is_starred : input.isStarred ? 1 : 0,
            is_archived: isArchived,
            is_deleted: isDeleted,
            archived_at: archivedAt,
            deleted_at: deletedAt,
            local_state_overrides: JSON.stringify(stateOverrides),
            updated_at: nowIso(),
            id
        };
        await db.prepare(`
      UPDATE messages SET
        is_read = @is_read,
        is_starred = @is_starred,
        is_archived = @is_archived,
        is_deleted = @is_deleted,
        archived_at = @archived_at,
        deleted_at = @deleted_at,
        local_state_overrides = @local_state_overrides,
        updated_at = @updated_at
      WHERE id = @id
    `).run(next);
        await updateMessageSearchIndex(id);
        return await this.get(id);
    }
};
function toPublicAttachment(attachment: AttachmentRecord & {
    message_subject?: string;
    sender_email?: string | null;
    sent_at?: string | null;
}): PublicAttachment {
    const { content_blob: _contentBlob, ...rest } = attachment;
    return rest;
}
export const attachmentRepo = {
    async seedDemoIfEmpty() {
        const row = await db.prepare("SELECT COUNT(*) AS count FROM attachments").get() as {
            count: number;
        };
        if (row.count > 0)
            return;
        const message = await db.prepare("SELECT id FROM messages WHERE subject = ? ORDER BY created_at ASC LIMIT 1")
            .get("欢迎使用 Submail") as {
            id: string;
        } | undefined;
        if (!message)
            return;
        await this.replaceForMessage(message.id, [
            {
                filename: "submail-demo.txt",
                contentType: "text/plain; charset=utf-8",
                size: Buffer.byteLength("Submail attachment stored in SQLite."),
                content: Buffer.from("Submail attachment stored in SQLite.", "utf8")
            }
        ]);
    },
    async replaceForMessage(messageId: string, attachments: Array<{
        filename: string;
        contentType: string;
        size: number;
        contentId?: string;
        content: Buffer;
    }>) {
        await db.transaction(async () => {
            await db.prepare("DELETE FROM attachments WHERE message_id = ?").run(messageId);
            const insert = db.prepare(`
        INSERT INTO attachments (id, message_id, filename, content_type, size, content_id, content_blob, storage_path, created_at)
        VALUES (@id, @message_id, @filename, @content_type, @size, @content_id, @content_blob, @storage_path, @created_at)
      `);
            for (const attachment of attachments) {
                await insert.run({
                    id: nanoid(),
                    message_id: messageId,
                    filename: attachment.filename || "attachment",
                    content_type: attachment.contentType || "application/octet-stream",
                    size: attachment.size,
                    content_id: attachment.contentId ?? null,
                    content_blob: attachment.content,
                    storage_path: null,
                    created_at: nowIso()
                });
            }
        });
        await updateMessageSearchIndex(messageId);
    },
    async list(input: AttachmentListParams = {}) {
        const params = input;
        const clauses: string[] = [];
        const values: unknown[] = [];
        if (params.query) {
            clauses.push("(attachments.filename LIKE ? OR messages.subject LIKE ? OR messages.sender_email LIKE ?)");
            const query = `%${params.query}%`;
            values.push(query, query, query);
        }
        switch (params.type) {
            case "image":
                clauses.push("attachments.content_type LIKE 'image/%'");
                break;
            case "text":
                clauses.push("(attachments.content_type LIKE 'text/%' OR attachments.content_type IN ('application/json', 'application/xml', 'application/csv'))");
                break;
            case "pdf":
                clauses.push("attachments.content_type = 'application/pdf'");
                break;
            case "archive":
                clauses.push(`(
          attachments.content_type IN ('application/zip', 'application/x-zip-compressed', 'application/x-rar-compressed', 'application/gzip', 'application/x-7z-compressed')
          OR LOWER(attachments.filename) LIKE '%.zip'
          OR LOWER(attachments.filename) LIKE '%.rar'
          OR LOWER(attachments.filename) LIKE '%.gz'
          OR LOWER(attachments.filename) LIKE '%.7z'
        )`);
                break;
            case "other":
                clauses.push(`NOT (
          attachments.content_type LIKE 'image/%'
          OR attachments.content_type LIKE 'text/%'
          OR attachments.content_type IN ('application/json', 'application/xml', 'application/csv', 'application/pdf', 'application/zip', 'application/x-zip-compressed', 'application/x-rar-compressed', 'application/gzip', 'application/x-7z-compressed')
        )`);
                break;
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const pageSize = Math.max(1, Math.min(params.pageSize ?? 20, 100));
        const page = Math.max(1, Math.trunc(params.page ?? 1));
        const offset = (page - 1) * pageSize;
        const countRow = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM attachments
      JOIN messages ON messages.id = attachments.message_id
      ${where}
    `).get(...values) as { count: number };
        const rows = await db.prepare(`
      SELECT
        attachments.*,
        messages.subject AS message_subject,
        messages.sender_email AS sender_email,
        messages.sent_at AS sent_at
      FROM attachments
      JOIN messages ON messages.id = attachments.message_id
      ${where}
      ORDER BY attachments.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...values, pageSize, offset);
        return {
            items: rows.map((row) => toPublicAttachment(row as AttachmentRecord & {
            message_subject: string;
            sender_email: string | null;
            sent_at: string | null;
            })),
            total: Number(countRow.count ?? 0),
            page,
            pageSize
        };
    },
    async listForMessage(messageId: string) {
        return (await db.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at ASC")
            .all(messageId)).map((row) => toPublicAttachment(row as AttachmentRecord));
    },
    async get(id: string) {
        return await db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRecord | undefined;
    },
    async cleanupExpired(retentionDays: number) {
        if (retentionDays <= 0)
            return 0;
        const threshold = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
        const affectedMessages = await db.prepare("SELECT DISTINCT message_id FROM attachments WHERE created_at < ?")
            .all(threshold) as Array<{ message_id: string }>;
        const result = await db.prepare("DELETE FROM attachments WHERE created_at < ?").run(threshold);
        for (const row of affectedMessages)
            await updateMessageSearchIndex(row.message_id);
        return result.changes;
    }
};
export const appSettingsRepo = {
    async getEmailDisplaySettings() {
        const row = await db.prepare("SELECT value, updated_at FROM app_settings WHERE key = 'email_load_external_resources_by_default'").get() as {
            value: string;
            updated_at: string;
        } | undefined;
        return {
            load_external_resources_by_default: row?.value === "1" || row?.value === "true",
            updated_at: row?.updated_at ?? null
        };
    },
    async updateEmailDisplaySettings(input: {
        loadExternalResourcesByDefault: boolean;
    }) {
        const updatedAt = nowIso();
        await db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('email_load_external_resources_by_default', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(input.loadExternalResourcesByDefault ? "1" : "0", updatedAt);
        return {
            load_external_resources_by_default: input.loadExternalResourcesByDefault,
            updated_at: updatedAt
        };
    },
    async getAttachmentSettings() {
        const rows = await db.prepare("SELECT key, value, updated_at FROM app_settings WHERE key IN ('attachment_max_size_bytes', 'attachment_retention_days')").all() as Array<{
            key: string;
            value: string;
            updated_at: string;
        }>;
        const sizeRow = rows.find((row) => row.key === "attachment_max_size_bytes");
        const retentionRow = rows.find((row) => row.key === "attachment_retention_days");
        const parsed = Number(sizeRow?.value);
        const retentionDays = Number(retentionRow?.value);
        return {
            max_size_bytes: Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 1024 * 1024,
            retention_days: Number.isFinite(retentionDays) && retentionDays >= 0 ? retentionDays : 0,
            updated_at: sizeRow?.updated_at ?? retentionRow?.updated_at ?? null
        };
    },
    async updateAttachmentSettings(input: {
        maxSizeBytes: number;
        retentionDays: number;
    }) {
        const maxSizeBytes = Math.max(1, Math.min(25, Math.round(input.maxSizeBytes / 1024 / 1024))) * 1024 * 1024;
        const retentionDays = Math.max(0, Math.min(3650, Math.round(input.retentionDays)));
        const updatedAt = nowIso();
        await db.transaction(async () => {
            await db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('attachment_max_size_bytes', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(maxSizeBytes), updatedAt);
            await db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('attachment_retention_days', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(retentionDays), updatedAt);
        });
        return { max_size_bytes: maxSizeBytes, retention_days: retentionDays, updated_at: updatedAt };
    }
};
function toPublicSavedSearch(row: SavedSearchRecord): PublicSavedSearch {
    let criteria: SavedSearchCriteria = {};
    try {
        const parsed = JSON.parse(row.criteria_json) as SavedSearchCriteria;
        criteria = {
            query: parsed.query ?? "",
            sender: parsed.sender ?? "",
            dateFrom: parsed.dateFrom ?? "",
            dateTo: parsed.dateTo ?? "",
            hasAttachment: Boolean(parsed.hasAttachment),
            folder: parsed.folder ?? "INBOX",
            accountId: parsed.accountId ?? ""
        };
    }
    catch {
        criteria = {};
    }
    const { criteria_json: _criteriaJson, ...rest } = row;
    return { ...rest, criteria };
}
export const savedSearchRepo = {
    async list() {
        return (await db.prepare("SELECT * FROM saved_searches ORDER BY updated_at DESC")
            .all()).map((row) => toPublicSavedSearch(row as SavedSearchRecord));
    },
    async create(input: {
        name: string;
        criteria: SavedSearchCriteria;
    }) {
        const now = nowIso();
        const record: SavedSearchRecord = {
            id: nanoid(),
            name: input.name.trim(),
            criteria_json: JSON.stringify(input.criteria),
            created_at: now,
            updated_at: now
        };
        await db.prepare(`
      INSERT INTO saved_searches (id, name, criteria_json, created_at, updated_at)
      VALUES (@id, @name, @criteria_json, @created_at, @updated_at)
    `).run(record);
        return toPublicSavedSearch(record);
    },
    async delete(id: string) {
        const result = await db.prepare("DELETE FROM saved_searches WHERE id = ?").run(id);
        return result.changes > 0;
    }
};
export const mcpLogRepo = {
    async list(limit = 50) {
        return await db.prepare("SELECT id, tool_name, input_json, status, created_at FROM mcp_call_logs ORDER BY created_at DESC LIMIT ?")
            .all(Math.max(1, Math.min(limit, 200))) as Array<{
            id: string;
            tool_name: string;
            input_json: string;
            status: string;
            created_at: string;
        }>;
    },
    async record(toolName: string, input: unknown, status: "ok" | "error") {
        const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
        const summary = {
            fields: Object.keys(record).sort(),
            accountId: typeof record.accountId === "string" ? record.accountId : undefined,
            messageId: typeof record.messageId === "string" ? record.messageId : typeof record.id === "string" ? record.id : undefined,
            recipientCount: Array.isArray(record.to) ? record.to.length : undefined,
            attachmentCount: Array.isArray(record.attachments) ? record.attachments.length : undefined
        };
        await db.prepare("INSERT INTO mcp_call_logs (id, tool_name, input_json, status, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(nanoid(), toolName, JSON.stringify(summary), status, nowIso());
    }
};
export const sendIdempotencyRepo = {
    async claim(key: string, accountId: string, requestHash: string) {
        const now = nowIso();
        const pendingJson = JSON.stringify({ __submail_pending: true });
        const inserted = await db.prepare(`
      INSERT OR IGNORE INTO send_idempotency (idempotency_key, account_id, request_hash, response_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(key, accountId, requestHash, pendingJson, now);
        if (inserted.changes > 0)
            return { status: "claimed" };
        const row = await db.prepare("SELECT account_id, request_hash, response_json, created_at FROM send_idempotency WHERE idempotency_key = ?")
            .get(key) as {
            account_id: string;
            request_hash: string;
            response_json: string;
            created_at: string;
        } | undefined;
        if (!row || row.account_id !== accountId)
            return { status: "pending" };
        if (row.request_hash !== requestHash)
            return { status: "conflict" };
        try {
            const parsed = JSON.parse(row.response_json) as {
                __submail_pending?: boolean;
            };
            if (!parsed?.__submail_pending)
                return { status: "replay", response: parsed };
            const staleThreshold = Date.now() - 5 * 60000;
            if (new Date(row.created_at).getTime() < staleThreshold) {
                const reclaimed = await db.prepare(`
          UPDATE send_idempotency SET created_at = ?
          WHERE idempotency_key = ? AND account_id = ? AND response_json = ? AND created_at = ?
        `).run(now, key, accountId, pendingJson, row.created_at);
                if (reclaimed.changes > 0)
                    return { status: "claimed" };
            }
            return { status: "pending" };
        }
        catch {
            return { status: "pending" };
        }
    },
    async complete(key: string, accountId: string, response: unknown) {
        await db.prepare("UPDATE send_idempotency SET response_json = ? WHERE idempotency_key = ? AND account_id = ?")
            .run(JSON.stringify(response), key, accountId);
    },
    async release(key: string, accountId: string) {
        await db.prepare("DELETE FROM send_idempotency WHERE idempotency_key = ? AND account_id = ? AND response_json = ?")
            .run(key, accountId, JSON.stringify({ __submail_pending: true }));
    },
    async cleanup(retentionDays = 7) {
        const threshold = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
        await db.prepare("DELETE FROM send_idempotency WHERE created_at < ?").run(threshold);
    }
};
export const maintenanceRepo = {
    async cleanup() {
        const now = nowIso();
        const auditThreshold = new Date(Date.now() - config.auditRetentionDays * 24 * 60 * 60 * 1000).toISOString();
        const syncSettings = await db.prepare("SELECT retention_days FROM sync_settings WHERE id = 'default'").get() as { retention_days: number } | undefined;
        const syncThreshold = new Date(Date.now() - (syncSettings?.retention_days ?? config.syncRunRetentionDays) * 24 * 60 * 60 * 1000).toISOString();
        const attachmentSetting = await db.prepare("SELECT value FROM app_settings WHERE key = 'attachment_retention_days'").get() as { value: string } | undefined;
        const attachmentRetentionDays = Number(attachmentSetting?.value ?? 0);
        const attachmentThreshold = attachmentRetentionDays > 0
            ? new Date(Date.now() - attachmentRetentionDays * 24 * 60 * 60 * 1000).toISOString()
            : undefined;
        const affectedMessages = attachmentThreshold
            ? await db.prepare("SELECT DISTINCT message_id FROM attachments WHERE created_at < ?")
                .all(attachmentThreshold) as Array<{ message_id: string }>
            : [];
        const usageThreshold = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const result = await db.transaction(async () => ({
            sessions: (await db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(now)).changes,
            mcpLogs: (await db.prepare("DELETE FROM mcp_call_logs WHERE created_at < ?").run(auditThreshold)).changes,
            syncRuns: (await db.prepare("DELETE FROM sync_runs WHERE finished_at IS NOT NULL AND finished_at < ? AND status != 'running'").run(syncThreshold)).changes,
            attachments: attachmentThreshold ? (await db.prepare("DELETE FROM attachments WHERE created_at < ?").run(attachmentThreshold)).changes : 0,
            dailyUsage: (await db.prepare("DELETE FROM api_key_daily_usage WHERE usage_date < ?").run(usageThreshold)).changes
        }));
        for (const row of affectedMessages)
            await updateMessageSearchIndex(row.message_id);
        return result;
    }
};
export type SyncSettings = {
    id: string;
    enabled: boolean;
    interval_minutes: number;
    initial_limit: number;
    retry_max_attempts: number;
    retry_delay_minutes: number;
    concurrency_limit: number;
    retention_days: number;
    last_run_at: string | null;
    next_run_at: string | null;
    updated_at: string;
};
export type SyncRunRecord = {
    id: string;
    account_id: string | null;
    trigger_type: string;
    status: string;
    imported: number;
    error: string | null;
    attempts: number;
    next_retry_at: string | null;
    started_at: string;
    finished_at: string | null;
};
export type SyncRunStatus = "ok" | "error" | "skipped" | "running" | "retry_scheduled" | "cancelled";
function addMinutes(date: Date, minutes: number): string {
    return new Date(date.getTime() + minutes * 60 * 1000).toISOString();
}
function toSyncSettings(row: {
    id: string;
    enabled: number;
    interval_minutes: number;
    initial_limit: number;
    retry_max_attempts: number;
    retry_delay_minutes: number;
    concurrency_limit: number;
    retention_days: number;
    last_run_at: string | null;
    next_run_at: string | null;
    updated_at: string;
}): SyncSettings {
    return {
        ...row,
        enabled: Boolean(row.enabled)
    };
}
export const syncSettingsRepo = {
    async get() {
        const existing = await db.prepare("SELECT * FROM sync_settings WHERE id = 'default'").get() as Parameters<typeof toSyncSettings>[0] | undefined;
        if (existing)
            return toSyncSettings(existing);
        const now = nowIso();
        const row = {
            id: "default",
            enabled: 0,
            interval_minutes: 15,
            initial_limit: 30,
            retry_max_attempts: 1,
            retry_delay_minutes: 5,
            concurrency_limit: 2,
            retention_days: 30,
            last_run_at: null,
            next_run_at: addMinutes(new Date(), 15),
            updated_at: now
        };
        await db.prepare(`
      INSERT INTO sync_settings (
        id, enabled, interval_minutes, initial_limit, retry_max_attempts, retry_delay_minutes, concurrency_limit, retention_days,
        last_run_at, next_run_at, updated_at
      ) VALUES (
        @id, @enabled, @interval_minutes, @initial_limit, @retry_max_attempts, @retry_delay_minutes, @concurrency_limit, @retention_days,
        @last_run_at, @next_run_at, @updated_at
      )
    `)
            .run(row);
        return toSyncSettings(row);
    },
    async update(input: {
        enabled: boolean;
        intervalMinutes: number;
        initialLimit: number;
        retryMaxAttempts: number;
        retryDelayMinutes: number;
        concurrencyLimit: number;
        retentionDays: number;
    }) {
        const interval = Math.max(1, Math.min(1440, input.intervalMinutes));
        const initialLimit = Math.max(1, Math.min(1000, input.initialLimit));
        const retryMaxAttempts = Math.max(1, Math.min(10, input.retryMaxAttempts));
        const retryDelayMinutes = Math.max(1, Math.min(1440, input.retryDelayMinutes));
        const concurrencyLimit = Math.max(1, Math.min(10, input.concurrencyLimit));
        const retentionDays = Math.max(1, Math.min(3650, input.retentionDays));
        const nextRunAt = addMinutes(new Date(), interval);
        await db.prepare(`
      INSERT INTO sync_settings (
        id, enabled, interval_minutes, initial_limit, retry_max_attempts, retry_delay_minutes, concurrency_limit, retention_days,
        last_run_at, next_run_at, updated_at
      )
      VALUES ('default', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        interval_minutes = excluded.interval_minutes,
        initial_limit = excluded.initial_limit,
        retry_max_attempts = excluded.retry_max_attempts,
        retry_delay_minutes = excluded.retry_delay_minutes,
        concurrency_limit = excluded.concurrency_limit,
        retention_days = excluded.retention_days,
        next_run_at = excluded.next_run_at,
        updated_at = excluded.updated_at
    `).run(input.enabled ? 1 : 0, interval, initialLimit, retryMaxAttempts, retryDelayMinutes, concurrencyLimit, retentionDays, nextRunAt, nowIso());
        return await this.get();
    },
    async markScheduledRunStarted() {
        const settings = await this.get();
        const now = new Date();
        await db.prepare("UPDATE sync_settings SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = 'default'")
            .run(now.toISOString(), addMinutes(now, settings.interval_minutes), now.toISOString());
        return await this.get();
    }
};
export const syncRunRepo = {
    async recoverInterrupted() {
        const result = await db.prepare(`
      UPDATE sync_runs
      SET status = 'error', error = COALESCE(error, '任务因服务重启而中断'), finished_at = ?
      WHERE status = 'running'
    `).run(nowIso());
        return result.changes;
    },
    async start(input: {
        accountId?: string;
        triggerType: "manual" | "manual_all" | "scheduled";
    }) {
        const record: SyncRunRecord = {
            id: nanoid(),
            account_id: input.accountId ?? null,
            trigger_type: input.triggerType,
            status: "running",
            imported: 0,
            error: null,
            attempts: 0,
            next_retry_at: null,
            started_at: nowIso(),
            finished_at: null
        };
        await db.prepare(`
      INSERT INTO sync_runs (
        id, account_id, trigger_type, status, imported, error, attempts, next_retry_at, started_at, finished_at
      ) VALUES (
        @id, @account_id, @trigger_type, @status, @imported, @error, @attempts, @next_retry_at, @started_at, @finished_at
      )
    `)
            .run(record);
        return record;
    },
    async markRunning(id: string) {
        await db.prepare("UPDATE sync_runs SET status = 'running', next_retry_at = NULL, started_at = ?, finished_at = NULL WHERE id = ?")
            .run(nowIso(), id);
        return await this.get(id);
    },
    async finish(id: string, input: {
        status: SyncRunStatus;
        imported?: number;
        error?: string;
        attempts?: number;
        nextRetryAt?: string | null;
    }) {
        await db.prepare("UPDATE sync_runs SET status = ?, imported = ?, error = ?, attempts = ?, next_retry_at = ?, finished_at = ? WHERE id = ?")
            .run(input.status, input.imported ?? 0, input.error ?? null, input.attempts ?? 0, input.nextRetryAt ?? null, nowIso(), id);
        return await this.get(id);
    },
    async get(id: string) {
        return await db.prepare("SELECT * FROM sync_runs WHERE id = ?").get(id) as SyncRunRecord | undefined;
    },
    async list(input: {
        page?: number;
        pageSize?: number;
        status?: SyncRunStatus;
        triggerType?: string;
        accountId?: string;
    } = {}) {
        const clauses: string[] = [];
        const values: unknown[] = [];
        if (input.status) {
            clauses.push("status = ?");
            values.push(input.status);
        }
        if (input.triggerType) {
            clauses.push("trigger_type = ?");
            values.push(input.triggerType);
        }
        if (input.accountId) {
            clauses.push("account_id = ?");
            values.push(input.accountId);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const pageSize = Math.max(1, Math.min(input.pageSize ?? 20, 100));
        const page = Math.max(1, Math.trunc(input.page ?? 1));
        const offset = (page - 1) * pageSize;
        const countRow = await db.prepare(`SELECT COUNT(*) AS count FROM sync_runs ${where}`).get(...values) as { count: number };
        const items = await db.prepare(`SELECT * FROM sync_runs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
            .all(...values, pageSize, offset) as SyncRunRecord[];
        return { items, total: Number(countRow.count ?? 0), page, pageSize };
    },
    async cancel(id: string) {
        const run = await this.get(id);
        if (!run)
            return undefined;
        if (run.status !== "retry_scheduled")
            return run;
        await db.prepare("UPDATE sync_runs SET status = 'cancelled', error = ?, next_retry_at = NULL, finished_at = ? WHERE id = ?")
            .run("管理员取消等待重试", nowIso(), id);
        return await this.get(id);
    },
    async delete(id: string) {
        const result = await db.prepare("DELETE FROM sync_runs WHERE id = ? AND status != 'running'").run(id);
        return result.changes > 0;
    },
    async cleanup(retentionDays: number) {
        const threshold = new Date(Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000).toISOString();
        const result = await db.prepare("DELETE FROM sync_runs WHERE status != 'running' AND finished_at IS NOT NULL AND finished_at < ?").run(threshold);
        return result.changes;
    },
    async listDueRetries(limit = 10) {
        return await db.prepare(`
      SELECT * FROM sync_runs
      WHERE status = 'retry_scheduled'
        AND next_retry_at IS NOT NULL
        AND next_retry_at <= ?
      ORDER BY next_retry_at ASC
      LIMIT ?
    `).all(nowIso(), Math.max(1, Math.min(limit, 50))) as SyncRunRecord[];
    }
};
