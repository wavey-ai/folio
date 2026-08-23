import { Wllama } from "./vendor/wllama/index.js";
import {
  QUERY_RESPONSE_SCHEMA,
  buildRepairPrompt,
  buildSystemPrompt,
  validateProposal,
} from "./assistant-context.js";

const MODEL = {
  repo: "unsloth/Qwen3.5-0.8B-GGUF",
  quant: "Q4_K_M",
};

let runtime = null;
let loading = null;

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
    runtime = new Wllama(
      { default: new URL("./vendor/wllama/wllama.wasm", import.meta.url).href },
      {
        parallelDownloads: 3,
        logger: {
          debug() {},
          log() {},
          warn: (...values) => self.postMessage({
            type: "model-log",
            level: "warn",
            message: values.map(String).join(" "),
          }),
          error: (...values) => self.postMessage({
            type: "model-log",
            level: "error",
            message: values.map(String).join(" "),
          }),
        },
      },
    );
    const webgpu = runtime.isSupportWebGPU();
    await runtime.loadModelFromHF(MODEL, {
      n_ctx: 8_192,
      n_batch: 256,
      n_gpu_layers: webgpu ? 99 : 0,
      cache_type_k: "q8_0",
      cache_type_v: "q8_0",
      useCache: true,
      progressCallback: ({ loaded, total }) => {
        self.postMessage({
          type: "model-progress",
          loaded,
          total,
          percent: total ? Math.round((loaded / total) * 100) : 0,
        });
      },
    });
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
    chat_template_kwargs: { enable_thinking: false },
  });
  const content = response.choices[0]?.message?.content || "";
  const proposal = validateProposal(JSON.parse(content));
  self.postMessage({ type: "model-status", status: "ready", message: "Local model ready" });
  return { proposal, usage: response.usage };
}

function modelInfo() {
  const context = runtime.getLoadedContextInfo();
  return {
    model: "Qwen3.5-0.8B Q4_K_M",
    contextSize: context.n_ctx,
    webgpu: runtime.isSupportWebGPU(),
  };
}
