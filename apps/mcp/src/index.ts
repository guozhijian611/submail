import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const apiBaseUrl = (process.env.SUBMAIL_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const transportMode = (process.env.SUBMAIL_MCP_TRANSPORT ?? "stdio").trim().toLowerCase();
const httpHost = process.env.SUBMAIL_MCP_HOST ?? "127.0.0.1";
const httpPort = positiveIntegerEnv("SUBMAIL_MCP_PORT", 3000, 65_535);
const maxBodyBytes = positiveIntegerEnv("SUBMAIL_MCP_MAX_BODY_BYTES", 40 * 1024 * 1024, 64 * 1024 * 1024);
const apiTimeoutMs = positiveIntegerEnv("SUBMAIL_MCP_API_TIMEOUT_MS", 120_000, 10 * 60_000);
type ApiClient = <T>(path: string, init?: RequestInit) => Promise<T>;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function positiveIntegerEnv(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

function createApiClient(apiKey: string): ApiClient {
  return async <T>(path: string, init?: RequestInit): Promise<T> => {
    const headers = new Headers(init?.headers);
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    headers.set("x-submail-api-key", apiKey);

    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(apiTimeoutMs)
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2_000);
      throw new Error(`Submail API ${response.status}: ${detail || response.statusText}`);
    }
    return response.json() as Promise<T>;
  };
}

function auditInput(toolName: string, input: unknown): Record<string, unknown> {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  switch (toolName) {
    case "search_mail":
      return {
        hasQuery: typeof value.query === "string" && value.query.length > 0,
        accountId: value.accountId,
        folder: value.folder,
        hasSenderFilter: typeof value.sender === "string" && value.sender.length > 0,
        dateFrom: value.dateFrom,
        dateTo: value.dateTo,
        hasAttachment: value.hasAttachment,
        limit: value.limit
      };
    case "read_mail":
    case "summarize_mail":
      return {
        messageId: value.id ?? value.messageId,
        hasInstructions: typeof value.instructions === "string" && value.instructions.length > 0,
        instructionsLength: typeof value.instructions === "string" ? value.instructions.length : 0
      };
    case "draft_reply":
      return {
        messageId: value.messageId,
        hasInstructions: typeof value.instructions === "string" && value.instructions.length > 0,
        instructionsLength: typeof value.instructions === "string" ? value.instructions.length : 0,
        tone: value.tone,
        language: value.language
      };
    case "compose_mail":
      return {
        promptLength: typeof value.prompt === "string" ? value.prompt.length : 0,
        language: value.language,
        tone: value.tone,
        hasRecipientContext: typeof value.recipientContext === "string" && value.recipientContext.length > 0,
        hasSubjectHint: typeof value.subjectHint === "string" && value.subjectHint.length > 0
      };
    case "translate_mail":
      return {
        messageId: value.messageId,
        textLength: typeof value.text === "string" ? value.text.length : 0,
        sourceLanguage: value.sourceLanguage,
        targetLanguage: value.targetLanguage
      };
    case "send_mail": {
      const recipients = [value.to, value.cc, value.bcc].flatMap((item) => Array.isArray(item) ? item : []);
      const attachments = Array.isArray(value.attachments) ? value.attachments : [];
      return {
        accountId: value.accountId,
        recipientCount: recipients.length,
        subjectLength: typeof value.subject === "string" ? value.subject.length : 0,
        textLength: typeof value.text === "string" ? value.text.length : 0,
        htmlLength: typeof value.html === "string" ? value.html.length : 0,
        hasReplyTo: typeof value.replyTo === "string" && value.replyTo.length > 0,
        hasThreadHeaders: Boolean(value.inReplyTo || (Array.isArray(value.references) && value.references.length > 0)),
        hasIdempotencyKey: typeof value.idempotencyKey === "string" && value.idempotencyKey.length > 0,
        attachmentCount: attachments.length,
        attachmentEncodedBytes: attachments.reduce((sum, attachment) => {
          if (!attachment || typeof attachment !== "object") return sum;
          const content = (attachment as Record<string, unknown>).contentBase64;
          return sum + (typeof content === "string" ? content.length : 0);
        }, 0)
      };
    }
    default:
      return {};
  }
}

async function logTool(api: ApiClient, toolName: string, input: unknown, status: "ok" | "error"): Promise<void> {
  await api("/api/mcp/log", {
    method: "POST",
    body: JSON.stringify({ toolName, input: auditInput(toolName, input), status })
  }).catch(() => undefined);
}

async function executeTool<T>(api: ApiClient, toolName: string, input: unknown, operation: () => Promise<T>): Promise<T> {
  try {
    const result = await operation();
    await logTool(api, toolName, input, "ok");
    return result;
  } catch (error) {
    await logTool(api, toolName, input, "error");
    throw error;
  }
}

function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function createSubmailServer(apiKey: string): McpServer {
  const api = createApiClient(apiKey);
  const server = new McpServer({ name: "submail", version: "0.2.0" });

  server.tool("list_accounts", "列出 Submail 已添加邮箱账号", {}, async (input) => {
    const data = await executeTool(api, "list_accounts", input, () => api<unknown>("/api/accounts"));
    return toolResult(data);
  });

  server.tool(
    "search_mail",
    "按关键词、账号、文件夹、发件人和日期搜索邮件",
    {
      query: z.string().max(500).optional().describe("搜索关键词"),
      accountId: z.string().optional().describe("邮箱账号 ID"),
      folder: z.string().optional().describe("邮件文件夹，例如 INBOX"),
      sender: z.string().max(320).optional().describe("按发件人名称或邮箱过滤"),
      dateFrom: z.string().optional().describe("起始时间 ISO 字符串"),
      dateTo: z.string().optional().describe("结束时间 ISO 字符串"),
      hasAttachment: z.boolean().optional().describe("是否只返回带附件邮件"),
      limit: z.number().int().min(1).max(50).optional().describe("返回数量")
    },
    async (input) => {
      const data = await executeTool(api, "search_mail", input, async () => {
        const params = new URLSearchParams();
        if (input.query) params.set("query", input.query);
        if (input.accountId) params.set("accountId", input.accountId);
        if (input.folder) params.set("folder", input.folder);
        if (input.sender) params.set("sender", input.sender);
        if (input.dateFrom) params.set("dateFrom", input.dateFrom);
        if (input.dateTo) params.set("dateTo", input.dateTo);
        if (input.hasAttachment !== undefined) params.set("hasAttachment", String(input.hasAttachment));
        if (input.limit) params.set("limit", String(input.limit));
        return api<unknown>(`/api/messages?${params.toString()}`);
      });
      return toolResult(data);
    }
  );

  server.tool("read_mail", "读取一封邮件正文", { id: z.string().describe("邮件 ID") }, async (input) => {
    const data = await executeTool(api, "read_mail", input, () => api<unknown>(`/api/messages/${encodeURIComponent(input.id)}`));
    return toolResult(data);
  });

  server.tool(
    "send_mail",
    "通过指定账号发送文本或 HTML 邮件，支持 CC、BCC、线程头、幂等键和附件",
    {
      accountId: z.string().describe("发信账号 ID"),
      fromAliasId: z.string().optional().describe("可选的已验证发信别名 ID；不传则使用主邮箱地址"),
      to: z.array(z.string().email()).max(100).default([]).describe("To 收件人邮箱数组"),
      cc: z.array(z.string().email()).max(100).default([]).describe("可选 CC 收件人邮箱数组"),
      bcc: z.array(z.string().email()).max(100).default([]).describe("可选 BCC 收件人邮箱数组"),
      subject: z.string().min(1).max(998).describe("邮件主题"),
      text: z.string().max(2_000_000).default("").describe("纯文本正文；与 html 至少提供一个"),
      html: z.string().max(2_000_000).optional().describe("可选 HTML 正文"),
      replyTo: z.string().email().optional().describe("可选 Reply-To 地址"),
      inReplyTo: z.string().max(1_000).optional().describe("可选 In-Reply-To 消息 ID"),
      references: z.array(z.string().max(1_000)).max(100).optional().describe("可选 References 消息 ID 列表"),
      idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/).optional().describe("可选幂等键，重试发送时保持不变"),
      attachments: z.array(z.object({
        filename: z.string().min(1).max(255).describe("附件文件名"),
        contentType: z.string().default("application/octet-stream").describe("附件 MIME 类型"),
        contentBase64: z.string().min(1).describe("附件内容 base64")
      })).max(20).optional().describe("可选附件列表")
    },
    async (input) => {
      if (input.to.length + input.cc.length + input.bcc.length === 0) throw new Error("至少填写一个 To、CC 或 BCC 收件人");
      if (!input.text.trim() && !input.html?.trim()) throw new Error("text 和 html 至少填写一个");
      const { idempotencyKey, ...payload } = input;
      const data = await executeTool(api, "send_mail", input, () => api<unknown>("/api/send", {
        method: "POST",
        headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined,
        body: JSON.stringify(payload)
      }));
      return toolResult(data);
    }
  );

  server.tool(
    "summarize_mail",
    "使用管理员配置的 AI 总结指定邮件",
    {
      messageId: z.string().describe("邮件 ID"),
      instructions: z.string().max(5_000).optional().describe("可选总结要求")
    },
    async (input) => {
      const data = await executeTool(api, "summarize_mail", input, () => api<unknown>("/api/ai/summarize", {
        method: "POST",
        body: JSON.stringify(input)
      }));
      return toolResult(data);
    }
  );

  server.tool(
    "draft_reply",
    "使用管理员配置的 AI 为指定邮件生成推荐回信",
    {
      messageId: z.string().describe("邮件 ID"),
      instructions: z.string().max(5_000).optional().describe("可选回信要求"),
      tone: z.string().max(200).optional().describe("语气，例如专业、友好、简洁"),
      language: z.string().max(32).optional().describe("回信语言")
    },
    async (input) => {
      const data = await executeTool(api, "draft_reply", input, () => api<unknown>("/api/ai/reply", {
        method: "POST",
        body: JSON.stringify(input)
      }));
      return toolResult(data);
    }
  );

  server.tool(
    "compose_mail",
    "根据要求生成邮件草稿，不直接发送",
    {
      prompt: z.string().min(1).max(10_000).describe("邮件写作要求"),
      language: z.string().max(32).optional().describe("邮件语言"),
      tone: z.string().max(200).optional().describe("邮件语气"),
      recipientContext: z.string().max(2_000).optional().describe("收件人背景"),
      subjectHint: z.string().max(500).optional().describe("主题提示")
    },
    async (input) => {
      const data = await executeTool(api, "compose_mail", input, () => api<unknown>("/api/ai/compose", {
        method: "POST",
        body: JSON.stringify(input)
      }));
      return toolResult(data);
    }
  );

  server.tool(
    "translate_mail",
    "翻译指定邮件或直接提供的文本",
    {
      messageId: z.string().optional().describe("要翻译的邮件 ID，与 text 至少提供一个"),
      text: z.string().min(1).max(50_000).optional().describe("直接翻译的文本，与 messageId 至少提供一个"),
      sourceLanguage: z.string().max(32).optional().describe("源语言，留空自动检测"),
      targetLanguage: z.string().max(32).optional().describe("目标语言，留空使用系统默认值")
    },
    async (input) => {
      if (!input.messageId && !input.text) throw new Error("messageId 和 text 至少填写一个");
      const data = await executeTool(api, "translate_mail", input, () => api<unknown>("/api/translate", {
        method: "POST",
        body: JSON.stringify(input)
      }));
      return toolResult(data);
    }
  );

  return server;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestApiKey(req: IncomingMessage): string {
  const authorization = firstHeader(req.headers.authorization)?.trim();
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  const bearer = bearerMatch?.[1]?.trim();
  const headerKey = firstHeader(req.headers["x-submail-api-key"])?.trim();

  if (authorization && !bearer) throw new HttpError(401, "Authorization 必须使用 Bearer API Key");
  if (bearer && headerKey && bearer !== headerKey) throw new HttpError(400, "请求中包含两个不一致的 API Key");
  const key = bearer ?? headerKey;
  if (!key) throw new HttpError(401, "缺少 Authorization Bearer 或 x-submail-api-key");
  if (key.length < 16 || key.length > 2_000) throw new HttpError(401, "API Key 格式无效");
  return key;
}

function forwardedHost(req: IncomingMessage): string {
  const value = firstHeader(req.headers["x-forwarded-host"]) ?? firstHeader(req.headers.host) ?? "";
  return value.split(",")[0].trim().toLowerCase();
}

function validateOrigin(req: IncomingMessage): string | undefined {
  const origin = firstHeader(req.headers.origin)?.trim();
  if (!origin) return undefined;
  if (origin.length > 2_000 || origin === "null") throw new HttpError(403, "Origin 不被允许");
  try {
    if (new URL(origin).host.toLowerCase() === forwardedHost(req)) return origin;
  } catch {
    throw new HttpError(403, "Origin 不被允许");
  }
  throw new HttpError(403, "Origin 不被允许");
}

function applyHttpHeaders(res: ServerResponse, origin?: string): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", "no-store");
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-expose-headers", "mcp-session-id");
    res.setHeader("vary", "Origin");
  }
}

function writeJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function writeMcpError(res: ServerResponse, status: number, message: string): void {
  writeJson(res, status, {
    jsonrpc: "2.0",
    error: { code: status === 401 ? -32001 : -32000, message },
    id: null
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new HttpError(413, `MCP 请求体不得超过 ${maxBodyBytes} 字节`);
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new HttpError(400, "请求体不能为空");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "请求体不是有效 JSON");
  }
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://submail-mcp.local");

  if (url.pathname === "/health" && req.method === "GET") {
    applyHttpHeaders(res);
    writeJson(res, 200, { ok: true, service: "submail-mcp", transport: "streamable-http" });
    return;
  }
  if (url.pathname !== "/mcp") {
    applyHttpHeaders(res);
    writeJson(res, 404, { error: "Not found" });
    return;
  }

  const origin = validateOrigin(req);
  applyHttpHeaders(res, origin);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, x-submail-api-key",
      "access-control-max-age": "86400"
    });
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("allow", "POST, OPTIONS");
    writeMcpError(res, 405, "Method not allowed");
    return;
  }
  if (!firstHeader(req.headers["content-type"])?.toLowerCase().startsWith("application/json")) {
    writeMcpError(res, 415, "Content-Type 必须是 application/json");
    return;
  }

  const apiKey = requestApiKey(req);
  const body = await readJsonBody(req);
  const server = createSubmailServer(apiKey);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } finally {
    await server.close().catch(() => undefined);
  }
}

async function startHttpServer(): Promise<void> {
  const httpServer = createServer((req, res) => {
    handleHttpRequest(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : "MCP 服务处理失败";
      writeMcpError(res, status, message);
      if (!(error instanceof HttpError)) console.error("Submail MCP request failed", error);
    });
  });
  httpServer.requestTimeout = Math.max(apiTimeoutMs + 10_000, 130_000);
  httpServer.headersTimeout = 15_000;
  httpServer.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(httpPort, httpHost, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  console.error(`Submail MCP Streamable HTTP listening on http://${httpHost}:${httpPort}/mcp`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Submail MCP received ${signal}, shutting down`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => {
      httpServer.closeAllConnections();
      process.exit(1);
    }, 10_000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

async function startStdioServer(): Promise<void> {
  const apiKey = process.env.SUBMAIL_MCP_API_KEY?.trim();
  if (!apiKey) throw new Error("stdio 模式必须设置 SUBMAIL_MCP_API_KEY");
  const server = createSubmailServer(apiKey);
  await server.connect(new StdioServerTransport());
}

if (transportMode === "http" || transportMode === "streamable-http") {
  await startHttpServer();
} else if (transportMode === "stdio") {
  await startStdioServer();
} else {
  throw new Error(`不支持的 SUBMAIL_MCP_TRANSPORT: ${transportMode}`);
}
