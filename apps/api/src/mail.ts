import { simpleParser } from "mailparser";
import { ImapFlow, type FetchMessageObject, type ListResponse } from "imapflow";
import nodemailer from "nodemailer";
import Pop3Command from "node-pop3";
import { accountRepo, appSettingsRepo, attachmentRepo, mailboxCursorRepo, messageRepo, pop3SeenRepo, type RemoteMessageState, type UpsertMessageInput } from "./repositories.js";
import type { AccountRecord } from "./types.js";
import { config } from "./config.js";
import { db } from "./db.js";
function textSnippet(value: string): string {
    return value.replace(/\s+/g, " ").trim().slice(0, 180);
}
type ParsedAddress = {
    name?: string;
    address?: string;
};
function firstAddress(value: unknown): ParsedAddress | undefined {
    const values = Array.isArray(value) ? value : [value];
    const object = values.find((item) => item && typeof item === "object") as {
        value?: ParsedAddress[];
    } | undefined;
    return object?.value?.at(0);
}
function addressList(value: unknown): string[] {
    const values = Array.isArray(value) ? value : [value];
    return values
        .flatMap((item) => {
        if (!item || typeof item !== "object")
            return [];
        return ((item as {
            value?: ParsedAddress[];
        }).value ?? [])
            .map((address) => address.address ?? address.name)
            .filter((address): address is string => Boolean(address));
    });
}
function truncateUtf8(value: string, maxBytes: number): string {
    const content = Buffer.from(value, "utf8");
    if (content.length <= maxBytes)
        return value;
    return `${content.subarray(0, maxBytes).toString("utf8")}\n\n[正文过长，已截断]`;
}
function sizeLabel(value: number): string {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
type LocalMailboxFolder = "INBOX" | "Sent" | "Drafts" | "Trash" | "Archive";
type PreparedImapImport = {
    message: UpsertMessageInput;
    attachments: Array<{
        filename: string;
        contentType: string;
        size: number;
        contentId?: string;
        content: Buffer;
    }>;
};
const maxPreparedImapBytes = 64 * 1024 * 1024;
class StaleMailboxSyncError extends Error {
}
export function selectImapPreparationBatch(messages: FetchMessageObject[], selection: "oldest" | "newest", byteBudget = maxPreparedImapBytes): FetchMessageObject[] {
    const orderedMessages = selection === "newest" ? [...messages].reverse() : messages;
    const selectedMessages: FetchMessageObject[] = [];
    let plannedBytes = 0;
    for (const message of orderedMessages) {
        const reportedSize = Number(message.size ?? 0);
        const estimatedBytes = reportedSize > config.maxIncomingMessageBytes
            ? 1024
            : reportedSize > 0
                ? reportedSize
                : config.maxIncomingMessageBytes;
        if (selectedMessages.length > 0 && plannedBytes + estimatedBytes > byteBudget)
            break;
        selectedMessages.push(message);
        plannedBytes += estimatedBytes;
    }
    return selection === "newest" ? selectedMessages.reverse() : selectedMessages;
}
export type ImapSyncTarget = {
    mailboxPath: string;
    localFolder: LocalMailboxFolder;
    gmailArchive: boolean;
};
const mailboxFallbackNames = {
    Sent: new Set(["sent", "sent mail", "sent messages", "sent items", "已发送", "已发送邮件"]),
    Drafts: new Set(["draft", "drafts", "草稿", "草稿箱", "草稿邮件"]),
    Trash: new Set(["trash", "bin", "deleted", "deleted items", "垃圾箱", "已删除", "已删除邮件"]),
    Archive: new Set(["archive", "archives", "archived", "归档", "已归档", "存档"])
} as const;
function selectableMailbox(mailbox: ListResponse): boolean {
    return !mailbox.flags?.has("\\Noselect");
}
function findSpecialMailbox(mailboxes: ListResponse[], specialUse: string, commonNames: ReadonlySet<string>): ListResponse | undefined {
    const bySpecialUse = mailboxes.find((mailbox) => selectableMailbox(mailbox) && mailbox.specialUse === specialUse);
    if (bySpecialUse)
        return bySpecialUse;
    return mailboxes.find((mailbox) => {
        if (!selectableMailbox(mailbox))
            return false;
        const leaf = mailbox.path.split(mailbox.delimiter || "/").at(-1)?.trim().toLowerCase() ?? "";
        return commonNames.has(leaf);
    });
}
export function discoverImapSyncTargets(mailboxes: ListResponse[], gmailLabels: boolean): ImapSyncTarget[] {
    const targets: ImapSyncTarget[] = [{ mailboxPath: "INBOX", localFolder: "INBOX", gmailArchive: false }];
    const candidates: Array<[ListResponse | undefined, LocalMailboxFolder, boolean]> = [
        [findSpecialMailbox(mailboxes, "\\Sent", mailboxFallbackNames.Sent), "Sent", false],
        [findSpecialMailbox(mailboxes, "\\Drafts", mailboxFallbackNames.Drafts), "Drafts", false],
        [findSpecialMailbox(mailboxes, "\\Trash", mailboxFallbackNames.Trash), "Trash", false]
    ];
    const archive = findSpecialMailbox(mailboxes, "\\Archive", mailboxFallbackNames.Archive);
    const gmailAll = gmailLabels
        ? mailboxes.find((mailbox) => selectableMailbox(mailbox) && mailbox.specialUse === "\\All")
        : undefined;
    candidates.push([gmailAll ?? archive, "Archive", Boolean(gmailAll)]);
    const seen = new Set(["INBOX"]);
    for (const [mailbox, localFolder, gmailArchive] of candidates) {
        if (!mailbox || seen.has(mailbox.path))
            continue;
        seen.add(mailbox.path);
        targets.push({ mailboxPath: mailbox.path, localFolder, gmailArchive });
    }
    return targets;
}
function gmailLabelsFor(message: FetchMessageObject): Set<string> {
    return new Set([...message.labels ?? []].map((label) => label.trim().toLowerCase()));
}
export function belongsToTarget(message: FetchMessageObject, target: ImapSyncTarget): boolean {
    if (!target.gmailArchive)
        return true;
    if (!message.labels)
        return false;
    const labels = gmailLabelsFor(message);
    return !["\\inbox", "\\sent", "\\draft", "\\drafts", "\\trash", "\\spam", "\\junk"]
        .some((label) => labels.has(label));
}
export function remoteMessageState(message: FetchMessageObject, target: ImapSyncTarget) {
    const flags = [...message.flags ?? []].sort();
    const labels = gmailLabelsFor(message);
    return {
        uid: message.uid,
        flags,
        isRead: target.localFolder === "Sent" || flags.includes("\\Seen"),
        isStarred: flags.includes("\\Flagged") || labels.has("\\starred"),
        isArchived: target.localFolder === "Archive",
        isDeleted: target.localFolder === "Trash"
    };
}
function providerAuthHint(email: string): string {
    const domain = email.split("@").at(-1)?.toLowerCase() ?? "";
    if (domain === "gmail.com" || domain === "googlemail.com")
        return "Gmail 开启两步验证后，请使用 16 位应用专用密码；POP/IMAP 还需在 Gmail 设置中允许对应协议。";
    if (["qq.com", "foxmail.com"].includes(domain))
        return "QQ 邮箱需要在账号与安全设置中开启 POP3/IMAP/SMTP，并使用生成的客户端授权码。";
    if (["163.com", "126.com", "yeah.net"].includes(domain))
        return "网易邮箱需要开启客户端服务，并使用客户端授权码，不是网页登录密码。";
    if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain))
        return "Microsoft 账号启用两步验证时可使用应用密码；若组织策略只允许 OAuth，此版本暂不能用密码方式接入。";
    if (["icloud.com", "me.com", "mac.com"].includes(domain))
        return "iCloud 邮箱需要在 Apple 账户中生成 App 专用密码；iCloud 不提供 POP3，请选择 IMAP。";
    if (["yahoo.com", "yahoo.com.cn"].includes(domain))
        return "Yahoo 邮箱通常需要生成第三方应用密码。";
    return "如邮箱开启了二次验证，请填写服务商生成的应用专用密码或客户端授权码；邮件协议无法弹出短信/OTP 验证。";
}
function connectionError(account: AccountRecord, error: unknown, protocol: "IMAP" | "POP3" | "SMTP", password: string): string {
    const source = error as {
        message?: string;
        responseText?: string;
        response?: string;
        serverResponseCode?: string;
        authenticationFailed?: boolean;
        code?: string;
    } | undefined;
    const raw = [source?.responseText, source?.response, source?.message, source?.serverResponseCode]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .join(" · ") || `${protocol} connection failed`;
    const sanitized = password ? raw.split(password).join("[已隐藏]") : raw;
    if (/application-specific password required/i.test(sanitized))
        return `${protocol} 认证失败：Gmail 要求使用应用专用密码。请先为 Google 账号开启两步验证，再生成 16 位应用专用密码并更新此邮箱；不要填写网页登录密码。`;
    if (source?.authenticationFailed || /auth|login|password|credential|invalid user|authentication|认证|授权|密码|登录/i.test(sanitized))
        return `${protocol} 认证失败。${providerAuthHint(account.email)}`;
    if (source?.code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/i.test(sanitized))
        return `${protocol} 服务器地址无法解析，请检查主机名是否正确。`;
    if (/timeout|timed out|ETIMEDOUT/i.test(sanitized))
        return `${protocol} 连接超时，请检查端口、防火墙和 TLS 设置。`;
    return sanitized;
}
async function syncMailbox(client: ImapFlow, account: AccountRecord, target: ImapSyncTarget, initialLimit: number, attachmentLimit: number, gmailLabels: boolean): Promise<{
    imported: number;
    cursorUid: number;
}> {
    const mailbox = await client.mailboxOpen(target.mailboxPath);
    const uidValidity = mailbox.uidValidity.toString();
    const storedCursor = await mailboxCursorRepo.get(account.id, target.mailboxPath);
    const legacyCursor = target.localFolder === "INBOX" && !storedCursor
        ? { cursor_uid: Number(account.sync_cursor_uid ?? 0), uid_validity: account.sync_uid_validity }
        : undefined;
    const cursorRecord = storedCursor ?? legacyCursor;
    const highestKnownUid = Math.max(0, mailbox.uidNext - 1);
    const cursorValid = cursorRecord?.uid_validity === uidValidity;
    const cursorUid = cursorValid ? Number(cursorRecord?.cursor_uid ?? 0) : 0;
    const batchLimit = Math.max(1, Math.min(1000, initialLimit));
    const lastReconcileAt = Date.parse(storedCursor?.last_reconcile_at ?? "");
    const shouldReconcile = !cursorValid
        || !Number.isFinite(lastReconcileAt)
        || Date.now() - lastReconcileAt >= 6 * 60 * 60 * 1000;
    const preparedImports: PreparedImapImport[] = [];

    async function importRange(fetchRange: string | number[], useUidRange: boolean, selection: "oldest" | "newest"): Promise<{
        imported: number;
        processed: number;
        minUid: number;
        maxUid: number;
    }> {
        const fetchedMessages: FetchMessageObject[] = [];
        let imported = 0;
        for await (const message of client.fetch(fetchRange, { uid: true, envelope: true, flags: true, labels: gmailLabels, size: true }, { uid: useUidRange })) {
            fetchedMessages.push(message);
        }
        const selectedMessages = selectImapPreparationBatch(fetchedMessages, selection);
        const minUid = selectedMessages.reduce((value, message) => Math.min(value, message.uid), Number.POSITIVE_INFINITY);
        const maxUid = selectedMessages.reduce((value, message) => Math.max(value, message.uid), 0);
        const messages = selectedMessages.filter((message) => belongsToTarget(message, target));
        // Finish the FETCH iterator before fetchOne calls on the same connection.
        for (const message of messages) {
            const remoteState = remoteMessageState(message, target);
            if ((message.size ?? 0) > config.maxIncomingMessageBytes) {
                const from = message.envelope?.from?.[0];
                preparedImports.push({
                    message: {
                        accountId: account.id,
                        folder: target.localFolder,
                        uid: message.uid,
                        subject: message.envelope?.subject ?? "(无主题)",
                        senderName: from?.name,
                        senderEmail: from?.address,
                        recipients: (message.envelope?.to ?? []).map((address) => address.address).filter((address): address is string => Boolean(address)),
                        snippet: `邮件大小 ${sizeLabel(message.size ?? 0)}，超过接收上限 ${sizeLabel(config.maxIncomingMessageBytes)}，仅保存元数据。`,
                        textBody: "该邮件超过管理员配置的接收大小上限，正文和附件未下载。",
                        sentAt: message.envelope?.date?.toISOString(),
                        flags: remoteState.flags,
                        isRead: remoteState.isRead,
                        isStarred: remoteState.isStarred,
                        isArchived: remoteState.isArchived,
                        isDeleted: remoteState.isDeleted,
                        remoteMailbox: target.mailboxPath,
                        remoteUidValidity: uidValidity
                    },
                    attachments: []
                });
                imported += 1;
                continue;
            }
            const sourceMessage = await client.fetchOne(String(message.uid), { source: true }, { uid: true });
            if (!sourceMessage || !sourceMessage.source) {
                throw new Error(`邮箱目录 ${target.mailboxPath} 无法完整读取 UID ${message.uid}，本次同步未提交`);
            }
            const parsed = await simpleParser(sourceMessage.source);
            const from = firstAddress(parsed.from);
            const recipients = [...addressList(parsed.to), ...addressList(parsed.cc)];
            const text = truncateUtf8(parsed.text ?? "", config.maxIncomingBodyBytes);
            const htmlText = truncateUtf8(typeof parsed.html === "string" ? parsed.html : "", config.maxIncomingBodyBytes);
            const skippedAttachments = parsed.attachments.filter((attachment) => (attachment.size ?? attachment.content.length) > attachmentLimit);
            preparedImports.push({
                message: {
                    accountId: account.id,
                    folder: target.localFolder,
                    uid: message.uid,
                    messageId: parsed.messageId,
                    inReplyTo: parsed.inReplyTo,
                    references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [],
                    subject: parsed.subject ?? "(无主题)",
                    senderName: from?.name,
                    senderEmail: from?.address,
                    recipients,
                    snippet: textSnippet(`${text || htmlText.replace(/<[^>]*>/g, " ") || ""}${skippedAttachments.length ? ` [${skippedAttachments.length} 个超限附件未保存]` : ""}`),
                    textBody: text,
                    htmlBody: htmlText || undefined,
                    sentAt: parsed.date?.toISOString(),
                    flags: remoteState.flags,
                    isRead: remoteState.isRead,
                    isStarred: remoteState.isStarred,
                    isArchived: remoteState.isArchived,
                    isDeleted: remoteState.isDeleted,
                    remoteMailbox: target.mailboxPath,
                    remoteUidValidity: uidValidity
                },
                attachments: parsed.attachments
                    .filter((attachment) => (attachment.size ?? attachment.content.length) <= attachmentLimit)
                    .map((attachment) => ({
                    filename: attachment.filename ?? "attachment",
                    contentType: attachment.contentType ?? "application/octet-stream",
                    size: attachment.size ?? attachment.content.length,
                    contentId: attachment.contentId,
                    content: attachment.content
                    }))
            });
            imported += 1;
        }
        return {
            imported,
            processed: selectedMessages.length,
            minUid: Number.isFinite(minUid) ? minUid : 0,
            maxUid
        };
    }

    const remoteStates: RemoteMessageState[] = [];
    if (shouldReconcile && mailbox.exists > 0) {
        for await (const message of client.fetch("1:*", { uid: true, flags: true, labels: gmailLabels })) {
            if (belongsToTarget(message, target))
                remoteStates.push(remoteMessageState(message, target));
        }
    }
    let imported = 0;
    let nextCursorUid = cursorUid;
    let backfillBeforeUid = cursorValid && storedCursor ? Number(storedCursor.backfill_before_uid ?? 0) : 0;
    let backfillComplete = cursorValid && storedCursor ? Boolean(storedCursor.backfill_complete) : false;
    if (target.gmailArchive && shouldReconcile) {
        const localUids = cursorValid
            ? await messageRepo.remoteUids(account.id, target.localFolder, target.mailboxPath, uidValidity)
            : new Set<number>();
        const missingUids = remoteStates
            .map((state) => state.uid)
            .filter((uid) => !localUids.has(uid))
            .sort((left, right) => left - right);
        const selectedUids = missingUids.slice(-batchLimit);
        if (selectedUids.length > 0) {
            const archiveBatch = await importRange(selectedUids, true, "newest");
            imported += archiveBatch.imported;
            backfillBeforeUid = archiveBatch.minUid || selectedUids[0];
            backfillComplete = missingUids.length <= archiveBatch.processed;
        }
        else {
            backfillBeforeUid = 1;
            backfillComplete = true;
        }
        nextCursorUid = highestKnownUid;
    }
    else if (mailbox.exists === 0) {
        backfillBeforeUid = 1;
        backfillComplete = true;
        nextCursorUid = 0;
    }
    else if (cursorUid === 0) {
        const initial = await importRange(`${Math.max(1, mailbox.exists - batchLimit + 1)}:*`, false, "newest");
        imported += initial.imported;
        backfillBeforeUid = initial.minUid || highestKnownUid + 1;
        backfillComplete = backfillBeforeUid <= 1;
        nextCursorUid = initial.maxUid || highestKnownUid;
    }
    else {
        let processedForward = false;
        if (cursorUid < highestKnownUid) {
            const searched = await client.search({ uid: `${cursorUid + 1}:*` }, { uid: true });
            const forwardUids = (searched || [])
                .map((uid) => Number(uid))
                .filter((uid) => Number.isFinite(uid) && uid > cursorUid)
                .sort((left, right) => left - right)
                .slice(0, batchLimit);
            if (forwardUids.length > 0) {
                const forward = await importRange(forwardUids, true, "oldest");
                imported += forward.imported;
                nextCursorUid = forward.maxUid || cursorUid;
                processedForward = forward.processed > 0;
            }
            else {
                nextCursorUid = highestKnownUid;
            }
        }
        if (!processedForward && !backfillComplete) {
            if (backfillBeforeUid <= 0) {
                const oldestLocalUid = await mailboxCursorRepo.oldestLocalUid(account.id, target.localFolder);
                backfillBeforeUid = oldestLocalUid ?? Math.min(cursorUid + 1, highestKnownUid + 1);
            }
            if (backfillBeforeUid <= 1) {
                backfillBeforeUid = 1;
                backfillComplete = true;
            }
            else {
                const backfillEndUid = backfillBeforeUid - 1;
                const backfillStartUid = Math.max(1, backfillEndUid - batchLimit + 1);
                const backfill = await importRange(`${backfillStartUid}:${backfillEndUid}`, true, "newest");
                imported += backfill.imported;
                backfillBeforeUid = backfill.minUid || backfillStartUid;
                backfillComplete = backfillBeforeUid <= 1;
            }
        }
    }
    if (!cursorValid && mailbox.exists > 0 && remoteStates.length > 0 && imported === 0) {
        throw new Error(`邮箱目录 ${target.mailboxPath} 的新 UID generation 未成功保存任何邮件，已保留旧缓存`);
    }
    await db.transaction(async () => {
        if (!await accountRepo.incomingIdentityMatches(account))
            throw new StaleMailboxSyncError("邮箱连接信息已更新，本次旧连接同步结果已丢弃");
        if (!await mailboxCursorRepo.matchesSnapshot(account.id, target.mailboxPath, storedCursor))
            throw new StaleMailboxSyncError(`邮箱目录 ${target.mailboxPath} 已由另一同步任务更新，本次过期结果已丢弃`);
        await messageRepo.removeStaleRemoteIdentity(account.id, target.localFolder, target.mailboxPath, uidValidity, {
            adoptLegacyIdentity: cursorValid
        });
        for (const prepared of preparedImports) {
            const savedMessage = await messageRepo.upsert(prepared.message);
            await attachmentRepo.replaceForMessage(savedMessage.id, prepared.attachments);
        }
        if (shouldReconcile) {
            await messageRepo.reconcileRemoteMailbox(account.id, target.localFolder, target.mailboxPath, remoteStates, {
                uidValidity,
                adoptLegacyIdentity: cursorValid
            });
        }
        await mailboxCursorRepo.set(account.id, target.mailboxPath, {
            cursorUid: nextCursorUid,
            uidValidity,
            backfillBeforeUid,
            backfillComplete,
            lastReconcileAt: shouldReconcile ? new Date().toISOString() : undefined
        });
        if (target.localFolder === "INBOX")
            await accountRepo.markSyncCursor(account.id, nextCursorUid, uidValidity);
    });
    return { imported, cursorUid: nextCursorUid };
}
async function syncImapAccount(account: AccountRecord, initialLimit = 30): Promise<{
    imported: number;
    cursorUid: number;
}> {
    await accountRepo.markSync(account.id, "syncing");
    const password = await accountRepo.decryptedPassword(account);
    const client = new ImapFlow({
        host: account.imap_host,
        port: account.imap_port,
        secure: Boolean(account.imap_secure),
        auth: {
            user: account.username,
            pass: password
        },
        doSTARTTLS: account.imap_secure ? undefined : true,
        tls: { servername: account.imap_host, minVersion: "TLSv1.2", ecdhCurve: "X25519:P-256:P-384" },
        connectionTimeout: config.mailConnectionTimeoutMs,
        greetingTimeout: config.mailConnectionTimeoutMs,
        socketTimeout: Math.max(config.mailConnectionTimeoutMs * 2, 60000),
        logger: false
    });
    try {
        await client.connect();
        const attachmentLimit = (await appSettingsRepo.getAttachmentSettings()).max_size_bytes;
        const mailboxes = await client.list();
        const gmailLabels = client.capabilities.has("X-GM-EXT-1");
        const targets = discoverImapSyncTargets(mailboxes, gmailLabels);
        let imported = 0;
        let inboxCursorUid = 0;
        for (const target of targets) {
            const result = await syncMailbox(client, account, target, initialLimit, attachmentLimit, gmailLabels);
            imported += result.imported;
            if (target.localFolder === "INBOX")
                inboxCursorUid = result.cursorUid;
        }
        await accountRepo.markSync(account.id, "idle", new Date().toISOString());
        return { imported, cursorUid: inboxCursorUid };
    }
    catch (error) {
        await accountRepo.markSync(account.id, error instanceof StaleMailboxSyncError ? "idle" : "error");
        if (error instanceof StaleMailboxSyncError)
            throw error;
        throw new Error(connectionError(account, error, "IMAP", password));
    }
    finally {
        await client.logout().catch(() => undefined);
    }
}
async function syncPop3Inbox(account: AccountRecord, initialLimit = 30): Promise<{ imported: number; cursorUid: number }> {
    await accountRepo.markSync(account.id, "syncing");
    const password = await accountRepo.decryptedPassword(account);
    const client = new Pop3Command({
        user: account.username,
        password,
        host: account.imap_host,
        port: account.imap_port,
        tls: Boolean(account.imap_secure),
        timeout: Math.max(config.mailConnectionTimeoutMs * 2, 60000),
        servername: account.imap_host,
        tlsOptions: { minVersion: "TLSv1.2" }
    });
    try {
        const uidlResponse = await client.UIDL();
        const uidlRows = Array.isArray(uidlResponse) && uidlResponse.every((row) => Array.isArray(row))
            ? uidlResponse as string[][]
            : [];
        const serverMessages = uidlRows
            .map((row) => ({ number: Number(row[0]), uidl: String(row[1] ?? "") }))
            .filter((item) => Number.isInteger(item.number) && item.number > 0 && item.uidl.length > 0 && item.uidl.length <= 512)
            .sort((a, b) => a.number - b.number);
        const existing = await pop3SeenRepo.existing(account.id, serverMessages.map((item) => item.uidl));
        const unseen = serverMessages.filter((item) => !existing.has(item.uidl));
        const isFirstSync = await pop3SeenRepo.count(account.id) === 0;
        const limit = Math.max(1, Math.min(1000, initialLimit));
        const selected = isFirstSync ? unseen.slice(-limit) : unseen;
        if (isFirstSync) {
            for (const skipped of unseen.slice(0, -limit))
                await pop3SeenRepo.mark(account.id, skipped.uidl);
        }
        const attachmentLimit = (await appSettingsRepo.getAttachmentSettings()).max_size_bytes;
        let imported = 0;
        for (const item of selected) {
            const source = await client.RETR(item.number);
            const parsed = await simpleParser(source);
            const from = firstAddress(parsed.from);
            const recipients = [...addressList(parsed.to), ...addressList(parsed.cc)];
            const text = truncateUtf8(parsed.text ?? "", config.maxIncomingBodyBytes);
            const htmlText = truncateUtf8(typeof parsed.html === "string" ? parsed.html : "", config.maxIncomingBodyBytes);
            const sourceSize = Buffer.byteLength(source);
            const oversizedMessage = sourceSize > config.maxIncomingMessageBytes;
            const skippedAttachments = parsed.attachments.filter((attachment) => (attachment.size ?? attachment.content.length) > attachmentLimit);
            const savedMessage = await messageRepo.upsert({
                accountId: account.id,
                folder: "INBOX",
                messageId: parsed.messageId,
                inReplyTo: parsed.inReplyTo,
                references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [],
                subject: parsed.subject ?? "(无主题)",
                senderName: from?.name,
                senderEmail: from?.address,
                recipients,
                snippet: oversizedMessage
                    ? `邮件大小 ${sizeLabel(sourceSize)}，超过接收上限，仅保存正文元数据。`
                    : textSnippet(`${text || htmlText.replace(/<[^>]*>/g, " ") || ""}${skippedAttachments.length ? ` [${skippedAttachments.length} 个超限附件未保存]` : ""}`),
                textBody: oversizedMessage ? "该邮件超过管理员配置的接收大小上限，附件未保存。" : text,
                htmlBody: oversizedMessage ? undefined : htmlText || undefined,
                sentAt: parsed.date?.toISOString(),
                flags: [],
                isRead: false,
                remoteMailbox: "POP3",
                remoteUidValidity: item.uidl
            });
            if (!oversizedMessage) {
                await attachmentRepo.replaceForMessage(savedMessage.id, parsed.attachments
                    .filter((attachment) => (attachment.size ?? attachment.content.length) <= attachmentLimit)
                    .map((attachment) => ({
                    filename: attachment.filename ?? "attachment",
                    contentType: attachment.contentType ?? "application/octet-stream",
                    size: attachment.size ?? attachment.content.length,
                    contentId: attachment.contentId,
                    content: attachment.content
                })));
            }
            await pop3SeenRepo.mark(account.id, item.uidl, savedMessage.id);
            imported += 1;
        }
        await accountRepo.markSync(account.id, "idle", new Date().toISOString());
        return { imported, cursorUid: serverMessages.length };
    }
    catch (error) {
        await accountRepo.markSync(account.id, "error");
        throw new Error(connectionError(account, error, "POP3", password));
    }
    finally {
        await client.QUIT().catch(() => undefined);
    }
}
export async function syncInbox(account: AccountRecord, initialLimit = 30): Promise<{ imported: number; cursorUid: number }> {
    return account.incoming_protocol === "pop3"
        ? syncPop3Inbox(account, initialLimit)
        : syncImapAccount(account, initialLimit);
}
export async function sendMail(input: {
    account: AccountRecord;
    fromEmail?: string;
    fromName?: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    text: string;
    html?: string;
    replyTo?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: Array<{
        filename: string;
        contentType: string;
        content: Buffer;
    }>;
}): Promise<{
    messageId: string;
    accepted: string[];
    rejected: string[];
    response: string;
}> {
    const transporter = nodemailer.createTransport({
        host: input.account.smtp_host,
        port: input.account.smtp_port,
        secure: Boolean(input.account.smtp_secure),
        requireTLS: !input.account.smtp_secure,
        connectionTimeout: config.mailConnectionTimeoutMs,
        greetingTimeout: config.mailConnectionTimeoutMs,
        socketTimeout: Math.max(config.mailConnectionTimeoutMs * 2, 60000),
        tls: { servername: input.account.smtp_host, minVersion: "TLSv1.2", ecdhCurve: "X25519:P-256:P-384" },
        auth: {
            user: input.account.username,
            pass: await accountRepo.decryptedPassword(input.account)
        }
    });
    const result = await transporter.sendMail({
        from: `"${input.fromName || input.account.display_name}" <${input.fromEmail || input.account.email}>`,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        text: input.text,
        html: input.html,
        replyTo: input.replyTo,
        inReplyTo: input.inReplyTo,
        references: input.references,
        attachments: input.attachments?.map((attachment) => ({
            filename: attachment.filename,
            contentType: attachment.contentType,
            content: attachment.content
        }))
    });
    return {
        messageId: result.messageId,
        accepted: result.accepted.map(String),
        rejected: result.rejected.map(String),
        response: result.response
    };
}
export async function testAccountConnection(account: AccountRecord): Promise<{
    incoming: {
        protocol: "imap" | "pop3";
        ok: boolean;
        error?: string;
    };
    smtp: {
        ok: boolean;
        error?: string;
    };
}> {
    const password = await accountRepo.decryptedPassword(account);
    const result: {
        incoming: {
            protocol: "imap" | "pop3";
            ok: boolean;
            error?: string;
        };
        smtp: {
            ok: boolean;
            error?: string;
        };
    } = {
        incoming: { protocol: account.incoming_protocol, ok: false },
        smtp: { ok: false }
    };
    if (account.incoming_protocol === "pop3") {
        const client = new Pop3Command({
            user: account.username,
            password,
            host: account.imap_host,
            port: account.imap_port,
            tls: Boolean(account.imap_secure),
            timeout: config.mailConnectionTimeoutMs,
            servername: account.imap_host,
        tlsOptions: { minVersion: "TLSv1.2" }
        });
        try {
            await client.UIDL();
            result.incoming = { protocol: "pop3", ok: true };
        }
        catch (error) {
            result.incoming = { protocol: "pop3", ok: false, error: connectionError(account, error, "POP3", password) };
        }
        finally {
            await client.QUIT().catch(() => undefined);
        }
    }
    else {
        const client = new ImapFlow({
        host: account.imap_host,
        port: account.imap_port,
        secure: Boolean(account.imap_secure),
        auth: {
            user: account.username,
            pass: password
        },
        doSTARTTLS: account.imap_secure ? undefined : true,
        tls: { servername: account.imap_host, minVersion: "TLSv1.2", ecdhCurve: "X25519:P-256:P-384" },
        connectionTimeout: config.mailConnectionTimeoutMs,
        greetingTimeout: config.mailConnectionTimeoutMs,
        socketTimeout: Math.max(config.mailConnectionTimeoutMs * 2, 60000),
        logger: false
    });
        try {
            await client.connect();
            await client.mailboxOpen("INBOX");
            result.incoming = { protocol: "imap", ok: true };
        }
        catch (error) {
            result.incoming = { protocol: "imap", ok: false, error: connectionError(account, error, "IMAP", password) };
        }
        finally {
            await client.logout().catch(() => undefined);
        }
    }
    const transporter = nodemailer.createTransport({
        host: account.smtp_host,
        port: account.smtp_port,
        secure: Boolean(account.smtp_secure),
        requireTLS: !account.smtp_secure,
        connectionTimeout: config.mailConnectionTimeoutMs,
        greetingTimeout: config.mailConnectionTimeoutMs,
        socketTimeout: Math.max(config.mailConnectionTimeoutMs * 2, 60000),
        tls: { servername: account.smtp_host, minVersion: "TLSv1.2", ecdhCurve: "X25519:P-256:P-384" },
        auth: {
            user: account.username,
            pass: password
        }
    });
    try {
        await transporter.verify();
        result.smtp = { ok: true };
    }
    catch (error) {
        result.smtp = { ok: false, error: connectionError(account, error, "SMTP", password) };
    }
    finally {
        transporter.close();
    }
    return result;
}
