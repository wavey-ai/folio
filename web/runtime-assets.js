const PUBLIC_ORIGIN = "https://assets.folio.wavey.ai";
const hostname = globalThis.location?.hostname || "";
const usePublicAssets = hostname === "folio.wavey.ai"
  || hostname.endsWith(".folio-studio.workers.dev");

function asset(publicPath, localPath) {
  return usePublicAssets
    ? `${PUBLIC_ORIGIN}/${publicPath}`
    : new URL(localPath, import.meta.url).href;
}

export const RUNTIME_ASSETS = Object.freeze({
  json2leafWasm: asset(
    "wasm/json2leaf/5b9d68473210d6e9/json2leaf_bg.wasm",
    "./pkg/json2leaf_bg.wasm?v=20260823-6",
  ),
  pgrustBase: asset(
    "runtime/pgrust/6e7bd0c5eb271606/",
    "./vendor/pgrust/assets/",
  ),
  wllamaWasm: asset(
    "runtime/wllama/a780cb441ff45296/wllama.wasm",
    "./vendor/wllama/wllama.wasm",
  ),
  wllamaCompatWasm: asset(
    "runtime/wllama/a780cb441ff45296/wllama-compat.wasm",
    "./vendor/wllama/wllama-compat.wasm",
  ),
  model: asset(
    "models/qwen3.5-0.8b/bd258782e35f7f45/Qwen3.5-0.8B-Q4_K_M.gguf",
    "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf",
  ),
  discogsSample: asset(
    "samples/discogs/599a35a0845f6a98/discogs-releases.xml",
    "./samples/discogs-releases.xml",
  ),
});
