import type pino from "pino";
import { accountRepo, syncRunRepo, syncSettingsRepo } from "./repositories.js";
import { syncInbox } from "./mail.js";
import type { AccountRecord } from "./types.js";
import { dispatchAllSync } from "./queue.js";
const runningAccounts = new Set<string>();
let activeSyncJobs = 0;
let schedulerRunning = false;
let schedulerTimer: NodeJS.Timeout | undefined;
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown sync error";
}
function addMinutes(date: Date, minutes: number): string {
    return new Date(date.getTime() + minutes * 60 * 1000).toISOString();
}
async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(limit, items.length || 1));
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index]);
        }
    }));
    return results;
}
async function executeSyncRun(account: AccountRecord, runId: string, previousAttempts: number, initialLimit?: number): Promise<{
    runId: string;
    status: string;
    imported: number;
    error?: string;
}> {
    const settings = await syncSettingsRepo.get();
    const maxAttempts = Math.max(1, settings.retry_max_attempts);
    const attempt = Math.min(previousAttempts + 1, maxAttempts);
    try {
        const result = await syncInbox(account, initialLimit ?? settings.initial_limit ?? 30);
        await syncRunRepo.finish(runId, { status: "ok", imported: result.imported, attempts: attempt });
        return { runId, status: "ok", imported: result.imported };
    }
    catch (error) {
        const message = errorMessage(error);
        if (attempt < maxAttempts) {
            const nextRetryAt = addMinutes(new Date(), settings.retry_delay_minutes);
            await syncRunRepo.finish(runId, { status: "retry_scheduled", error: message, attempts: attempt, nextRetryAt });
            return { runId, status: "retry_scheduled", imported: 0, error: message };
        }
        await syncRunRepo.finish(runId, { status: "error", error: message, attempts: attempt });
        return { runId, status: "error", imported: 0, error: message };
    }
}
export async function runAccountSync(account: AccountRecord, triggerType: "manual" | "manual_all" | "scheduled", initialLimit?: number): Promise<{
    runId: string;
    status: string;
    imported: number;
    error?: string;
}> {
    if (runningAccounts.has(account.id)) {
        const run = await syncRunRepo.start({ accountId: account.id, triggerType });
        await syncRunRepo.finish(run.id, { status: "skipped", error: "Account sync already running" });
        return { runId: run.id, status: "skipped", imported: 0, error: "Account sync already running" };
    }
    runningAccounts.add(account.id);
    activeSyncJobs += 1;
    const run = await syncRunRepo.start({ accountId: account.id, triggerType });
    try {
        return await executeSyncRun(account, run.id, run.attempts, initialLimit);
    }
    finally {
        runningAccounts.delete(account.id);
        activeSyncJobs -= 1;
    }
}
export async function runAllAccountsSync(triggerType: "manual_all" | "scheduled"): Promise<{
    total: number;
    ok: number;
    error: number;
    skipped: number;
    imported: number;
    results: Array<{
        accountId: string;
        status: string;
        imported: number;
        error?: string;
    }>;
}> {
    const accounts = await accountRepo.internalList();
    const settings = await syncSettingsRepo.get();
    const concurrencyLimit = Math.max(1, Math.min(10, settings.concurrency_limit));
    const results = await runWithConcurrency(accounts, concurrencyLimit, async (account) => {
        const result = await runAccountSync(account, triggerType, settings.initial_limit);
        return { accountId: account.id, status: result.status, imported: result.imported, error: result.error };
    });
    return {
        total: results.length,
        ok: results.filter((item) => item.status === "ok").length,
        error: results.filter((item) => item.status === "error" || item.status === "retry_scheduled").length,
        skipped: results.filter((item) => item.status === "skipped").length,
        imported: results.reduce((sum, item) => sum + item.imported, 0),
        results
    };
}
export async function runDueRetrySyncs(logger?: pino.Logger): Promise<void> {
    const settings = await syncSettingsRepo.get();
    const availableSlots = Math.max(0, Math.min(10, settings.concurrency_limit) - activeSyncJobs);
    if (availableSlots <= 0)
        return;
    const dueRuns = await syncRunRepo.listDueRetries(availableSlots);
    await runWithConcurrency(dueRuns, availableSlots, async (run) => {
        if (!run.account_id) {
            await syncRunRepo.finish(run.id, { status: "skipped", error: "Retry run has no account", attempts: run.attempts });
            return;
        }
        if (runningAccounts.has(run.account_id))
            return;
        const account = await accountRepo.get(run.account_id);
        if (!account) {
            await syncRunRepo.finish(run.id, { status: "skipped", error: "Account was deleted before retry", attempts: run.attempts });
            return;
        }
        runningAccounts.add(account.id);
        activeSyncJobs += 1;
        await syncRunRepo.markRunning(run.id);
        try {
            const result = await executeSyncRun(account, run.id, run.attempts, settings.initial_limit);
            logger?.info({ runId: run.id, accountId: account.id, result }, "Persistent sync retry completed");
        }
        finally {
            runningAccounts.delete(account.id);
            activeSyncJobs -= 1;
        }
    });
}
export async function runScheduledSyncIfDue(logger?: pino.Logger): Promise<void> {
    if (schedulerRunning)
        return;
    const settings = await syncSettingsRepo.get();
    if (!settings.enabled || !settings.next_run_at)
        return;
    if (new Date(settings.next_run_at).getTime() > Date.now())
        return;
    schedulerRunning = true;
    await syncSettingsRepo.markScheduledRunStarted();
    try {
        const result = await dispatchAllSync("scheduled");
        logger?.info(result, "Scheduled sync completed");
    }
    catch (error) {
        logger?.error({ error: errorMessage(error) }, "Scheduled sync failed");
    }
    finally {
        schedulerRunning = false;
    }
}
export function startSyncScheduler(logger?: pino.Logger): void {
    if (schedulerTimer)
        return;
    runDueRetrySyncs(logger).catch((error) => {
        logger?.error({ error: errorMessage(error) }, "Persistent sync retry startup scan failed");
    });
    schedulerTimer = setInterval(() => {
        (async () => {
            await runDueRetrySyncs(logger);
            await runScheduledSyncIfDue(logger);
        })().catch((error) => {
            logger?.error({ error: errorMessage(error) }, "Scheduled sync tick failed");
        });
    }, 30000);
    schedulerTimer.unref();
}
export function stopSyncScheduler(): void {
    if (!schedulerTimer)
        return;
    clearInterval(schedulerTimer);
    schedulerTimer = undefined;
}
export async function waitForActiveSyncs(timeoutMs = 10000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while ((activeSyncJobs > 0 || schedulerRunning) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return activeSyncJobs === 0 && !schedulerRunning;
}
