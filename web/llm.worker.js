import { Wllama } from "./vendor/wllama/index.js?v=20260823-49";
import { RUNTIME_ASSETS } from "./runtime-assets.js?v=20260823-2";
import {
  buildRepairPrompt,
  buildSchemaChatPrompt,
  buildSystemPrompt,
  parseSchemaChatResponse,
  schemaChatAnswerDraft,
  schemaChatSqlDraft,
  validateProposal,
  validateReadQuery,
} from "./assistant-context.js?v=20260824-52";

const REPORT_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "folio_report_query",
    strict: true,
    schema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "One complete read-only PostgreSQL SELECT or WITH query that ends with a semicolon.",
        },
      },
      required: ["sql"],
      additionalProperties: false,
    },
  },
};

const MODEL = {
  repo: "unsloth/Qwen3.5-0.8B-GGUF",
  quant: "Q4_K_M",
};

let runtime = null;
let loading = null;
let backend = "cpu";
let gpuLayers = 0;
let gpuProbe = null;
let nativeLogs = [];
let activeGenerationController = null;
let runtimeStartedAt = 0;
let runtimePhase = "Starting WebAssembly";

self.addEventListener("message", async ({ data }) => {
  const { id, operation } = data;
  emitModelEvent("request", { id, operation });
  try {
    let result;
    if (operation === "cancel") {
      const cancelled = Boolean(activeGenerationController);
      activeGenerationController?.abort();
      result = { cancelled };
    } else if (operation === "load") {
      result = await loadModel();
    } else if (operation === "ask") {
      await loadModel();
      result = await complete([
        { role: "system", content: buildSystemPrompt(data.context) },
        { role: "user", content: data.question },
      ]);
    } else if (operation === "chat") {
      await loadModel();
      const history = Array.isArray(data.history)
        ? data.history.slice(-6).map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: String(message.content || "").slice(0, 1_200),
        }))
        : [];
      result = await completeSchemaChat([
        { role: "system", content: buildSchemaChatPrompt(data.context) },
        ...history,
        { role: "user", content: data.question },
      ], data.context);
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
    gpuProbe = await probeWebGPU();
    backend = gpuProbe.ready ? "webgpu" : "cpu";
    const safari = browserName(navigator.userAgent) === "Safari";
    gpuLayers = backend === "webgpu" ? 99 : 0;
    emitModelEvent("load-start", { model: MODEL, backend, gpuLayers, gpuProbe });
    self.postMessage({ type: "model-status", status: "starting", message: "Preparing the local model…" });
    let proof;
    try {
      proof = await startRuntime({ safari, reportProgress: true });
    } catch (error) {
      if (backend !== "webgpu") throw withNativeLog(error);
      emitModelEvent("gpu-runtime-retry", {
        message: error.message,
        firstAttemptLayers: gpuLayers,
        nativeLogs: recentNativeLogs(),
      }, "warn");
      self.postMessage({
        type: "model-status",
        status: "retrying-gpu",
        message: "Tuning the GPU runtime…",
      });
      await disposeRuntime();
      nativeLogs = [];
      gpuLayers = safari ? 6 : 12;
      try {
        proof = await startRuntime({ safari, reportProgress: false });
      } catch (retryError) {
        emitModelEvent("gpu-runtime-fallback", {
          message: retryError.message,
          retryLayers: gpuLayers,
          nativeLogs: recentNativeLogs(),
        }, "error");
        await disposeRuntime();
        backend = "cpu";
        gpuLayers = 0;
        nativeLogs = [];
        self.postMessage({
          type: "model-status",
          status: "fallback",
          message: "Starting the threaded CPU runtime…",
        });
        proof = await startRuntime({ safari, reportProgress: false }).catch((fallbackError) => {
          throw withNativeLog(fallbackError);
        });
      }
    }
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

async function startRuntime({ safari, reportProgress }) {
  runtime = createRuntime(backend);
  await loadIntoRuntime(runtime, {
    backend,
    gpuLayers,
    safari,
    reportProgress,
  });
  return warmModel();
}

async function disposeRuntime() {
  const previous = runtime;
  runtime = null;
  if (!previous) return;
  let exited = false;
  const exit = previous.exit().catch(() => {}).finally(() => { exited = true; });
  await Promise.race([
    exit,
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (!exited) previous.proxy?.worker?.terminate?.();
}

async function warmModel() {
  self.postMessage({ type: "model-warmup", elapsedMs: 0 });
  emitModelEvent("warmup-start", { prompt: "Hi", maxTokens: 64 });
  const response = await runtime.createChatCompletion({
    messages: [
      { role: "system", content: "Follow the user's output instruction exactly." },
      { role: "user", content: "Output exactly this one word: Hi" },
    ],
    chat_template_kwargs: { enable_thinking: false },
    max_tokens: 64,
    temperature: 0,
    seed: 42,
  });
  let reply = completionText(response);
  emitModelEvent("warmup-response", summarizeCompletion(response, reply));
  if (!isExpectedGreeting(reply)) {
    emitModelEvent("warmup-retry", {
      reply,
      reason: "The first reply missed the expected greeting.",
    }, "warn");
    const fallback = await runtime.createChatCompletion({
      messages: [{ role: "user", content: "Write only these two letters: Hi" }],
      chat_template_kwargs: { enable_thinking: false },
      max_tokens: 16,
      temperature: 0,
      seed: 42,
    });
    reply = completionText(fallback);
    emitModelEvent("warmup-fallback-response", summarizeCompletion(fallback, reply));
  }
  if (!isExpectedGreeting(reply)) {
    const error = new Error(`Warm-up replied “${reply.slice(0, 40) || "empty text"}” instead of “Hi.”`);
    error.output = reply;
    throw error;
  }
  return reply.slice(0, 40);
}

function isExpectedGreeting(reply) {
  return /^hi[.!]?$/i.test(reply.trim());
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
        RUNTIME_ASSETS.wllamaWasm,
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
      RUNTIME_ASSETS.wllamaCompatWasm,
    ).href,
    worker: new URL(
      cpu
        ? "./vendor/wllama/wllama-cpu-compat.js?v=20260823-1"
        : "./vendor/wllama/wllama-compat.js?v=20260823-1",
      import.meta.url,
    ).href,
  });
  return instance;
}

async function loadIntoRuntime(instance, {
  backend: selectedBackend,
  gpuLayers: selectedGpuLayers,
  safari,
  reportProgress,
}) {
  let downloadComplete = false;
  let runtimeHeartbeat = null;
  let runtimeTimeout = null;
  let rejectRuntimeTimeout;
  const runtimeDeadline = new Promise((_, reject) => {
    rejectRuntimeTimeout = reject;
  });
  const startRuntimeHeartbeat = () => {
    if (runtimeHeartbeat) return;
    runtimeStartedAt = performance.now();
    runtimePhase = "Starting WebAssembly";
    const send = () => self.postMessage({
      type: "model-runtime",
      phase: runtimePhase,
      elapsedMs: Math.round(performance.now() - runtimeStartedAt),
      backend: selectedBackend,
      gpuLayers: selectedGpuLayers,
    });
    send();
    runtimeHeartbeat = setInterval(send, 1_000);
    runtimeTimeout = setTimeout(() => {
      rejectRuntimeTimeout(new Error(
        "The inference runtime took longer than three minutes to start.",
      ));
    }, 180_000);
  };
  emitModelEvent("runtime-load-start", {
    backend: selectedBackend,
    gpuLayers: selectedGpuLayers,
    contextSize: safari ? 4_096 : 8_192,
    batchSize: safari ? 128 : 512,
    hardwareConcurrency: navigator.hardwareConcurrency || 1,
    crossOriginIsolated: self.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
  });
  const modelLoad = instance.loadModelFromUrl(RUNTIME_ASSETS.model, {
    n_ctx: safari ? 4_096 : 8_192,
    n_batch: safari ? 128 : 512,
    n_ubatch: safari ? 64 : 256,
    n_parallel: 1,
    n_gpu_layers: selectedGpuLayers,
    offload_kqv: selectedBackend === "webgpu",
    flash_attn: true,
    cache_type_k: "q8_0",
    cache_type_v: "q8_0",
    warmup: false,
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
        startRuntimeHeartbeat();
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
  try {
    await Promise.race([modelLoad, runtimeDeadline]);
  } finally {
    clearInterval(runtimeHeartbeat);
    clearTimeout(runtimeTimeout);
    runtimeStartedAt = 0;
  }
  const context = instance.getLoadedContextInfo();
  emitModelEvent("runtime-load-complete", {
    context,
    threads: instance.getNumThreads(),
    multithread: instance.isMultithread(),
    gpuLayers: selectedBackend === "webgpu"
      ? Math.min(selectedGpuLayers, context.n_layer)
      : 0,
    configuredGpuLayers: selectedGpuLayers,
  });
}

async function probeWebGPU() {
  if (!self.isSecureContext || !navigator.gpu) {
    return { ready: false, reason: "WebGPU API unavailable" };
  }
  let device;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return { ready: false, reason: "GPU adapter unavailable" };
    if (!adapter.features.has("shader-f16")) {
      return { ready: false, reason: "16-bit GPU shaders unavailable" };
    }
    device = await adapter.requestDevice({ requiredFeatures: ["shader-f16"] });
    device.pushErrorScope("validation");
    const module = device.createShaderModule({
      code: `enable f16;
        @compute @workgroup_size(1)
        fn main() { let value = f16(1.0); _ = value; }`,
    });
    await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const validationError = await device.popErrorScope();
    if (validationError) throw validationError;
    return {
      ready: true,
      maxBufferSize: Number(adapter.limits.maxBufferSize || 0),
      maxStorageBufferBindingSize: Number(adapter.limits.maxStorageBufferBindingSize || 0),
    };
  } catch (error) {
    return { ready: false, reason: error?.message || String(error) };
  } finally {
    device?.destroy();
  }
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
  updateRuntimePhase(message);
  nativeLogs.push({ level, message });
  nativeLogs = nativeLogs.slice(-30);
  self.postMessage({ type: "model-log", level, message, at: new Date().toISOString() });
}

function updateRuntimePhase(message) {
  if (!runtimeStartedAt) return;
  if (/Calling wllamaStart/i.test(message)) runtimePhase = "Starting llama.cpp";
  else if (/Loading model\.\.\.|loaded meta data/i.test(message)) runtimePhase = "Reading model metadata";
  else if (/load_tensors|model buffer size/i.test(message)) runtimePhase = "Loading model tensors";
  else if (/constructing llama_context|KV buffer size/i.test(message)) runtimePhase = "Creating the inference context";
  else if (/sched_reserve|compute buffer size/i.test(message)) runtimePhase = "Preparing inference buffers";
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
  const controller = new AbortController();
  activeGenerationController = controller;
  try {
    return await runCompletion(messages, controller.signal);
  } finally {
    if (activeGenerationController === controller) activeGenerationController = null;
  }
}

async function completeSchemaChat(messages, context) {
  const controller = new AbortController();
  activeGenerationController = controller;
  try {
    return await runSchemaChatCompletion(messages, context, controller.signal);
  } finally {
    if (activeGenerationController === controller) activeGenerationController = null;
  }
}

async function runSchemaChatCompletion(messages, context, abortSignal) {
  const maxTokens = outputTokenLimit() + 300;
  emitModelEvent("generation-start", {
    kind: "chat",
    messageCount: messages.length,
    promptCharacters: messages.reduce((total, message) => total + message.content.length, 0),
    maxTokens,
    contextSize: runtime.getLoadedContextInfo().n_ctx,
  });
  self.postMessage({ type: "model-status", status: "thinking", mode: "chat", message: "Thinking about the schema…" });
  const startedAt = performance.now();
  self.postMessage({ type: "model-chat", characters: 0, elapsedMs: 0, text: "" });
  const stream = await runtime.createChatCompletion({
    messages,
    chat_template_kwargs: { enable_thinking: false },
    response_format: REPORT_RESPONSE_FORMAT,
    abortSignal,
    max_tokens: maxTokens,
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
    if (now - lastUpdate >= 160) {
      lastUpdate = now;
      self.postMessage({
        type: "model-chat",
        characters: content.length,
        elapsedMs: Math.round(now - startedAt),
        text: schemaChatAnswerDraft(content),
        sql: schemaChatSqlDraft(content),
      });
    }
    if (/<folio[-_]query>/i.test(content) || content.trimEnd().endsWith("}")) {
      try {
        parseSchemaChatResponse(content, context?.tables || []);
        break;
      } catch {
        // Continue until the first complete report query is usable.
      }
    }
  }
  let proposal;
  try {
    proposal = parseSchemaChatResponse(content, context?.tables || []);
  } catch (error) {
    error.output = content;
    throw error;
  }
  self.postMessage({
    type: "model-chat",
    characters: content.length,
    elapsedMs: Math.round(performance.now() - startedAt),
    text: proposal.answer,
    sql: proposal.sql,
  });
  emitModelEvent("generation-complete", {
    kind: "chat",
    outputCharacters: content.length,
    sqlCharacters: proposal.sql.length,
    usage,
  });
  self.postMessage({
    type: "model-status",
    status: "ready",
    message: "Local model ready",
    ...modelInfo(),
  });
  return { proposal, usage };
}

async function runCompletion(messages, abortSignal) {
  emitModelEvent("generation-start", {
    kind: "sql",
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
    chat_template_kwargs: { enable_thinking: false },
    response_format: REPORT_RESPONSE_FORMAT,
    abortSignal,
    max_tokens: outputTokenLimit(),
    temperature: 0.1,
    top_p: 0.9,
    seed: 42,
    stream: true,
  });
  let content = "";
  let usage = null;
  let lastUpdate = 0;
  let stoppedAtCompleteSql = false;
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
    const completeSql = extractPartialJsonString(content, "sql") || extractSqlDraft(content);
    if (completeSql.endsWith(";") && content.trimEnd().endsWith("}")) {
      try {
        validateReadQuery(completeSql);
        stoppedAtCompleteSql = true;
        break;
      } catch {
        // Keep reading until the model completes a usable report query.
      }
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
    kind: "sql",
    outputCharacters: content.length,
    usage,
    sqlCharacters: proposal.sql.length,
    stoppedAtCompleteSql,
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
  let jsonError;
  for (const candidate of jsonCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate);
      return validateProposal({
        sql: parsed.sql,
        answer: parsed.answer || parsed.summary || "Folio wrote the report query below.",
        tables: Array.isArray(parsed.tables) ? parsed.tables : [],
        assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      });
    } catch (error) {
      jsonError = error;
    }
  }
  const sql = extractSqlDraft(content) || extractPartialJsonString(content, "sql");
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

function jsonCandidates(content) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i)?.[1]?.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  const object = firstBrace >= 0 && lastBrace > firstBrace
    ? trimmed.slice(firstBrace, lastBrace + 1)
    : "";
  return [...new Set([trimmed, fenced, object].filter(Boolean))];
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
  return runtime.getLoadedContextInfo().n_ctx >= 8_192 ? 1_400 : 1_200;
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
    gpuLayers: backend === "webgpu" ? Math.min(gpuLayers, context.n_layer) : 0,
    configuredGpuLayers: gpuLayers,
    gpuProbe,
  };
}
