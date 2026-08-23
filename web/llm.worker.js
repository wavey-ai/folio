import { Wllama } from "./vendor/wllama/index.js?v=20260823-16";
import {
  QUERY_RESPONSE_SCHEMA,
  buildRepairPrompt,
  buildSystemPrompt,
  validateProposal,
} from "./assistant-context.js?v=20260823-19";

const MODEL = {
  repo: "LiquidAI/LFM2.5-230M-GGUF",
  quant: "Q4_K_M",
};

let runtime = null;
let loading = null;
let backend = "cpu";
let nativeLogs = [];

self.addEventListener("message", async ({ data }) => {
  const { id, operation } = data;
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
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
});

async function loadModel() {
  if (runtime?.isModelLoaded()) return modelInfo();
  if (loading) return loading;

  loading = (async () => {
    self.postMessage({ type: "model-status", status: "starting", message: "Preparing the local model…" });
    const safari = browserName(navigator.userAgent) === "Safari";
    backend = "cpu";
    runtime = createRuntime(backend);
    await loadIntoRuntime(runtime, { backend, safari, reportProgress: true }).catch((error) => {
      throw withNativeLog(error);
    });
    const proof = await warmModel();
    const info = modelInfo();
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
  const response = await runtime.createChatCompletion({
    messages: [
      { role: "system", content: "Reply with exactly: Hi" },
      { role: "user", content: "Hi" },
    ],
    max_tokens: 8,
    temperature: 0,
    seed: 42,
  });
  const reply = response.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error("The local model returned an empty warm-up response.");
  return reply.slice(0, 40);
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
  if (level === "warn" || level === "error") {
    self.postMessage({ type: "model-log", level, message });
  }
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
        sql: extractPartialJsonString(content, "sql"),
      });
    }
  }
  self.postMessage({
    type: "model-generation",
    characters: content.length,
    elapsedMs: Math.round(performance.now() - startedAt),
    sql: extractPartialJsonString(content, "sql"),
  });
  const proposal = validateProposal(JSON.parse(content));
  self.postMessage({
    type: "model-status",
    status: "ready",
    message: "Local model ready",
    ...modelInfo(),
  });
  return { proposal, usage };
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
    model: "LFM2.5-230M Q4_K_M",
    contextSize: context.n_ctx,
    backend,
    webgpu: backend === "webgpu",
  };
}
