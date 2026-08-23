import { Wllama } from "./vendor/wllama/index.js?v=20260823-15";
import {
  QUERY_RESPONSE_SCHEMA,
  buildRepairPrompt,
  buildSystemPrompt,
  validateProposal,
} from "./assistant-context.js";

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
    const webgpu = await canUseWebGPU();
    const browser = browserName(navigator.userAgent);
    const safari = browser === "Safari";
    backend = webgpu ? "webgpu" : "cpu";
    runtime = createRuntime(backend);
    try {
      await loadIntoRuntime(runtime, { backend, safari, reportProgress: true });
    } catch (error) {
      if (backend !== "webgpu" || !isBackendAbort(error)) throw withNativeLog(error);
      backend = "cpu";
      self.postMessage({
        type: "model-status",
        status: "fallback",
        message: `${browser} stopped the WebGPU runtime during startup. Folio switched to the CPU runtime.`,
      });
      nativeLogs = [];
      runtime = createRuntime(backend);
      await loadIntoRuntime(runtime, { backend, safari, reportProgress: false }).catch((fallbackError) => {
        throw withNativeLog(fallbackError);
      });
    }
    const info = modelInfo();
    self.postMessage({ type: "model-status", status: "ready", message: "Local model ready", ...info });
    return info;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
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

async function canUseWebGPU() {
  if (!self.isSecureContext || !navigator.gpu) return false;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }).catch(() => null);
  return Boolean(adapter?.features.has("shader-f16"));
}

function browserName(userAgent) {
  if (/Edg\//i.test(userAgent)) return "Edge";
  if (/(Chrome|Chromium|CriOS)\//i.test(userAgent)) return "Chrome";
  if (/Firefox\//i.test(userAgent)) return "Firefox";
  if (/Safari\//i.test(userAgent)) return "Safari";
  return "This browser";
}

function isBackendAbort(error) {
  return /abort|llama\.cpp|runtimeerror/i.test(`${error?.message || error}`);
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
  const response = await runtime.createChatCompletion({
    messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "folio_query",
        strict: true,
        schema: QUERY_RESPONSE_SCHEMA,
      },
    },
    max_tokens: 1_200,
    temperature: 0.1,
    top_p: 0.9,
    seed: 42,
  });
  const content = response.choices[0]?.message?.content || "";
  const proposal = validateProposal(JSON.parse(content));
  self.postMessage({
    type: "model-status",
    status: "ready",
    message: "Local model ready",
    ...modelInfo(),
  });
  return { proposal, usage: response.usage };
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
