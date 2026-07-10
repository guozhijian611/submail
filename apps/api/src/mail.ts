import { simpleParser } from "mailparser";
import { ImapFlow, type FetchMessageObject, type ListResponse } from "imapflow";
import nodemailer from "nodemailer";
import Pop3Command from "node-pop3";
import { accountRepo, appSettingsRepo, attachmentRepo, mailboxCursorRepo, messageRepo, pop3SeenRepo } from "./repositories.js";
import type { AccountRecord } from "./types.js";
import { config } from "./config.js";
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
function findSentMailbox(mailboxes: ListResponse[]): ListResponse | undefined {
    const bySpecialUse = mailboxes.find((mailbox) => mailbox.specialUse === "\\Sent");
    if (bySpecialUse)
        return bySpecialUse;
    const commonNames = new Set(["sent", "sent mail", "sent messages", "sent items", "已发送", "已发送邮件"]);
    return mailboxes.find((mailbox) => {
        const leaf = mailbox.path.split(mailbox.delimiter || "/").at(-1)?.trim().toLowerCase() ?? "";
        return commonNames.has(leaf);
    });
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
async function syncMailbox(client: ImapFlow, account: AccountRecord, mailboxPath: string, localFolder: "INBOX" | "Sent", initialLimit: number, attachmentLimit: number): Promise<{
    imported: number;
    cursorUid: number;
}> {
    const mailbox = await client.mailboxOpen(mailboxPath);
    const uidValidity = mailbox.uidValidity.toString();
    const storedCursor = await mailboxCursorRepo.get(account.id, mailboxPath);
    const legacyCursor = localFolder === "INBOX" && !storedCursor
        ? { cursor_uid: Number(account.sync_cursor_uid ?? 0), uid_validity: account.sync_uid_validity }
        : undefined;
    const cursorRecord = storedCursor ?? legacyCursor;
    const highestKnownUid = Math.max(0, mailbox.uidNext - 1);
    const cursorValid = cursorRecord?.uid_validity === uidValidity;
    const cursorUid = cursorValid ? Number(cursorRecord?.cursor_uid ?? 0) : 0;
    const batchLimit = Math.max(1, Math.min(1000, initialLimit));

    async function importRange(fetchRange: string, useUidRange: boolean): Promise<{ imported: number; minUid: number; maxUid: number }> {
        const messages: FetchMessageObject[] = [];
        let minUid = Number.POSITIVE_INFINITY;
        let maxUid = 0;
        let imported = 0;
        for await (const message of client.fetch(fetchRange, { uid: true, envelope: true, flags: true, size: true }, { uid: useUidRange })) {
            minUid = Math.min(minUid, message.uid);
            maxUid = Math.max(maxUid, message.uid);
            messages.push(message);
        }
        // Finish the FETCH iterator before fetchOne calls on the same connection.
        for (const message of messages) {
            if ((message.size ?? 0) > config.maxIncomingMessageBytes) {
                const from = message.envelope?.from?.[0];
                await messageRepo.upsert({
                    accountId: account.id,
                    folder: localFolder,
                    uid: message.uid,
                    subject: message.envelope?.subject ?? "(无主题)",
                    senderName: from?.name,
                    senderEmail: from?.address,
                    recipients: (message.envelope?.to ?? []).map((address) => address.address).filter((address): address is string => Boolean(address)),
                    snippet: `邮件大小 ${sizeLabel(message.size ?? 0)}，超过接收上限 ${sizeLabel(config.maxIncomingMessageBytes)}，仅保存元数据。`,
                    textBody: "该邮件超过管理员配置的接收大小上限，正文和附件未下载。",
                    sentAt: message.envelope?.date?.toISOString(),
                    flags: Array.from(message.flags ?? []),
                    isRead: message.flags?.has("\\Seen") ?? localFolder === "Sent"
                });
                imported += 1;
                continue;
            }
            const sourceMessage = await client.fetchOne(String(message.uid), { source: true }, { uid: true });
            if (!sourceMessage || !sourceMessage.source)
                continue;
            const parsed = await simpleParser(sourceMessage.source);
            const from = firstAddress(parsed.from);
            const recipients = [...addressList(parsed.to), ...addressList(parsed.cc)];
            const text = truncateUtf8(parsed.text ?? "", config.maxIncomingBodyBytes);
            const htmlText = truncateUtf8(typeof parsed.html === "string" ? parsed.html : "", config.maxIncomingBodyBytes);
            const skippedAttachments = parsed.attachments.filter((attachment) => (attachment.size ?? attachment.content.length) > attachmentLimit);
            const savedMessage = await messageRepo.upsert({
                accountId: account.id,
                folder: localFolder,
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
                flags: Array.from(message.flags ?? []),
                isRead: message.flags?.has("\\Seen") ?? localFolder === "Sent"
            });
            await attachmentRepo.replaceForMessage(savedMessage.id, parsed.attachments
                .filter((attachment) => (attachment.size ?? attachment.content.length) <= attachmentLimit)
                .map((attachment) => ({
                    filename: attachment.filename ?? "attachment",
                    contentType: attachment.contentType ?? "application/octet-stream",
                    size: attachment.size ?? attachment.content.length,
                    contentId: attachment.contentId,
                    content: attachment.content
                })));
            imported += 1;
        }
        return {
            imported,
            minUid: Number.isFinite(minUid) ? minUid : 0,
            maxUid
        };
    }

    let imported = 0;
    let backfillBeforeUid = cursorValid && storedCursor ? Number(storedCursor.backfill_before_uid ?? 0) : 0;
    let backfillComplete = cursorValid && storedCursor ? Boolean(storedCursor.backfill_complete) : false;
    if (mailbox.exists === 0) {
        backfillBeforeUid = 1;
        backfillComplete = true;
    }
    else if (cursorUid === 0) {
        const initial = await importRange(`${Math.max(1, mailbox.exists - batchLimit + 1)}:*`, false);
        imported += initial.imported;
        backfillBeforeUid = initial.minUid || highestKnownUid + 1;
        backfillComplete = backfillBeforeUid <= 1;
    }
    else {
        if (cursorUid < highestKnownUid) {
            const forward = await importRange(`${cursorUid + 1}:*`, true);
            imported += forward.imported;
        }
        if (!backfillComplete) {
            if (backfillBeforeUid <= 0) {
                const oldestLocalUid = await mailboxCursorRepo.oldestLocalUid(account.id, localFolder);
                backfillBeforeUid = oldestLocalUid ?? Math.min(cursorUid + 1, highestKnownUid + 1);
            }
            if (backfillBeforeUid <= 1) {
                backfillBeforeUid = 1;
                backfillComplete = true;
            }
            else {
                const backfillEndUid = backfillBeforeUid - 1;
                const backfillStartUid = Math.max(1, backfillEndUid - batchLimit + 1);
                const backfill = await importRange(`${backfillStartUid}:${backfillEndUid}`, true);
                imported += backfill.imported;
                backfillBeforeUid = backfillStartUid;
                backfillComplete = backfillStartUid <= 1;
            }
        }
    }
    const nextCursorUid = highestKnownUid;
    await mailboxCursorRepo.set(account.id, mailboxPath, {
        cursorUid: nextCursorUid,
        uidValidity,
        backfillBeforeUid,
        backfillComplete
    });
    if (localFolder === "INBOX")
        await accountRepo.markSyncCursor(account.id, nextCursorUid, uidValidity);
    return { imported, cursorUid: nextCursorUid };
}
async function syncImapInbox(account: AccountRecord, initialLimit = 30): Promise<{
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
        const inboxResult = await syncMailbox(client, account, "INBOX", "INBOX", initialLimit, attachmentLimit);
        const sentMailbox = findSentMailbox(mailboxes);
        const sentResult = sentMailbox
            ? await syncMailbox(client, account, sentMailbox.path, "Sent", initialLimit, attachmentLimit)
            : { imported: 0, cursorUid: 0 };
        await accountRepo.markSync(account.id, "idle", new Date().toISOString());
        return { imported: inboxResult.imported + sentResult.imported, cursorUid: inboxResult.cursorUid };
    }
    catch (error) {
        await accountRepo.markSync(account.id, "error");
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
                isRead: false
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
        : syncImapInbox(account, initialLimit);
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
