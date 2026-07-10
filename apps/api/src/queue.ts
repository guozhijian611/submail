import { Queue, QueueEvents, Worker, type ConnectionOptions, type Job } from "bullmq";
import pino from "pino";
import { config } from "./config.js";

const logger = pino({ name: "submail-queue" });

export type MailDeliveryResult = {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
};

export type SendJobInput = {
  accountId: string;
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
  attachments?: Array<{ filename: string; contentType: string; contentBase64: string }>;
};

export type SyncAccountJobInput = {
  accountId: string;
  triggerType: "manual" | "manual_all" | "scheduled";
  initialLimit?: number;
};

export type SyncAccountResult = { runId: string; status: string; imported: number; error?: string };
export type SyncAllResult = {
  total: number;
  ok: number;
  error: number;
  skipped: number;
  imported: number;
  results: Array<{ accountId: string; status: string; imported: number; error?: string }>;
};

type JobData =
  | { type: "send"; payload: SendJobInput }
  | { type: "sync_account"; payload: SyncAccountJobInput }
  | { type: "sync_all"; payload: { triggerType: "manual_all" | "scheduled" } };

export type JobHandlers = {
  send(input: SendJobInput): Promise<MailDeliveryResult>;
  syncAccount(input: SyncAccountJobInput): Promise<SyncAccountResult>;
  syncAll(input: { triggerType: "manual_all" | "scheduled" }): Promise<SyncAllResult>;
};

let handlers: JobHandlers | undefined;
let redisQueue: Queue | undefined;
let redisWorker: Worker | undefined;
let redisEvents: QueueEvents | undefined;

function requireHandlers(): JobHandlers {
  if (!handlers) throw new Error("任务队列尚未初始化");
  return handlers;
}

async function processJob(job: Job<JobData>): Promise<unknown> {
  const currentHandlers = requireHandlers();
  switch (job.data.type) {
    case "send": {
      try {
        return await currentHandlers.send(job.data.payload);
      } catch (error) {
        const mailError = error as { code?: string; responseCode?: number };
        throw new Error(`SUBMAIL_MAIL_ERROR:${JSON.stringify({
          message: error instanceof Error ? error.message : "Mail delivery failed",
          code: mailError.code,
          responseCode: mailError.responseCode
        })}`);
      }
    }
    case "sync_account":
      return currentHandlers.syncAccount(job.data.payload);
    case "sync_all":
      return currentHandlers.syncAll(job.data.payload);
  }
}

function rethrowJobError(data: JobData, error: unknown): never {
  if (data.type === "send" && error instanceof Error && error.message.startsWith("SUBMAIL_MAIL_ERROR:")) {
    try {
      const details = JSON.parse(error.message.slice("SUBMAIL_MAIL_ERROR:".length)) as {
        message?: string;
        code?: string;
        responseCode?: number;
      };
      throw Object.assign(new Error(details.message || "Mail delivery failed"), {
        code: details.code,
        responseCode: details.responseCode
      });
    } catch (parsedError) {
      if (!(parsedError instanceof SyntaxError)) throw parsedError;
    }
  }
  throw error;
}

function redisConnectionOptions(): ConnectionOptions {
  const url = new URL(config.redisUrl);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("SUBMAIL_REDIS_URL 仅支持 redis:// 或 rediss://");
  }
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  };
}

export async function startJobQueue(nextHandlers: JobHandlers): Promise<void> {
  handlers = nextHandlers;
  if (config.queueDriver === "memory") return;

  const connection = redisConnectionOptions();
  const queueName = `${config.queuePrefix}-jobs`;
  redisQueue = new Queue(queueName, {
    connection,
    defaultJobOptions: {
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 }
    }
  });
  redisEvents = new QueueEvents(queueName, { connection });
  redisWorker = new Worker(queueName, (job) => processJob(job as Job<JobData>), {
    connection,
    concurrency: config.queueConcurrency
  });
  redisEvents.on("error", (error) => logger.error({ error }, "Redis queue events connection failed"));
  redisWorker.on("error", (error) => logger.error({ error }, "Redis queue worker failed"));
  await Promise.all([redisEvents.waitUntilReady(), redisWorker.waitUntilReady()]);
}

async function dispatch<T>(data: JobData, timeoutMs: number): Promise<T> {
  if (config.queueDriver === "memory") {
    try {
      return await processJob({ data } as Job<JobData>) as T;
    } catch (error) {
      rethrowJobError(data, error);
    }
  }
  if (!redisQueue || !redisEvents) throw new Error("Redis 任务队列尚未就绪");
  const isSend = data.type === "send";
  const job = await redisQueue.add(data.type, data, {
    // Automatic SMTP retries can duplicate a message when the server accepted
    // it but the network dropped before the final response was received.
    attempts: isSend ? 1 : 2,
    backoff: isSend ? undefined : { type: "exponential", delay: 5_000 }
  });
  try {
    return await job.waitUntilFinished(redisEvents, timeoutMs) as T;
  } catch (error) {
    rethrowJobError(data, error);
  }
}

export function dispatchMail(input: SendJobInput): Promise<MailDeliveryResult> {
  return dispatch<MailDeliveryResult>({ type: "send", payload: input }, Math.max(config.mailConnectionTimeoutMs * 4, 120_000));
}

export function dispatchAccountSync(input: SyncAccountJobInput): Promise<SyncAccountResult> {
  return dispatch<SyncAccountResult>({ type: "sync_account", payload: input }, 15 * 60_000);
}

export function dispatchAllSync(triggerType: "manual_all" | "scheduled"): Promise<SyncAllResult> {
  return dispatch<SyncAllResult>({ type: "sync_all", payload: { triggerType } }, 60 * 60_000);
}

export async function queueHealth(): Promise<{ driver: "memory" | "redis"; ok: boolean }> {
  if (config.queueDriver === "memory") return { driver: "memory", ok: true };
  if (!redisQueue) return { driver: "redis", ok: false };
  await redisQueue.getJobCounts("wait", "active", "failed");
  return { driver: "redis", ok: true };
}

export async function stopJobQueue(): Promise<void> {
  await Promise.allSettled([redisWorker?.close(), redisEvents?.close(), redisQueue?.close()].filter(Boolean) as Promise<unknown>[]);
  redisWorker = undefined;
  redisEvents = undefined;
  redisQueue = undefined;
  handlers = undefined;
}
