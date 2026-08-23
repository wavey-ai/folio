import { Wllama } from "./vendor/wllama/index.js?v=20260823-16";
import {
  QUERY_RESPONSE_SCHEMA,
  buildRepairPrompt,
  buildSystemPrompt,
  validateProposal,
} from "./assistant-context.js?v=20260823-21";

const MODEL = {
  repo: "unsloth/Qwen3.5-0.8B-GGUF",
  quant: "Q4_K_M",
};

let runtime = null;
let loading = null;
let backend = "cpu";
let nativeLogs = [];

self.addEventListener("message", async ({ data }) => {
  const { id, operation } = data;
  emitModelEvent("request", { id, operation });
  try {
    let result;
    if (operation === "load") {
      result = await loadModel();
    } else if (operation === "ask") {
      await loadModel();
      result = await complete([
        { role: "system", content: buildSystemPrompt(data.context) },
        { role: "user", content: data.question },
      ]);
    } else if (operation === "repair") {
      await loadModel();
      result = await complete([
        { role: "system", content: buildSystemPrompt(data.context) },
        {
          role: "user",
          content: buildRepairPrompt({
            question: data.question,
            proposal: data.proposal,
            error: data.error,
            context: data.context,
          }),
        },
      ]);
    } else {
      throw new Error(`Unknown language model operation: ${operation}`);
    }
    emitModelEvent("request-complete", { id, operation });
    self.postMessage({ id, result });
  } catch (error) {
    emitModelEvent("request-error", {
      id,
      operation,
      message: error.message,
      nativeLogs: recentNativeLogs(),
    }, "error");
    self.postMessage({ id, error: error.message, output: error.output || "" });
  }
});

async function loadModel() {
  if (runtime?.isModelLoaded()) return modelInfo();
  if (loading) return loading;

  loading = (async () => {
    emitModelEvent("load-start", { model: MODEL, backend });
    self.postMessage({ type: "model-status", status: "starting", message: "Preparing the local model…" });
    const safari = browserName(navigator.userAgent) === "Safari";
    backend = "cpu";
    runtime = createRuntime(backend);
    await loadIntoRuntime(runtime, { backend, safari, reportProgress: true }).catch((error) => {
      throw withNativeLog(error);
    });
    const proof = await warmModel();
    const info = modelInfo();
    emitModelEvent("load-ready", { ...info, proof });
    self.postMessage({
      type: "model-status",
      status: "ready",
      message: "Local model ready",
      proof,
      ...info,
    });
    return { ...info, proof };
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

async function warmModel() {
  self.postMessage({ type: "model-warmup", elapsedMs: 0 });
  emitModelEvent("warmup-start", { prompt: "Hi", maxTokens: 64 });
  const response = await runtime.createChatCompletion({
    messages: [
      { role: "system", content: "Reply with exactly: Hi /no_think" },
      { role: "user", content: "Hi /no_think" },
    ],
    chat_template_kwargs: { enable_thinking: false },
    max_tokens: 64,
    temperature: 0,
    seed: 42,
  });
  let reply = completionText(response);
  emitModelEvent("warmup-response", summarizeCompletion(response, reply));
  if (!reply) {
    emitModelEvent("warmup-retry", { reason: "Chat completion produced empty text." }, "warn");
    const fallback = await runtime.createCompletion({
      prompt: "Reply with exactly: Hi\nResponse:",
      max_tokens: 16,
      temperature: 0,
      seed: 42,
    });
    reply = completionText(fallback);
    emitModelEvent("warmup-fallback-response", summarizeCompletion(fallback, reply));
  }
  if (!reply) throw new Error("Warm-up produced empty text. See [Folio model] events in the console.");
  return reply.slice(0, 40);
}

function completionText(response) {
  const choice = response?.choices?.[0];
  const candidates = [
    choice?.message?.content,
    choice?.message?.reasoning_content,
    choice?.text,
  ];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function summarizeCompletion(response, reply) {
  const choice = response?.choices?.[0] || {};
  return {
    finishReason: choice.finish_reason || null,
    contentLength: choice.message?.content?.length || 0,
    reasoningLength: choice.message?.reasoning_content?.length || 0,
    textLength: choice.text?.length || 0,
    reply: reply.slice(0, 160),
    usage: response?.usage || null,
  };
}

function createRuntime(selectedBackend) {
  const cpu = selectedBackend === "cpu";
  const instance = new Wllama(
    {
      default: new URL(
        cpu ? "./vendor/wllama/wllama-cpu.wasm" : "./vendor/wllama/wllama.wasm",
        import.meta.url,
      ).href,
    },
    {
      parallelDownloads: 3,
      logger: {
        debug: (...values) => recordNativeLog("debug", values),
        log: (...values) => recordNativeLog("log", values),
        warn: (...values) => recordNativeLog("warn", values),
        error: (...values) => recordNativeLog("error", values),
      },
    },
  );
  instance.setCompat({
    wasm: new URL(
      cpu ? "./vendor/wllama/wllama-cpu-compat.wasm" : "./vendor/wllama/wllama-compat.wasm",
      import.meta.url,
    ).href,
    worker: new URL(
      cpu ? "./vendor/wllama/wllama-cpu-compat.js" : "./vendor/wllama/wllama-compat.js",
      import.meta.url,
    ).href,
  });
  return instance;
}

async function loadIntoRuntime(instance, { backend: selectedBackend, safari, reportProgress }) {
  let downloadComplete = false;
  emitModelEvent("runtime-load-start", {
    backend: selectedBackend,
    contextSize: safari ? 4_096 : 8_192,
    batchSize: safari ? 128 : 256,
    hardwareConcurrency: navigator.hardwareConcurrency || 1,
    crossOriginIsolated: self.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
  });
  await instance.loadModelFromHF(MODEL, {
    n_ctx: safari ? 4_096 : 8_192,
    n_batch: safari ? 128 : 256,
    n_gpu_layers: selectedBackend === "webgpu" ? 99 : 0,
    cache_type_k: "q8_0",
    cache_type_v: "q8_0",
    useCache: true,
    progressCallback: ({ loaded, total }) => {
      const loadedBytes = Number(loaded);
      const totalBytes = Number(total);
      if (reportProgress) {
        self.postMessage({
          type: "model-progress",
          loaded: loadedBytes,
          total: totalBytes,
          percent: totalBytes ? Math.round((loadedBytes / totalBytes) * 100) : 0,
        });
      }
      if (!downloadComplete && totalBytes > 0 && loadedBytes >= totalBytes) {
        downloadComplete = true;
        emitModelEvent("download-complete", { loadedBytes, totalBytes });
        if (reportProgress) {
          self.postMessage({
            type: "model-status",
            status: "loading",
            message: "Starting the local model…",
          });
        }
      }
    },
  });
  emitModelEvent("runtime-load-complete", {
    context: instance.getLoadedContextInfo(),
    threads: instance.getNumThreads(),
    multithread: instance.isMultithread(),
  });
}

function browserName(userAgent) {
  if (/Edg\//i.test(userAgent)) return "Edge";
  if (/(Chrome|Chromium|CriOS)\//i.test(userAgent)) return "Chrome";
  if (/Firefox\//i.test(userAgent)) return "Firefox";
  if (/Safari\//i.test(userAgent)) return "Safari";
  return "This browser";
}

function recordNativeLog(level, values) {
  const message = values.map(formatLogValue).join(" ").trim();
  if (!message) return;
  nativeLogs.push({ level, message });
  nativeLogs = nativeLogs.slice(-30);
  self.postMessage({ type: "model-log", level, message, at: new Date().toISOString() });
}

function recentNativeLogs() {
  return nativeLogs.slice(-10);
}

function emitModelEvent(event, details = {}, level = "info") {
  self.postMessage({
    type: "model-event",
    event,
    level,
    at: new Date().toISOString(),
    details,
  });
}

function formatLogValue(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === "object" && value !== null) {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function withNativeLog(error) {
  const detail = nativeLogs
    .filter(({ level }) => level === "warn" || level === "error")
    .slice(-3)
    .map(({ message }) => message)
    .join(" · ");
  const message = error?.message || String(error);
  return new Error(detail && !message.includes(detail) ? `${message} · ${detail}` : message);
}

async function complete(messages) {
  emitModelEvent("generation-start", {
    messageCount: messages.length,
    promptCharacters: messages.reduce((total, message) => total + message.content.length, 0),
    maxTokens: outputTokenLimit(),
    contextSize: runtime.getLoadedContextInfo().n_ctx,
  });
  self.postMessage({ type: "model-status", status: "thinking", message: "Writing PostgreSQL…" });
  const startedAt = performance.now();
  self.postMessage({ type: "model-generation", characters: 0, elapsedMs: 0, sql: "" });
  const stream = await runtime.createChatCompletion({
    messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "folio_query",
        strict: true,
        schema: QUERY_RESPONSE_SCHEMA,
      },
    },
    max_tokens: outputTokenLimit(),
    temperature: 0.1,
    top_p: 0.9,
    seed: 42,
    stream: true,
  });
  let content = "";
  let usage = null;
  let lastUpdate = 0;
  for await (const chunk of stream) {
    usage = chunk.usage || usage;
    const delta = chunk.choices?.[0]?.delta?.content || "";
    if (!delta) continue;
    content += delta;
    const now = performance.now();
    if (now - lastUpdate >= 200) {
      lastUpdate = now;
      self.postMessage({
        type: "model-generation",
        characters: content.length,
        elapsedMs: Math.round(now - startedAt),
        sql: extractPartialJsonString(content, "sql") || extractSqlDraft(content),
        raw: content,
      });
    }
  }
  self.postMessage({
    type: "model-generation",
    characters: content.length,
    elapsedMs: Math.round(performance.now() - startedAt),
    sql: extractPartialJsonString(content, "sql") || extractSqlDraft(content),
    raw: content,
  });
  const proposal = parseModelProposal(content);
  emitModelEvent("generation-complete", {
    outputCharacters: content.length,
    usage,
    sqlCharacters: proposal.sql.length,
  });
  self.postMessage({
    type: "model-status",
    status: "ready",
    message: "Local model ready",
    ...modelInfo(),
  });
  return { proposal, usage };
}

function parseModelProposal(content) {
  try {
    return validateProposal(JSON.parse(content));
  } catch (jsonError) {
    const sql = extractSqlDraft(content);
    if (sql) {
      return validateProposal({
        sql,
        answer: "Folio generated this PostgreSQL report.",
        tables: [],
        assumptions: ["The local model returned PostgreSQL directly."],
      });
    }
    const error = new Error("The local model returned a response that Folio could not turn into PostgreSQL.");
    error.output = content;
    error.cause = jsonError;
    throw error;
  }
}

function extractSqlDraft(content) {
  const fenced = content.match(/```(?:postgresql|sql)?\s*([\s\S]*?)(?:```|$)/i);
  const source = fenced?.[1] || content;
  const start = source.search(/\b(?:select|with)\b/i);
  if (start < 0) return "";
  const candidate = source.slice(start).trim();
  const lastStatement = candidate.lastIndexOf(";");
  return lastStatement >= 0 ? candidate.slice(0, lastStatement + 1) : candidate;
}

function outputTokenLimit() {
  return runtime.getLoadedContextInfo().n_ctx >= 8_192 ? 2_400 : 1_600;
}

function extractPartialJsonString(json, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!match) return "";
  let output = "";
  for (let index = match.index + match[0].length; index < json.length; index += 1) {
    const character = json[index];
    if (character === '"') break;
    if (character !== "\\") {
      output += character;
      continue;
    }
    const escaped = json[++index];
    if (escaped === undefined) break;
    if (escaped === "n") output += "\n";
    else if (escaped === "r") output += "\r";
    else if (escaped === "t") output += "\t";
    else if (escaped === "b") output += "\b";
    else if (escaped === "f") output += "\f";
    else if (escaped === "u") {
      const code = json.slice(index + 1, index + 5);
      if (!/^[0-9a-f]{4}$/i.test(code)) break;
      output += String.fromCharCode(Number.parseInt(code, 16));
      index += 4;
    } else output += escaped;
  }
  return output;
}

function modelInfo() {
  const context = runtime.getLoadedContextInfo();
  return {
    model: "Qwen3.5-0.8B Q4_K_M",
    contextSize: context.n_ctx,
    backend,
    webgpu: backend === "webgpu",
    threads: runtime.getNumThreads(),
    multithread: runtime.isMultithread(),
  };
}
