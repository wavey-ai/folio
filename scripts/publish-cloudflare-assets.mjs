import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const config = resolve(root, "wrangler.jsonc");
const bucket = "folio-public-assets";
const publicOrigin = "https://assets.folio.wavey.ai";
const modelPath = resolve(root, "build/runtime-assets/Qwen3.5-0.8B-Q4_K_M.gguf");
const modelSource = "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf";

const assets = [
  asset(
    "wasm/json2leaf/5b9d68473210d6e9/json2leaf_bg.wasm",
    "web/pkg/json2leaf_bg.wasm",
    "application/wasm",
    285_670,
    "5b9d68473210d6e9bc30e4e97b8319b7e74c0c2d1fc9d633d30e2e95d1ecfc02",
  ),
  asset(
    "runtime/pgrust/6e7bd0c5eb271606/postgres.wasm",
    "web/vendor/pgrust/assets/postgres.wasm",
    "application/wasm",
    46_095_142,
    "cd150099ad691ad790f3950544d78d461effb45b293aac97def408dc3900a909",
  ),
  asset(
    "runtime/pgrust/6e7bd0c5eb271606/vfs.img",
    "web/vendor/pgrust/assets/vfs.img",
    "application/octet-stream",
    41_322_501,
    "929db4e04156be087447543abd9e6a199dd9900537fd78067bf2bbecea161952",
  ),
  asset(
    "runtime/pgrust/6e7bd0c5eb271606/vfs.json",
    "web/vendor/pgrust/assets/vfs.json",
    "application/json",
    148_812,
    "96759f3e02249d5b9c197b951062f0ae7c8f252210442247d1e7d3f291e3eed0",
  ),
  asset(
    "runtime/wllama/a780cb441ff45296/wllama.wasm",
    "web/vendor/wllama/wllama.wasm",
    "application/wasm",
    8_524_865,
    "95c6ff9ef2a03ff2c63bc91db132f0126a0bd0456b272cd8ae2e0f592fb059f6",
  ),
  asset(
    "runtime/wllama/a780cb441ff45296/wllama-compat.wasm",
    "web/vendor/wllama/wllama-compat.wasm",
    "application/wasm",
    16_004_953,
    "cd35acc54e56e6b03ec8b82e6629049c6b4e541151f5eba37f3efcbc093d13b4",
  ),
  asset(
    "samples/discogs/599a35a0845f6a98/discogs-releases.xml",
    "web/samples/discogs-releases.xml",
    "application/xml",
    31_459_356,
    "599a35a0845f6a9809799b67bc8894118172564ea3f3c8c4c4edb3c25c196e56",
  ),
  {
    key: "models/qwen3.5-0.8b/bd258782e35f7f45/Qwen3.5-0.8B-Q4_K_M.gguf",
    path: modelPath,
    contentType: "application/octet-stream",
    size: 532_517_120,
    sha256: "bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517",
  },
];

await ensureModel();
for (const item of assets) {
  await verify(item);
  if (await isPublished(item)) {
    process.stdout.write(`Already published: ${item.key}\n`);
    continue;
  }
  await run([
    "r2", "object", "put", `${bucket}/${item.key}`,
    "--file", item.path,
    "--content-type", item.contentType,
    "--cache-control", "public, max-age=31536000, immutable",
    "--remote",
  ]);
}

function asset(key, relativePath, contentType, size, sha256) {
  return { key, path: resolve(root, relativePath), contentType, size, sha256 };
}

async function ensureModel() {
  let currentSize = 0;
  try {
    currentSize = (await stat(modelPath)).size;
  } catch {}
  if (currentSize === 532_517_120) {
    const currentHash = await sha256(modelPath);
    if (currentHash === assets.at(-1).sha256) return;
    await rm(modelPath, { force: true });
    currentSize = 0;
  }
  await mkdir(dirname(modelPath), { recursive: true });
  const args = ["--fail", "--location", "--retry", "3", "--output", modelPath];
  if (currentSize > 0 && currentSize < 532_517_120) args.push("--continue-at", "-");
  args.push(modelSource);
  await command("curl", args);
}

async function verify(item) {
  const info = await stat(item.path);
  if (info.size !== item.size) {
    throw new Error(`${item.path} has ${info.size} bytes; expected ${item.size}`);
  }
  const digest = await sha256(item.path);
  if (digest !== item.sha256) {
    throw new Error(`${item.path} SHA-256 is ${digest}; expected ${item.sha256}`);
  }
}

async function isPublished(item) {
  try {
    const response = await fetch(`${publicOrigin}/${item.key}`, { method: "HEAD" });
    return response.ok && Number(response.headers.get("content-length")) === item.size;
  } catch {
    return false;
  }
}

function sha256(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function run(args) {
  return command("npx", ["--yes", "wrangler", ...args, "--config", config]);
}

function command(executable, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${executable} ${args[0]} exited with ${code}`));
    });
  });
}
