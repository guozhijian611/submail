import type { NextFunction, Request, Response, Router } from "express";
import crypto from "node:crypto";
import { Router as createRouter } from "express";
import pino from "pino";
import { simpleParser } from "mailparser";
import { z } from "zod";
import { accountRepo, adminRepo, apiKeyRepo, appSettingsRepo, attachmentRepo, bootstrapRepo, mcpLogRepo, messageRepo, savedSearchRepo, sendIdempotencyRepo, sessionRepo } from "./repositories.js";
import type { PublicApiKey } from "./repositories.js";
import { testAccountConnection } from "./mail.js";
import { dispatchAccountSync, dispatchAllSync, dispatchMail, queueHealth, type MailDeliveryResult } from "./queue.js";
import { syncRunRepo, syncSettingsRepo } from "./repositories.js";
import { aiService, integrationSettingsRepo, translationService } from "./integrations.js";
import { canonicalLanguageTag, detectEnglishText } from "./language.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { normalizeMailboxHost } from "./account-input.js";
const logger = pino({ name: "submail-api-routes" });
const apiKeyScopes = [
    "mcp:accounts:read",
    "mcp:mail:read",
    "mcp:mail:send",
    "mcp:ai:use",
    "mcp:translate:use",
    "mcp:log"
] as const;
const setupAdminSchema = z.object({
    email: z.string().email(),
    name: z.string().min(1),
    password: z.string().min(8)
});
const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1)
});
const changePasswordSchema = z.object({
    oldPassword: z.string().min(1),
    newPassword: z.string().min(8)
});
const mailboxHostSchema = z.string()
    .transform(normalizeMailboxHost)
    .refine((value) => value.length > 0, { message: "邮件服务器地址不能为空" })
    .refine((value) => value.length <= 253, { message: "邮件服务器地址过长" })
    .refine((value) => !/\s/u.test(value), { message: "邮件服务器地址不能包含空格" });
const accountAliasSchema = z.union([
    z.string().trim().email().transform((email) => ({ email })),
    z.object({
        id: z.string().trim().min(1).optional(),
        email: z.string().trim().email(),
        displayName: z.string().trim().max(255).optional(),
        replyTo: z.union([z.string().trim().email(), z.literal("")]).optional(),
        sendEnabled: z.boolean().optional()
    })
]);
const accountSchemaFields = z.object({
    email: z.string().trim().email(),
    displayName: z.string().trim().min(1),
    notes: z.string().trim().max(2000).default(""),
    aliases: z.array(accountAliasSchema).max(50).default([]),
    username: z.string().trim().min(1),
    password: z.string().min(1),
    incomingProtocol: z.enum(["imap", "pop3"]).default("imap"),
    authMode: z.enum(["password", "app_password"]).default("password"),
    imapHost: mailboxHostSchema,
    imapPort: z.coerce.number().int().min(1).max(65535),
    imapSecure: z.coerce.boolean(),
    smtpHost: mailboxHostSchema,
    smtpPort: z.coerce.number().int().min(1).max(65535),
    smtpSecure: z.coerce.boolean()
});
const appPasswordOnlyDomains = new Set([
    "gmail.com",
    "googlemail.com",
    "qq.com",
    "foxmail.com",
    "163.com",
    "126.com",
    "yeah.net",
    "icloud.com",
    "me.com",
    "mac.com",
    "yahoo.com",
    "yahoo.com.cn"
]);
function validateAccountAuthMode(input: { email: string; authMode: "password" | "app_password" }, context: z.RefinementCtx) {
    const domain = input.email.split("@").at(-1)?.toLowerCase() ?? "";
    if (input.authMode === "password" && appPasswordOnlyDomains.has(domain)) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["authMode"],
            message: "该邮箱服务商不支持使用网页登录密码接入，请选择应用专用密码 / 客户端授权码"
        });
    }
}
const createAccountSchema = accountSchemaFields.superRefine(validateAccountAuthMode);
const updateAccountSchema = accountSchemaFields.extend({
    password: z.string().optional()
}).superRefine(validateAccountAuthMode);
const outgoingAttachmentSchema = z.object({
    filename: z.string().min(1).max(255),
    contentType: z.string().min(1).max(255).default("application/octet-stream"),
    contentBase64: z.string().min(1).max(40000000)
});
const sendMailSchema = z.object({
    accountId: z.string().min(1),
    fromAliasId: z.string().min(1).optional(),
    to: z.array(z.string().email()).max(100).default([]),
    cc: z.array(z.string().email()).max(100).default([]),
    bcc: z.array(z.string().email()).max(100).default([]),
    subject: z.string().min(1),
    text: z.string().default(""),
    html: z.string().max(2000000).optional(),
    replyTo: z.string().email().optional(),
    inReplyTo: z.string().max(1000).optional(),
    references: z.array(z.string().max(1000)).max(100).optional(),
    attachments: z.array(outgoingAttachmentSchema).max(20).optional()
})
    .refine((input) => input.to.length + input.cc.length + input.bcc.length > 0, { message: "至少填写一个收件人" })
    .refine((input) => input.to.length + input.cc.length + input.bcc.length <= 100, { message: "单封邮件最多 100 个收件人" })
    .refine((input) => Boolean(input.text.trim() || input.html?.trim()), { message: "text 和 html 至少填写一个" });
const draftMailSchema = z.object({
    accountId: z.string().min(1),
    fromAliasId: z.string().min(1).optional(),
    to: z.array(z.string().min(1)).default([]),
    subject: z.string().default(""),
    text: z.string().default(""),
    attachments: z.array(outgoingAttachmentSchema).max(20).optional()
});
const updateAttachmentSettingsSchema = z.object({
    maxSizeMb: z.coerce.number().int().min(1).max(25),
    retentionDays: z.coerce.number().int().min(0).max(3650).default(0)
});
const updateEmailDisplaySettingsSchema = z.object({
    loadExternalResourcesByDefault: z.boolean()
});
const updateMessageStateSchema = z.object({
    isRead: z.boolean().optional(),
    isStarred: z.boolean().optional(),
    isArchived: z.boolean().optional(),
    isDeleted: z.boolean().optional()
});
const bulkUpdateMessageStateSchema = z.object({
    ids: z.array(z.string().min(1)).min(1).max(100),
    state: updateMessageStateSchema.refine((value) => Object.values(value).some((item) => item !== undefined), {
        message: "至少提供一个状态变更"
    })
});
const markAllInboxReadSchema = z.object({
    accountId: z.string().min(1).optional()
});
const savedSearchCriteriaSchema = z.object({
    query: z.string().default(""),
    sender: z.string().default(""),
    dateFrom: z.string().default(""),
    dateTo: z.string().default(""),
    hasAttachment: z.coerce.boolean().default(false),
    folder: z.string().default("INBOX"),
    accountId: z.string().default("")
});
const createSavedSearchSchema = z.object({
    name: z.string().min(1).max(80),
    criteria: savedSearchCriteriaSchema
});
const createApiKeySchema = z.object({
    name: z.string().min(1),
    scopes: z.array(z.enum(apiKeyScopes)).default(["mcp:accounts:read", "mcp:mail:read"]),
    accountIds: z.array(z.string().min(1)).optional(),
    allAccounts: z.boolean().default(false),
    expiresAt: z.string().datetime().optional(),
    dailySendLimit: z.coerce.number().int().min(0).max(10000).default(100)
});
const createAdminSchema = z.object({
    email: z.string().email(),
    name: z.string().min(1),
    password: z.string().min(8)
});
const resetAdminPasswordSchema = z.object({
    newPassword: z.string().min(8)
});
const updateSyncSettingsSchema = z.object({
    enabled: z.coerce.boolean(),
    intervalMinutes: z.coerce.number().int().min(1).max(1440),
    initialLimit: z.coerce.number().int().min(1).max(1000),
    retryMaxAttempts: z.coerce.number().int().min(1).max(10),
    retryDelayMinutes: z.coerce.number().int().min(1).max(1440),
    concurrencyLimit: z.coerce.number().int().min(1).max(10).default(2),
    retentionDays: z.coerce.number().int().min(1).max(3650).default(30)
});
const updateAiSettingsSchema = z.object({
    enabled: z.boolean(),
    baseUrl: z.string().url(),
    model: z.string().max(200),
    temperature: z.coerce.number().min(0).max(2).default(0.3),
    systemPrompt: z.string().max(10000).default(""),
    apiKey: z.string().max(2000).optional(),
    clearApiKey: z.boolean().optional()
});
const updateTranslationSettingsSchema = z.object({
    enabled: z.boolean(),
    provider: z.enum(["google", "libretranslate", "custom"]),
    endpoint: z.string().max(2000).default(""),
    defaultTargetLanguage: z.string().min(2).max(32).default("zh-CN").refine((value) => {
        try {
            canonicalLanguageTag(value);
            return true;
        }
        catch {
            return false;
        }
    }, "目标语言必须是有效的 BCP-47 语言标签，例如 zh-CN 或 en"),
    autoTranslateEnglishOnOpen: z.boolean().optional(),
    apiKey: z.string().max(2000).optional(),
    clearApiKey: z.boolean().optional()
});
const aiMessageActionSchema = z.object({
    messageId: z.string().min(1),
    instructions: z.string().max(5000).optional()
});
const aiReplySchema = aiMessageActionSchema.extend({
    tone: z.string().max(200).optional(),
    language: z.string().max(32).optional()
});
const aiComposeSchema = z.object({
    prompt: z.string().min(1).max(10000),
    language: z.string().max(32).optional(),
    tone: z.string().max(200).optional(),
    recipientContext: z.string().max(2000).optional(),
    subjectHint: z.string().max(500).optional()
});
const bcp47LanguageSchema = z.string().min(2).max(32).transform((value, context) => {
    try {
        return canonicalLanguageTag(value);
    }
    catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "语言必须是有效的 BCP-47 标签，例如 zh-CN 或 en" });
        return z.NEVER;
    }
});
const translateSchema = z.object({
    messageId: z.string().min(1).optional(),
    text: z.string().min(1).max(50000).optional(),
    sourceLanguage: z.union([z.literal("auto"), bcp47LanguageSchema]).optional(),
    targetLanguage: bcp47LanguageSchema.optional()
}).refine((input) => Boolean(input.messageId || input.text), {
    message: "messageId 和 text 至少填写一个"
});
const syncRunStatusSchema = z.enum(["ok", "error", "skipped", "running", "retry_scheduled", "cancelled"]);
const syncRunTriggerSchema = z.enum(["manual", "manual_all", "scheduled"]);
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
    return (req: Request, res: Response, next: (error?: unknown) => void) => {
        fn(req, res, next as NextFunction).catch(next);
    };
}
function stableJson(value: unknown): string {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
function sha256(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}
function bearerToken(req: Request): string | undefined {
    const header = req.header("authorization");
    if (!header?.toLowerCase().startsWith("bearer "))
        return undefined;
    return header.slice("bearer ".length).trim();
}
function decodeOutgoingAttachments(input?: Array<z.infer<typeof outgoingAttachmentSchema>>): Array<{
    filename: string;
    contentType: string;
    size: number;
    content: Buffer;
}> {
    return (input ?? []).map((attachment) => {
        const content = Buffer.from(attachment.contentBase64, "base64");
        return {
            filename: attachment.filename,
            contentType: attachment.contentType || "application/octet-stream",
            size: content.length,
            content
        };
    });
}
async function validateAttachmentSize(attachments: Array<{
    filename: string;
    size: number;
}>) {
    const settings = await appSettingsRepo.getAttachmentSettings();
    const tooLarge = attachments.find((attachment) => attachment.size > settings.max_size_bytes);
    if (tooLarge)
        return `附件 ${tooLarge.filename} 超过大小限制 ${Math.round(settings.max_size_bytes / 1024 / 1024)} MB`;
    const totalSize = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
    if (totalSize > config.maxOutgoingMessageBytes) {
        return `附件总大小超过 ${Math.round(config.maxOutgoingMessageBytes / 1024 / 1024)} MB`;
    }
    return undefined;
}
async function attachmentPreview(attachment: NonNullable<Awaited<ReturnType<typeof attachmentRepo.get>>>) {
    const content = attachment.content_blob;
    if (!content)
        return { previewType: "none", reason: "附件内容不存在" };
    const contentType = attachment.content_type.split(";", 1)[0].trim().toLowerCase();
    if (contentType === "message/rfc822" && content.length <= 10 * 1024 * 1024) {
        const parsed = await simpleParser(content);
        return {
            previewType: "email",
            email: {
                subject: parsed.subject ?? "(无主题)",
                from: parsedAddressText(parsed.from),
                to: parsedAddressText(parsed.to),
                cc: parsedAddressText(parsed.cc),
                date: parsed.date?.toISOString() ?? null,
                text: truncatePreviewText(parsed.text || (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]*>/g, " ") : ""), 1024 * 1024),
                attachments: parsed.attachments.map((item) => ({
                    filename: item.filename ?? "attachment",
                    contentType: item.contentType,
                    size: item.size ?? item.content.length
                }))
            }
        };
    }
    if (contentType.startsWith("image/") && contentType !== "image/svg+xml" && content.length <= 10 * 1024 * 1024) {
        return {
            previewType: "image",
            dataUrl: `data:${contentType};base64,${content.toString("base64")}`
        };
    }
    if (contentType === "application/pdf" && content.length <= 10 * 1024 * 1024) {
        return { previewType: "pdf", dataUrl: `data:application/pdf;base64,${content.toString("base64")}` };
    }
    if (contentType.startsWith("audio/") && content.length <= 10 * 1024 * 1024) {
        return { previewType: "audio", dataUrl: `data:${contentType};base64,${content.toString("base64")}` };
    }
    if (contentType.startsWith("video/") && content.length <= 10 * 1024 * 1024) {
        return { previewType: "video", dataUrl: `data:${contentType};base64,${content.toString("base64")}` };
    }
    if (contentType === "text/html" && content.length <= 512 * 1024) {
        return { previewType: "html", text: content.toString("utf8") };
    }
    const isText = contentType.startsWith("text/")
        || ["application/json", "application/xml", "application/csv", "application/javascript"].includes(contentType);
    if (isText && content.length <= 512 * 1024) {
        return {
            previewType: "text",
            text: content.toString("utf8")
        };
    }
    return { previewType: "unsupported", reason: "该附件类型或大小暂不支持预览" };
}
function parsedAddressText(value: unknown): string {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return values
        .map((item) => item && typeof item === "object" && "text" in item ? String((item as { text?: string }).text ?? "") : "")
        .filter(Boolean)
        .join(", ");
}
function truncatePreviewText(value: string, maxBytes: number): string {
    const source = Buffer.from(value, "utf8");
    if (source.length <= maxBytes)
        return value;
    return `${source.subarray(0, maxBytes).toString("utf8")}\n\n[内容过长，已截断]`;
}
function publicAttachment(attachment: NonNullable<Awaited<ReturnType<typeof attachmentRepo.get>>>) {
    const { content_blob: _contentBlob, ...rest } = attachment;
    return rest;
}
function queryBool(value: unknown): boolean | undefined {
    if (typeof value !== "string")
        return undefined;
    if (["1", "true", "yes", "on"].includes(value.toLowerCase()))
        return true;
    if (["0", "false", "no", "off"].includes(value.toLowerCase()))
        return false;
    return undefined;
}
function requiredApiKeyScopes(req: Request): string[] | undefined {
    const path = req.path.startsWith("/api/") ? req.path.slice("/api".length) : req.path;
    if (req.method === "GET" && path === "/accounts")
        return ["mcp:accounts:read"];
    if (req.method === "GET" && (path === "/messages" || path.startsWith("/messages/")))
        return ["mcp:mail:read"];
    if (req.method === "POST" && path === "/send")
        return ["mcp:mail:send"];
    if (req.method === "POST" && path === "/ai/compose")
        return ["mcp:ai:use"];
    if (req.method === "POST" && (path === "/ai/summarize" || path === "/ai/reply"))
        return ["mcp:ai:use", "mcp:mail:read"];
    if (req.method === "POST" && path === "/translate") {
        return req.body?.messageId ? ["mcp:translate:use", "mcp:mail:read"] : ["mcp:translate:use"];
    }
    if (req.method === "POST" && path === "/mcp/log")
        return ["mcp:log"];
    if (req.method === "GET" && path === "/mcp/tools")
        return ["mcp:accounts:read"];
    return undefined;
}
function apiKeyAllows(scopes: string[], requiredScopes: string[] | undefined): boolean {
    if (!requiredScopes)
        return false;
    return scopes.includes("mcp") || requiredScopes.every((scope) => scopes.includes(scope));
}
function currentApiKey(res: Response): PublicApiKey | undefined {
    return res.locals.apiKey as PublicApiKey | undefined;
}
async function apiKeyAllowsAccount(res: Response, accountId: string) {
    const apiKey = currentApiKey(res);
    return !apiKey || await apiKeyRepo.allowsAccount(apiKey, accountId);
}
async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = bearerToken(req);
    if (token && await sessionRepo.getAdminByToken(token)) {
        next();
        return;
    }
    const headerApiKey = req.header("x-submail-api-key")?.trim();
    if (token && headerApiKey && token !== headerApiKey) {
        res.status(400).json({ error: "Request contains two different API keys" });
        return;
    }
    const apiKey = headerApiKey || token;
    if (apiKey) {
        const verifiedKey = await apiKeyRepo.verify(apiKey);
        if (verifiedKey) {
            const requiredScopes = requiredApiKeyScopes(req);
            if (!apiKeyAllows(verifiedKey.scopes, requiredScopes)) {
                res.status(403).json({ error: "API key scope does not allow this operation" });
                return;
            }
            res.locals.apiKey = verifiedKey;
            await apiKeyRepo.markUsed(verifiedKey.id);
            next();
            return;
        }
    }
    res.status(401).json({ error: "Unauthorized" });
}
async function requireAdminSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = bearerToken(req);
    if (token && await sessionRepo.getAdminByToken(token)) {
        next();
        return;
    }
    res.status(403).json({ error: "Admin session required" });
}
async function currentSessionAdmin(req: Request) {
    const token = bearerToken(req);
    return token ? await sessionRepo.getAdminByToken(token) : undefined;
}
export function routes(): Router {
    const router = createRouter();
    router.get("/health", asyncHandler(async (_req, res) => {
        try {
            await db.prepare("SELECT 1").get();
            const queue = await queueHealth();
            if (!queue.ok) throw new Error("Queue unavailable");
            res.json({ ok: true, service: "submail-api", database: config.dbDriver, queue: queue.driver });
        }
        catch {
            res.status(503).json({ ok: false, service: "submail-api", database: "unavailable" });
        }
    }));
    router.get("/api/setup/status", asyncHandler(async (_req, res) => {
        res.json(await bootstrapRepo.setupStatus());
    }));
    router.post("/api/setup/admin", asyncHandler(async (req, res) => {
        const input = setupAdminSchema.parse(req.body);
        const admin = await bootstrapRepo.createFirstAdmin(input);
        if (!admin) {
            res.status(409).json({ error: "Admin already initialized" });
            return;
        }
        const session = await sessionRepo.create(admin.id);
        res.status(201).json({ admin, session });
    }));
    router.post("/api/auth/login", asyncHandler(async (req, res) => {
        const input = loginSchema.parse(req.body);
        const admin = await adminRepo.verifyLogin(input.email, input.password);
        if (!admin) {
            res.status(401).json({ error: "Invalid email or password" });
            return;
        }
        const session = await sessionRepo.create(admin.id);
        res.json({ admin, session });
    }));
    router.use("/api", asyncHandler(requireAuth));
    router.get("/api/auth/me", asyncHandler(async (req, res) => {
        const token = bearerToken(req);
        const admin = token ? await sessionRepo.getAdminByToken(token) : undefined;
        res.json({ admin: admin ?? null });
    }));
    router.post("/api/auth/logout", asyncHandler(async (req, res) => {
        const token = bearerToken(req);
        if (token)
            await sessionRepo.delete(token);
        res.json({ ok: true });
    }));
    router.use("/api/admin", asyncHandler(requireAdminSession));
    router.put("/api/auth/password", asyncHandler(async (req, res) => {
        const token = bearerToken(req);
        const admin = token ? await sessionRepo.getAdminByToken(token) : undefined;
        if (!token || !admin) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const input = changePasswordSchema.parse(req.body);
        if (!await adminRepo.changePassword(admin.id, input.oldPassword, input.newPassword)) {
            res.status(400).json({ error: "旧密码不正确" });
            return;
        }
        await sessionRepo.deleteOtherForAdmin(admin.id, token);
        res.json({ ok: true });
    }));
    router.get("/api/admin/api-keys", asyncHandler(async (_req, res) => {
        res.json({ apiKeys: await apiKeyRepo.list() });
    }));
    router.get("/api/admin/users", asyncHandler(async (_req, res) => {
        res.json({ admins: await adminRepo.list() });
    }));
    router.post("/api/admin/users", asyncHandler(async (req, res) => {
        const input = createAdminSchema.parse(req.body);
        try {
            const admin = await adminRepo.create(input);
            res.status(201).json({ admin });
        }
        catch (error) {
            if (error instanceof Error && error.message.includes("UNIQUE")) {
                res.status(409).json({ error: "Admin email already exists" });
                return;
            }
            throw error;
        }
    }));
    router.put("/api/admin/users/:id/password", asyncHandler(async (req, res) => {
        const currentAdmin = await currentSessionAdmin(req);
        if (currentAdmin?.id === req.params.id) {
            res.status(400).json({ error: "请使用修改密码功能更新自己的密码" });
            return;
        }
        const input = resetAdminPasswordSchema.parse(req.body);
        const admin = await adminRepo.resetPassword(String(req.params.id), input.newPassword);
        if (!admin) {
            res.status(404).json({ error: "Admin not found" });
            return;
        }
        await sessionRepo.deleteForAdmin(admin.id);
        res.json({ admin });
    }));
    router.get("/api/admin/mcp-logs", asyncHandler(async (req, res) => {
        res.json({ logs: await mcpLogRepo.list(req.query.limit ? Number(req.query.limit) : undefined) });
    }));
    router.get("/api/admin/sync-settings", asyncHandler(async (_req, res) => {
        res.json({ settings: await syncSettingsRepo.get() });
    }));
    router.get("/api/admin/email-display-settings", asyncHandler(async (_req, res) => {
        res.json({ settings: await appSettingsRepo.getEmailDisplaySettings() });
    }));
    router.put("/api/admin/email-display-settings", asyncHandler(async (req, res) => {
        const input = updateEmailDisplaySettingsSchema.parse(req.body);
        res.json({ settings: await appSettingsRepo.updateEmailDisplaySettings(input) });
    }));
    router.get("/api/admin/ai-settings", asyncHandler(async (_req, res) => {
        res.json({ settings: await integrationSettingsRepo.getAi() });
    }));
    router.put("/api/admin/ai-settings", asyncHandler(async (req, res) => {
        const input = updateAiSettingsSchema.parse(req.body);
        res.json({ settings: await integrationSettingsRepo.updateAi(input) });
    }));
    router.post("/api/admin/ai-settings/test", asyncHandler(async (_req, res) => {
        res.json({ ok: true, response: await aiService.test() });
    }));
    router.get("/api/admin/translation-settings", asyncHandler(async (_req, res) => {
        res.json({ settings: await integrationSettingsRepo.getTranslation() });
    }));
    router.put("/api/admin/translation-settings", asyncHandler(async (req, res) => {
        const input = updateTranslationSettingsSchema.parse(req.body);
        res.json({ settings: await integrationSettingsRepo.updateTranslation(input) });
    }));
    router.post("/api/admin/translation-settings/test", asyncHandler(async (_req, res) => {
        res.json({ ok: true, response: await translationService.test() });
    }));
    router.put("/api/admin/sync-settings", asyncHandler(async (req, res) => {
        const input = updateSyncSettingsSchema.parse(req.body);
        res.json({ settings: await syncSettingsRepo.update(input) });
    }));
    router.get("/api/admin/sync-runs", asyncHandler(async (req, res) => {
        const status = typeof req.query.status === "string" && req.query.status ? syncRunStatusSchema.parse(req.query.status) : undefined;
        const triggerType = typeof req.query.triggerType === "string" && req.query.triggerType ? syncRunTriggerSchema.parse(req.query.triggerType) : undefined;
        const accountId = typeof req.query.accountId === "string" && req.query.accountId ? req.query.accountId : undefined;
        const result = await syncRunRepo.list({
                page: req.query.page ? Number(req.query.page) : undefined,
                pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
                status,
                triggerType,
                accountId
            });
        res.json({ runs: result.items, pagination: { total: result.total, page: result.page, pageSize: result.pageSize } });
    }));
    router.get("/api/admin/sync-runs/:id", asyncHandler(async (req, res) => {
        const run = await syncRunRepo.get(String(req.params.id));
        if (!run) {
            res.status(404).json({ error: "Sync run not found" });
            return;
        }
        res.json({ run });
    }));
    router.post("/api/admin/sync-runs/:id/cancel", asyncHandler(async (req, res) => {
        const existing = await syncRunRepo.get(String(req.params.id));
        if (!existing) {
            res.status(404).json({ error: "Sync run not found" });
            return;
        }
        if (existing.status !== "retry_scheduled") {
            res.status(400).json({ error: "只能取消等待重试的同步任务" });
            return;
        }
        res.json({ run: await syncRunRepo.cancel(String(req.params.id)) });
    }));
    router.delete("/api/admin/sync-runs/:id", asyncHandler(async (req, res) => {
        const deleted = await syncRunRepo.delete(String(req.params.id));
        if (!deleted) {
            res.status(409).json({ error: "运行中的同步任务不能删除" });
            return;
        }
        res.json({ ok: true });
    }));
    router.post("/api/admin/sync-runs/cleanup", asyncHandler(async (_req, res) => {
        const settings = await syncSettingsRepo.get();
        res.json({ deleted: await syncRunRepo.cleanup(settings.retention_days) });
    }));
    router.post("/api/admin/sync/run-all", asyncHandler(async (_req, res) => {
        const result = await dispatchAllSync("manual_all");
        res.json(result);
    }));
    router.post("/api/admin/api-keys", asyncHandler(async (req, res) => {
        const input = createApiKeySchema.parse(req.body);
        const existingAccountIds = new Set((await accountRepo.internalList()).map((account) => account.id));
        const requestedAccountIds = input.allAccounts ? [] : input.accountIds ?? [...existingAccountIds];
        if (requestedAccountIds.some((accountId) => !existingAccountIds.has(accountId))) {
            res.status(400).json({ error: "包含不存在的邮箱账号" });
            return;
        }
        const apiKey = await apiKeyRepo.create({ ...input, accountIds: requestedAccountIds, allAccounts: input.allAccounts });
        res.status(201).json({ apiKey });
    }));
    router.delete("/api/admin/api-keys/:id", asyncHandler(async (req, res) => {
        await apiKeyRepo.delete(String(req.params.id));
        res.json({ ok: true });
    }));
    router.get("/api/admin/saved-searches", asyncHandler(async (_req, res) => {
        res.json({ savedSearches: await savedSearchRepo.list() });
    }));
    router.post("/api/admin/saved-searches", asyncHandler(async (req, res) => {
        const input = createSavedSearchSchema.parse(req.body);
        const savedSearch = await savedSearchRepo.create(input);
        res.status(201).json({ savedSearch });
    }));
    router.delete("/api/admin/saved-searches/:id", asyncHandler(async (req, res) => {
        const deleted = await savedSearchRepo.delete(String(req.params.id));
        if (!deleted) {
            res.status(404).json({ error: "Saved search not found" });
            return;
        }
        res.json({ ok: true });
    }));
    router.get("/api/accounts", asyncHandler(async (_req, res) => {
        const apiKey = currentApiKey(res);
        const accounts = await accountRepo.list();
        const visibleAccounts = apiKey
            ? (await Promise.all(accounts.map(async (account) => ({ account, allowed: await apiKeyRepo.allowsAccount(apiKey, account.id) }))))
                .filter((item) => item.allowed)
                .map((item) => item.account)
            : accounts;
        res.json({ accounts: visibleAccounts });
    }));
    router.post("/api/accounts", asyncHandler(async (req, res) => {
        const input = createAccountSchema.parse(req.body);
        const account = await accountRepo.create(input);
        res.status(201).json({ account });
    }));
    router.put("/api/accounts/:id", asyncHandler(async (req, res) => {
        const input = updateAccountSchema.parse(req.body);
        const accountId = String(req.params.id);
        const existing = await accountRepo.get(accountId);
        if (!existing) {
            res.status(404).json({ error: "Account not found" });
            return;
        }
        if (existing.auth_mode !== input.authMode && !input.password) {
            res.status(400).json({ error: "切换认证方式时必须重新填写应用专用密码、客户端授权码或邮箱密码" });
            return;
        }
        const account = await accountRepo.update(accountId, input);
        if (!account) {
            res.status(404).json({ error: "Account not found" });
            return;
        }
        res.json({ account });
    }));
    router.post("/api/accounts/:id/aliases/:aliasId/verification", asyncHandler(async (req, res) => {
        const account = await accountRepo.get(String(req.params.id));
        if (!account) {
            res.status(404).json({ error: "Account not found" });
            return;
        }
        const verification = await accountRepo.beginAliasVerification(account.id, String(req.params.aliasId));
        if (!verification) {
            res.status(404).json({ error: "Alias not found" });
            return;
        }
        try {
            await dispatchMail({
                accountId: account.id,
                to: [verification.alias.email],
                subject: "Submail 邮箱别名验证码",
                text: `你的邮箱别名验证码是：${verification.code}\n\n验证码 15 分钟内有效。如果不是你本人操作，请忽略这封邮件。`
            });
        }
        catch (error) {
            throw error;
        }
        res.json({ alias: verification.alias, expiresInMinutes: 15 });
    }));
    router.post("/api/accounts/:id/aliases/:aliasId/verification/confirm", asyncHandler(async (req, res) => {
        const input = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
        const alias = await accountRepo.confirmAliasVerification(String(req.params.id), String(req.params.aliasId), input.code);
        if (alias === undefined) {
            res.status(404).json({ error: "Alias not found" });
            return;
        }
        if (alias === null) {
            res.status(400).json({ error: "验证码错误或已过期" });
            return;
        }
        res.json({ alias });
    }));
    router.delete("/api/accounts/:id", asyncHandler(async (req, res) => {
        const deleted = await accountRepo.delete(String(req.params.id));
        if (!deleted) {
            res.status(404).json({ error: "Account not found" });
            return;
        }
        res.json({ ok: true });
    }));
    router.post("/api/accounts/:id/test", asyncHandler(async (req, res) => {
        const account = await accountRepo.get(String(req.params.id));
        if (!account) {
            res.status(404).json({ error: "Account not found" });
            return;
        }
        res.json(await testAccountConnection(account));
    }));
    router.post("/api/accounts/:id/sync", asyncHandler(async (req, res) => {
        const account = await accountRepo.get(String(req.params.id));
        if (!account) {
            res.status(404).json({ error: "Account not found" });
            return;
        }
        const result = await dispatchAccountSync({ accountId: account.id, triggerType: "manual" });
        res.json(result);
    }));
    router.get("/api/messages", asyncHandler(async (req, res) => {
        const requestedAccountId = typeof req.query.accountId === "string" ? req.query.accountId : undefined;
        if (requestedAccountId && !await apiKeyAllowsAccount(res, requestedAccountId)) {
            res.status(403).json({ error: "API key is not allowed to access this account" });
            return;
        }
        const requestedPage = req.query.page ? Number(req.query.page) : 1;
        const safePage = Number.isFinite(requestedPage) ? Math.max(1, Math.trunc(requestedPage)) : 1;
        const requestedPageSize = req.query.pageSize ? Number(req.query.pageSize) : req.query.limit ? Number(req.query.limit) : 50;
        const safePageSize = Number.isFinite(requestedPageSize) ? Math.max(1, Math.min(100, Math.trunc(requestedPageSize))) : 50;
        const apiKey = currentApiKey(res);
        const filters = {
            query: typeof req.query.query === "string" ? req.query.query : undefined,
            accountId: requestedAccountId,
            accountIds: requestedAccountId || !apiKey || apiKey.all_accounts ? undefined : apiKey.account_ids,
            folder: typeof req.query.folder === "string" ? req.query.folder : undefined,
            sender: typeof req.query.sender === "string" ? req.query.sender : undefined,
            dateFrom: typeof req.query.dateFrom === "string" ? req.query.dateFrom : undefined,
            dateTo: typeof req.query.dateTo === "string" ? req.query.dateTo : undefined,
            hasAttachment: queryBool(req.query.hasAttachment)
        };
        const [listedMessages, total, unreadTotal] = await Promise.all([
            messageRepo.list({ ...filters, page: safePage, limit: safePageSize }),
            messageRepo.count(filters),
            messageRepo.countUnreadInbox({ accountId: requestedAccountId, accountIds: filters.accountIds })
        ]);
        const messages = apiKey ? listedMessages.map((message) => ({ ...message, text_body: "", html_body: null })) : listedMessages;
        res.json({
            messages,
            unreadTotal,
            pagination: { total, page: safePage, pageSize: safePageSize }
        });
    }));
    router.get("/api/messages/:id", asyncHandler(async (req, res) => {
        const message = await messageRepo.get(String(req.params.id));
        if (!message) {
            res.status(404).json({ error: "Message not found" });
            return;
        }
        if (!await apiKeyAllowsAccount(res, message.account_id)) {
            res.status(403).json({ error: "API key is not allowed to access this account" });
            return;
        }
        const sourceText = message.text_body || message.snippet || "";
        res.json({
            message,
            attachments: await attachmentRepo.listForMessage(message.id),
            detectedLanguage: detectEnglishText(sourceText) === "english" ? "en" : "unknown"
        });
    }));
    router.get("/api/messages/:id/thread", asyncHandler(async (req, res) => {
        const anchor = await messageRepo.get(String(req.params.id));
        if (!anchor) {
            res.status(404).json({ error: "Message not found" });
            return;
        }
        if (!await apiKeyAllowsAccount(res, anchor.account_id)) {
            res.status(403).json({ error: "API key is not allowed to access this account" });
            return;
        }
        const thread = await messageRepo.threadFor(anchor.id);
        const visible = [];
        for (const message of thread) {
            if (await apiKeyAllowsAccount(res, message.account_id))
                visible.push(message);
        }
        res.json({ messages: visible });
    }));
    router.get("/api/attachments", asyncHandler(async (req, res) => {
        const type = typeof req.query.type === "string" && req.query.type ? z.enum(["image", "text", "pdf", "archive", "other"]).parse(req.query.type) : undefined;
        const result = await attachmentRepo.list({
                page: req.query.page ? Number(req.query.page) : undefined,
                pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
                query: typeof req.query.query === "string" ? req.query.query : undefined,
                type
            });
        res.json({ attachments: result.items, pagination: { total: result.total, page: result.page, pageSize: result.pageSize } });
    }));
    router.get("/api/attachments/:id/preview", asyncHandler(async (req, res) => {
        const attachment = await attachmentRepo.get(String(req.params.id));
        if (!attachment) {
            res.status(404).json({ error: "Attachment not found" });
            return;
        }
        res.json({ attachment: publicAttachment(attachment), preview: await attachmentPreview(attachment) });
    }));
    router.get("/api/attachments/:id/download", asyncHandler(async (req, res) => {
        const attachment = await attachmentRepo.get(String(req.params.id));
        if (!attachment || !attachment.content_blob) {
            res.status(404).json({ error: "Attachment not found" });
            return;
        }
        res.setHeader("content-type", attachment.content_type);
        res.setHeader("content-length", String(attachment.size));
        res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
        res.end(attachment.content_blob);
    }));
    router.get("/api/attachments/:id/content", asyncHandler(async (req, res) => {
        const attachment = await attachmentRepo.get(String(req.params.id));
        if (!attachment || !attachment.content_blob) {
            res.status(404).json({ error: "Attachment not found" });
            return;
        }
        res.setHeader("content-type", attachment.content_type);
        res.setHeader("content-length", String(attachment.size));
        res.setHeader("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
        res.end(attachment.content_blob);
    }));
    router.get("/api/admin/attachment-settings", asyncHandler(async (_req, res) => {
        res.json({ settings: await appSettingsRepo.getAttachmentSettings() });
    }));
    router.put("/api/admin/attachment-settings", asyncHandler(async (req, res) => {
        const input = updateAttachmentSettingsSchema.parse(req.body);
        res.json({ settings: await appSettingsRepo.updateAttachmentSettings({ maxSizeBytes: input.maxSizeMb * 1024 * 1024, retentionDays: input.retentionDays }) });
    }));
    router.post("/api/admin/attachments/cleanup", asyncHandler(async (_req, res) => {
        const settings = await appSettingsRepo.getAttachmentSettings();
        res.json({ deleted: await attachmentRepo.cleanupExpired(settings.retention_days) });
    }));
    router.post("/api/admin/messages/mark-all-read", asyncHandler(async (req, res) => {
        const input = markAllInboxReadSchema.parse(req.body ?? {});
        if (input.accountId && !await accountRepo.get(input.accountId)) {
            res.status(404).json({ error: "Account not found" });
            return;
        }
        const updated = await messageRepo.markAllInboxRead({ accountId: input.accountId });
        const unreadTotal = await messageRepo.countUnreadInbox({ accountId: input.accountId });
        res.json({ updated, unreadTotal });
    }));
    router.post("/api/messages/:id/read", asyncHandler(async (req, res) => {
        await messageRepo.markRead(String(req.params.id), Boolean(req.body?.isRead ?? true));
        res.json({ ok: true });
    }));
    router.patch("/api/messages/bulk-state", asyncHandler(async (req, res) => {
        const input = bulkUpdateMessageStateSchema.parse(req.body);
        if (input.state.isArchived !== undefined || input.state.isDeleted !== undefined) {
            for (const id of [...new Set(input.ids)]) {
                const existing = await messageRepo.get(id);
                if (existing?.remote_mailbox && (existing.folder === "Archive" || existing.folder === "Trash")) {
                    res.status(409).json({ error: "远端归档和垃圾箱邮件当前为只读，请在邮箱服务商中移动或删除" });
                    return;
                }
            }
        }
        const messages = [];
        for (const id of [...new Set(input.ids)]) {
            const message = await messageRepo.updateState(id, input.state);
            if (message)
                messages.push(message);
        }
        res.json({ updated: messages.length, messages });
    }));
    router.patch("/api/messages/:id/state", asyncHandler(async (req, res) => {
        const input = updateMessageStateSchema.parse(req.body);
        const existing = await messageRepo.get(String(req.params.id));
        if (existing?.remote_mailbox
            && (existing.folder === "Archive" || existing.folder === "Trash")
            && (input.isArchived !== undefined || input.isDeleted !== undefined)) {
            res.status(409).json({ error: "远端归档和垃圾箱邮件当前为只读，请在邮箱服务商中移动或删除" });
            return;
        }
        const message = await messageRepo.updateState(String(req.params.id), input);
        if (!message) {
            res.status(404).json({ error: "Message not found" });
            return;
        }
        res.json({ message, attachments: await attachmentRepo.listForMessage(message.id) });
    }));
    router.post("/api/drafts", asyncHandler(async (req, res) => {
        const input = draftMailSchema.parse(req.body);
        const account = await accountRepo.get(input.accountId);
        if (!account) {
            res.status(404).json({ error: "Account not found" });
            return;
        }
        let sender: Awaited<ReturnType<typeof accountRepo.resolveSender>>;
        try {
            sender = await accountRepo.resolveSender(account, input.fromAliasId);
        }
        catch (error) {
            res.status(422).json({ error: error instanceof Error ? error.message : "发信身份不可用" });
            return;
        }
        const attachments = decodeOutgoingAttachments(input.attachments);
        const sizeError = await validateAttachmentSize(attachments);
        if (sizeError) {
            res.status(413).json({ error: sizeError });
            return;
        }
        const message = await messageRepo.createDraft({ account, senderEmail: sender.email, senderName: sender.displayName, to: input.to, subject: input.subject, text: input.text });
        if (attachments.length > 0)
            await attachmentRepo.replaceForMessage(message.id, attachments);
        res.status(201).json({ message, attachments: await attachmentRepo.listForMessage(message.id) });
    }));
    router.patch("/api/drafts/:id", asyncHandler(async (req, res) => {
        const input = draftMailSchema.parse(req.body);
        const existingDraft = await messageRepo.get(String(req.params.id));
        if (existingDraft?.folder === "Drafts" && existingDraft.remote_mailbox) {
            res.status(409).json({ error: "远端草稿当前为只读，请在邮箱服务商中编辑或删除" });
            return;
        }
        const account = await accountRepo.get(input.accountId);
        if (!account) {
            res.status(404).json({ error: "Account not found" });
            return;
        }
        let sender: Awaited<ReturnType<typeof accountRepo.resolveSender>>;
        try {
            sender = await accountRepo.resolveSender(account, input.fromAliasId);
        }
        catch (error) {
            res.status(422).json({ error: error instanceof Error ? error.message : "发信身份不可用" });
            return;
        }
        const attachments = decodeOutgoingAttachments(input.attachments);
        const sizeError = await validateAttachmentSize(attachments);
        if (sizeError) {
            res.status(413).json({ error: sizeError });
            return;
        }
        const message = await messageRepo.updateDraft(String(req.params.id), { account, senderEmail: sender.email, senderName: sender.displayName, to: input.to, subject: input.subject, text: input.text });
        if (!message) {
            res.status(404).json({ error: "Draft not found" });
            return;
        }
        if (input.attachments)
            await attachmentRepo.replaceForMessage(message.id, attachments);
        res.json({ message, attachments: await attachmentRepo.listForMessage(message.id) });
    }));
    router.delete("/api/drafts/:id", asyncHandler(async (req, res) => {
        const draft = await messageRepo.get(String(req.params.id));
        if (draft?.folder === "Drafts" && draft.remote_mailbox) {
            res.status(409).json({ error: "远端草稿当前为只读，请在邮箱服务商中删除" });
            return;
        }
        const deleted = await messageRepo.deleteDraft(String(req.params.id));
        if (!deleted) {
            res.status(404).json({ error: "Draft not found" });
            return;
        }
        res.json({ ok: true });
    }));
    router.post("/api/drafts/:id/send", asyncHandler(async (req, res) => {
        const draft = await messageRepo.get(String(req.params.id));
        if (!draft || draft.folder !== "Drafts") {
            res.status(404).json({ error: "Draft not found" });
            return;
        }
        if (draft.remote_mailbox) {
            res.status(409).json({ error: "远端草稿当前为只读，请在邮箱服务商中发送" });
            return;
        }
        const account = await accountRepo.get(draft.account_id);
        if (!account) {
            res.status(404).json({ error: "Account not found" });
            return;
        }
        let sender: Awaited<ReturnType<typeof accountRepo.resolveSender>>;
        try {
            sender = await accountRepo.resolveSenderByEmail(account, draft.sender_email);
        }
        catch (error) {
            res.status(422).json({ error: error instanceof Error ? error.message : "草稿发信身份不可用" });
            return;
        }
        const recipients = z.array(z.string().email()).min(1).parse(JSON.parse(draft.recipients));
        const draftAttachmentRecords = await Promise.all(
            (await attachmentRepo.listForMessage(draft.id)).map((attachment) => attachmentRepo.get(attachment.id))
        );
        const draftAttachments = draftAttachmentRecords
            .filter((attachment): attachment is NonNullable<Awaited<ReturnType<typeof attachmentRepo.get>>> => Boolean(attachment?.content_blob))
            .map((attachment) => ({
            filename: attachment.filename,
            contentType: attachment.content_type,
            size: attachment.size,
            content: attachment.content_blob as Buffer
        }));
        const sizeError = await validateAttachmentSize(draftAttachments);
        if (sizeError) {
            res.status(413).json({ error: sizeError });
            return;
        }
        const result = await dispatchMail({
            accountId: account.id,
            fromEmail: sender.email,
            fromName: sender.displayName,
            to: recipients,
            subject: draft.subject,
            text: draft.text_body,
            replyTo: sender.replyTo,
            attachments: draftAttachments.map((attachment) => ({
                filename: attachment.filename,
                contentType: attachment.contentType,
                contentBase64: attachment.content.toString("base64")
            }))
        });
        try {
            const message = await messageRepo.convertDraftToSent(draft.id, result.messageId);
            res.json({ ...result, message, localRecordSaved: true });
        }
        catch (error) {
            logger.error({
                accountId: account.id,
                messageId: result.messageId,
                error: error instanceof Error ? error.message : String(error)
            }, "SMTP accepted draft but local Sent conversion failed");
            res.status(202).json({
                ...result,
                message: null,
                localRecordSaved: false,
                warning: "邮件已被上游 SMTP 接受，但本地已发送记录保存失败；请勿直接重发"
            });
        }
    }));
    router.post("/api/send", asyncHandler(async (req, res) => {
        const input = sendMailSchema.parse(req.body);
        const account = await accountRepo.get(input.accountId);
        if (!account) {
            res.status(404).json({ error: "Account not found" });
            return;
        }
        if (!await apiKeyAllowsAccount(res, account.id)) {
            res.status(403).json({ error: "API key is not allowed to send from this account" });
            return;
        }
        let sender: Awaited<ReturnType<typeof accountRepo.resolveSender>>;
        try {
            sender = await accountRepo.resolveSender(account, input.fromAliasId);
        }
        catch (error) {
            res.status(422).json({ error: error instanceof Error ? error.message : "发信身份不可用" });
            return;
        }
        const idempotencyKey = req.header("idempotency-key")?.trim();
        if (idempotencyKey && !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
            res.status(400).json({ error: "Invalid Idempotency-Key" });
            return;
        }
        const apiKey = currentApiKey(res);
        const admin = apiKey ? undefined : await currentSessionAdmin(req);
        const idempotencyStorageKey = idempotencyKey
            ? sha256(`${apiKey ? `key:${apiKey.id}` : `admin:${admin?.id ?? "unknown"}`}\0${account.id}\0${idempotencyKey}`)
            : undefined;
        const requestHash = idempotencyKey ? sha256(stableJson(input)) : undefined;
        const attachments = decodeOutgoingAttachments(input.attachments);
        const sizeError = await validateAttachmentSize(attachments);
        if (sizeError) {
            res.status(413).json({ error: sizeError });
            return;
        }
        let idempotencyClaimed = false;
        if (idempotencyStorageKey && requestHash) {
            const claim = await sendIdempotencyRepo.claim(idempotencyStorageKey, account.id, requestHash);
            if (claim.status === "replay") {
                res.setHeader("x-idempotent-replay", "true");
                res.json(claim.response);
                return;
            }
            if (claim.status === "conflict") {
                res.status(422).json({ error: "Idempotency-Key was already used with a different request" });
                return;
            }
            if (claim.status === "pending") {
                res.status(409).json({ error: "A request with this Idempotency-Key is already in progress" });
                return;
            }
            idempotencyClaimed = true;
        }
        if (apiKey && !await apiKeyRepo.consumeSendQuota(apiKey)) {
            if (idempotencyStorageKey && idempotencyClaimed)
                await sendIdempotencyRepo.release(idempotencyStorageKey, account.id);
            res.status(429).json({ error: "API key daily send limit reached" });
            return;
        }
        let result: MailDeliveryResult;
        try {
            result = await dispatchMail({
                accountId: account.id,
                fromEmail: sender.email,
                fromName: sender.displayName,
                to: input.to,
                cc: input.cc,
                bcc: input.bcc,
                subject: input.subject,
                text: input.text,
                html: input.html,
                replyTo: input.replyTo ?? sender.replyTo,
                inReplyTo: input.inReplyTo,
                references: input.references,
                attachments: attachments.map((attachment) => ({
                    filename: attachment.filename,
                    contentType: attachment.contentType,
                    contentBase64: attachment.content.toString("base64")
                }))
            });
        }
        catch (error) {
            if (idempotencyStorageKey && idempotencyClaimed)
                await sendIdempotencyRepo.release(idempotencyStorageKey, account.id);
            if (apiKey)
                await apiKeyRepo.refundSendQuota(apiKey);
            throw error;
        }
        // SMTP acceptance is the delivery boundary. From this point onward the same
        // idempotency key must never trigger another send, even if local persistence
        // fails. Persist a minimal receipt before the optional local Sent record.
        const deliveryReceipt = {
            ...result,
            partialDelivery: result.rejected.length > 0,
            message: null,
            attachments: [],
            localRecordSaved: false,
            warning: "邮件已被上游 SMTP 接受，但本地已发送记录尚未保存；请勿直接重发"
        };
        if (idempotencyStorageKey) {
            try {
                await sendIdempotencyRepo.complete(idempotencyStorageKey, account.id, deliveryReceipt);
            }
            catch (error) {
                logger.error({
                    accountId: account.id,
                    messageId: result.messageId,
                    error: error instanceof Error ? error.message : String(error)
                }, "SMTP accepted message but idempotency receipt persistence failed");
            }
        }
        try {
            const persisted = await db.transaction(async () => {
                const message = await messageRepo.createSent({
                    account,
                    senderEmail: sender.email,
                    senderName: sender.displayName,
                    // Reflect the recipients actually accepted by the upstream SMTP
                    // server. Rejected recipients remain available in the API receipt.
                    to: result.accepted.length > 0 ? result.accepted : [...input.to, ...input.cc, ...input.bcc],
                    subject: input.subject,
                    text: input.text,
                    html: input.html,
                    inReplyTo: input.inReplyTo,
                    references: input.references
                }, result.messageId);
                if (attachments.length > 0)
                    await attachmentRepo.replaceForMessage(message.id, attachments);
                return { message, attachments: await attachmentRepo.listForMessage(message.id) };
            });
            const response = { ...result, partialDelivery: result.rejected.length > 0, ...persisted, localRecordSaved: true };
            if (idempotencyStorageKey)
                await sendIdempotencyRepo.complete(idempotencyStorageKey, account.id, response);
            res.json(response);
        }
        catch (error) {
            logger.error({
                accountId: account.id,
                messageId: result.messageId,
                error: error instanceof Error ? error.message : String(error)
            }, "SMTP accepted message but local Sent persistence failed");
            res.status(202).json(deliveryReceipt);
        }
    }));
    router.post("/api/ai/summarize", asyncHandler(async (req, res) => {
        const input = aiMessageActionSchema.parse(req.body);
        const message = await messageRepo.get(input.messageId);
        if (!message) {
            res.status(404).json({ error: "Message not found" });
            return;
        }
        if (!await apiKeyAllowsAccount(res, message.account_id)) {
            res.status(403).json({ error: "API key is not allowed to access this account" });
            return;
        }
        res.json({ action: "summary", messageId: message.id, text: await aiService.summarize(message, input.instructions) });
    }));
    router.post("/api/ai/reply", asyncHandler(async (req, res) => {
        const input = aiReplySchema.parse(req.body);
        const message = await messageRepo.get(input.messageId);
        if (!message) {
            res.status(404).json({ error: "Message not found" });
            return;
        }
        if (!await apiKeyAllowsAccount(res, message.account_id)) {
            res.status(403).json({ error: "API key is not allowed to access this account" });
            return;
        }
        res.json({ action: "reply", messageId: message.id, text: await aiService.suggestReply(message, input) });
    }));
    router.post("/api/ai/compose", asyncHandler(async (req, res) => {
        const input = aiComposeSchema.parse(req.body);
        res.json(await aiService.compose(input));
    }));
    router.post("/api/translate", asyncHandler(async (req, res) => {
        const input = translateSchema.parse(req.body);
        const message = input.messageId ? await messageRepo.get(input.messageId) : undefined;
        if (input.messageId && !message) {
            res.status(404).json({ error: "Message not found" });
            return;
        }
        if (message && !await apiKeyAllowsAccount(res, message.account_id)) {
            res.status(403).json({ error: "API key is not allowed to access this account" });
            return;
        }
        const sourceText = input.text || message?.text_body || message?.snippet || "";
        res.json({
            action: "translation",
            messageId: message?.id,
            targetLanguage: input.targetLanguage || (await integrationSettingsRepo.getTranslation()).default_target_language,
            text: await translationService.translate(sourceText, input)
        });
    }));
    router.get("/api/mcp/tools", asyncHandler(async (_req, res) => {
        res.json({
            tools: [
                { name: "list_accounts", description: "列出 Submail 已添加邮箱账号" },
                { name: "search_mail", description: "按关键词、账号、文件夹搜索邮件" },
                { name: "read_mail", description: "读取一封邮件正文" },
                { name: "send_mail", description: "通过指定账号发送邮件" },
                { name: "summarize_mail", description: "使用管理员配置的 AI 总结邮件" },
                { name: "draft_reply", description: "使用管理员配置的 AI 生成推荐回信" },
                { name: "compose_mail", description: "根据要求生成邮件草稿" },
                { name: "translate_mail", description: "翻译邮件正文" }
            ]
        });
    }));
    router.post("/api/mcp/log", asyncHandler(async (req, res) => {
        const schema = z.object({
            toolName: z.string(),
            input: z.unknown(),
            status: z.enum(["ok", "error"])
        });
        const input = schema.parse(req.body);
        await mcpLogRepo.record(input.toolName, input.input, input.status);
        res.json({ ok: true });
    }));
    return router;
}
