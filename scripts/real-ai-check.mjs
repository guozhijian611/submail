import process from "node:process";

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  for (const field of ["endpoint", "apiKey", "model"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`缺少 ${field}`);
  }
  return value;
}

function safeError(error, apiKey) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(apiKey, "[REDACTED]").slice(0, 1000);
}

function completionUrl(endpoint) {
  const normalized = endpoint.trim().replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

const input = await readInput();
const result = { direct: { ok: false }, project: { ok: false }, persisted: false };

try {
  const response = await fetch(completionUrl(input.endpoint), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0,
      max_tokens: 32,
      messages: [
        { role: "system", content: "这是接口连接测试。" },
        { role: "user", content: "只回复：连接成功" }
      ]
    }),
    signal: AbortSignal.timeout(60_000)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 600)}`);
  const payload = JSON.parse(raw);
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("响应中没有有效文本");
  result.direct = { ok: true, response: content.trim().slice(0, 200) };
} catch (error) {
  result.direct = { ok: false, error: safeError(error, input.apiKey) };
}

if (result.direct.ok && input.persist) {
  try {
    const { aiService, integrationSettingsRepo } = await import("../apps/api/src/integrations.ts");
    const settings = integrationSettingsRepo.updateAi({
      enabled: true,
      baseUrl: input.endpoint,
      model: input.model,
      temperature: 0.3,
      systemPrompt: "优先帮助用户快速、专业地理解和处理邮件；保留必要的日期、金额、姓名和行动项。",
      apiKey: input.apiKey
    });
    result.persisted = settings.api_key_configured;
    const response = await aiService.test();
    result.project = { ok: true, response: response.slice(0, 200) };
  } catch (error) {
    result.project = { ok: false, error: safeError(error, input.apiKey) };
  }
}

if (!result.direct.ok) {
  try {
    const modelsUrl = new URL(completionUrl(input.endpoint));
    modelsUrl.pathname = modelsUrl.pathname.replace(/\/chat\/completions$/, "/models");
    const response = await fetch(modelsUrl, {
      headers: { authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(30_000)
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300)}`);
    const payload = JSON.parse(raw);
    result.availableModels = Array.isArray(payload?.data)
      ? payload.data.map((item) => item?.id).filter((id) => typeof id === "string").slice(0, 100)
      : [];
  } catch (error) {
    result.modelsError = safeError(error, input.apiKey);
  }
}

process.stdout.write(`${JSON.stringify(result)}\n`);
