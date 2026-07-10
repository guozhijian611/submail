import crypto from "node:crypto";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import pino from "pino";
import { ZodError } from "zod";
import { config, validateProductionConfig } from "./config.js";
import { acquireRuntimeLock } from "./runtime-lock.js";
const logger = pino({ name: "submail-api" });
const app = express();
validateProductionConfig();
const runtimeLockIdentity = config.dbDriver === "sqlite" ? config.dbPath : path.join(config.storageDir, "mysql-runtime");
const runtimeLock = acquireRuntimeLock(runtimeLockIdentity, {
    purpose: "api",
    allowStaleBreak: process.env.SUBMAIL_BREAK_STALE_RUNTIME_LOCK === "YES"
});
let openedDb: (typeof import("./db.js"))["db"] | undefined;
try {
    const [repositoriesModule, routesModule, syncModule, dbModule, integrationsModule, queueModule, mailModule] = await Promise.all([
        import("./repositories.js"),
        import("./routes.js"),
        import("./sync.js"),
        import("./db.js"),
        import("./integrations.js"),
        import("./queue.js"),
        import("./mail.js")
    ]);
    const { attachmentRepo, bootstrapRepo, maintenanceRepo, messageRepo, searchIndexRepo, sendIdempotencyRepo, syncRunRepo } = repositoriesModule;
    const { routes } = routesModule;
    const { runAccountSync, runAllAccountsSync, startSyncScheduler, stopSyncScheduler, waitForActiveSyncs } = syncModule;
    const { db } = dbModule;
    const { UpstreamServiceError } = integrationsModule;
    const { startJobQueue, stopJobQueue } = queueModule;
    const { sendMail } = mailModule;
    openedDb = db;
    app.set("trust proxy", config.trustProxy ? 1 : false);
    type RateBucket = {
        count: number;
        resetAt: number;
    };
    const rateBuckets = new Map<string, RateBucket>();
    function rateLimit(input: {
        paths: string[];
        limit: number;
        windowMs: number;
    }) {
        return (req: Request, res: Response, next: NextFunction) => {
            if (!input.paths.includes(req.path)) {
                next();
                return;
            }
            const now = Date.now();
            const key = `${req.ip}:${req.path}`;
            const current = rateBuckets.get(key);
            const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + input.windowMs } : current;
            bucket.count += 1;
            rateBuckets.set(key, bucket);
            if (bucket.count > input.limit) {
                res.setHeader("retry-after", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
                res.status(429).json({ error: "请求过于频繁，请稍后重试" });
                return;
            }
            next();
        };
    }
    app.use((req, res, next) => {
        const requestId = req.header("x-request-id")?.slice(0, 100) || crypto.randomUUID();
        res.locals.requestId = requestId;
        res.setHeader("x-request-id", requestId);
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("x-frame-options", "DENY");
        res.setHeader("referrer-policy", "no-referrer");
        res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
        next();
    });
    app.use(express.json({ limit: "40mb" }));
    app.use(rateLimit({ paths: ["/api/auth/login", "/api/setup/admin"], limit: 10, windowMs: 15 * 60000 }));
    app.use(rateLimit({ paths: ["/api/send", "/api/ai/summarize", "/api/ai/reply", "/api/ai/compose", "/api/translate"], limit: 60, windowMs: 60000 }));
    app.use(routes());
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        if (error instanceof ZodError) {
            res.status(400).json({
                error: "请求参数不正确",
                details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
                requestId: res.locals.requestId
            });
            return;
        }
        if (error instanceof UpstreamServiceError) {
            res.status(error.status).json({ error: error.message, requestId: res.locals.requestId });
            return;
        }
        const mailError = error as {
            code?: string;
            responseCode?: number;
        };
        if (["EAUTH", "EENVELOPE", "EMESSAGE"].includes(mailError.code ?? "") || (mailError.responseCode && mailError.responseCode >= 500)) {
            res.status(422).json({ error: "上游 SMTP 永久拒绝发送，请检查账号凭据、收件人和发信策略", retryable: false, requestId: res.locals.requestId });
            return;
        }
        if (["ETIMEDOUT", "ESOCKET", "ECONNECTION", "EDNS", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET"].includes(mailError.code ?? "") || (mailError.responseCode && mailError.responseCode >= 400)) {
            res.status(503).json({ error: "上游邮件服务暂时不可用，请稍后重试", retryable: true, requestId: res.locals.requestId });
            return;
        }
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ error, requestId: res.locals.requestId }, "API request failed");
        res.status(500).json({
            error: config.isProduction ? "服务处理失败，请查看服务端日志" : message,
            requestId: res.locals.requestId
        });
    });
    await startJobQueue({
        async send(input) {
            const account = await repositoriesModule.accountRepo.get(input.accountId);
            if (!account)
                throw new Error("Account not found");
            return sendMail({
                account,
                fromEmail: input.fromEmail,
                fromName: input.fromName,
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
                    content: Buffer.from(attachment.contentBase64, "base64")
                }))
            });
        },
        async syncAccount(input) {
            const account = await repositoriesModule.accountRepo.get(input.accountId);
            if (!account)
                throw new Error("Account not found");
            return runAccountSync(account, input.triggerType, input.initialLimit);
        },
        async syncAll(input) {
            return runAllAccountsSync(input.triggerType);
        }
    });
    await bootstrapRepo.initialize();
    await sendIdempotencyRepo.cleanup();
    await maintenanceRepo.cleanup();
    const recoveredSyncRuns = await syncRunRepo.recoverInterrupted();
    if (recoveredSyncRuns > 0)
        logger.warn({ recoveredSyncRuns }, "Marked interrupted sync runs as failed");
    if (config.demoMode) {
        await messageRepo.seedIfEmpty();
        await attachmentRepo.seedDemoIfEmpty();
    }
    await searchIndexRepo.ensure();
    const httpServer = app.listen(config.port, config.host);
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        httpServer.once("error", onError);
        httpServer.once("listening", () => {
            httpServer.off("error", onError);
            resolve();
        });
    });
    logger.info({ port: config.port, database: config.dbDriver, dbPath: config.dbDriver === "sqlite" ? config.dbPath : undefined }, "Submail API listening");
    startSyncScheduler(logger);
    const maintenanceTimer = setInterval(async () => {
        try {
            await sendIdempotencyRepo.cleanup();
            const cleaned = await maintenanceRepo.cleanup();
            logger.info(cleaned, "Submail maintenance cleanup completed");
        }
        catch (error) {
            logger.error({ error }, "Submail maintenance cleanup failed");
        }
    }, 24 * 60 * 60 * 1000);
    maintenanceTimer.unref();
    let shuttingDown = false;
    async function shutdown(signal: NodeJS.Signals): Promise<void> {
        if (shuttingDown)
            return;
        shuttingDown = true;
        logger.info({ signal }, "Submail API shutting down");
        stopSyncScheduler();
        clearInterval(maintenanceTimer);
        const httpClosed = new Promise<void>((resolve, reject) => {
            httpServer.close((error) => error ? reject(error) : resolve());
        });
        httpServer.closeIdleConnections();
        try {
            const drained = await waitForActiveSyncs(10000);
            if (!drained)
                logger.warn("Timed out waiting for active sync jobs");
            await httpClosed;
            await stopJobQueue();
            await db.checkpoint();
        }
        finally {
            if (db.open)
                await db.close();
            if (!runtimeLock.release())
                logger.warn({ lockPath: runtimeLock.path }, "Runtime lock ownership changed; lock was not removed");
        }
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
            shutdown(signal)
                .then(() => process.exit(0))
                .catch((error: unknown) => {
                logger.error({ error }, "Submail API shutdown failed");
                process.exit(1);
            });
        });
    }
}
catch (error) {
    try {
        if (openedDb?.open)
            await openedDb.close();
    }
    finally {
        runtimeLock.release();
    }
    throw error;
}
