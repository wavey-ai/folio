import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const source = resolve(root, "web");
const target = resolve(root, "build/cloudflare/app");
const buildRoot = resolve(root, "build/cloudflare");

if (target !== buildRoot && !target.startsWith(`${buildRoot}${sep}`)) {
  throw new Error(`Refusing to replace unexpected path: ${target}`);
}

const excludedFiles = new Set([
  "package.json",
  "package-lock.json",
  "node-worker-harness.mjs",
  "postgres.integration.test.mjs",
  "workers.integration.test.mjs",
]);
const excludedRuntimeFiles = new Set([
  resolve(source, "pkg/json2leaf_bg.wasm"),
  resolve(source, "samples/discogs-releases.xml"),
  resolve(source, "vendor/wllama/wllama.wasm"),
  resolve(source, "vendor/wllama/wllama-cpu.wasm"),
  resolve(source, "vendor/wllama/wllama-compat.wasm"),
  resolve(source, "vendor/wllama/wllama-cpu-compat.wasm"),
]);

for (const filename of ["wllama-compat.js", "wllama-cpu-compat.js"]) {
  const path = resolve(source, "vendor/wllama", filename);
  const [{ size }, code] = await Promise.all([
    stat(path),
    readFile(path, "utf8"),
  ]);
  if (size < 100_000 || !code.includes("var Module")) {
    throw new Error(`${filename} must contain the complete wllama compatibility worker.`);
  }
}

await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
await cp(source, target, {
  recursive: true,
  filter(path) {
    const absolute = resolve(path);
    if (absolute === resolve(source, "node_modules")) return false;
    if (absolute === resolve(source, "vendor/pgrust/assets")) return false;
    if (excludedRuntimeFiles.has(absolute)) return false;
    if (excludedFiles.has(basename(absolute))) return false;
    if (/\.test\.mjs$/.test(absolute)) return false;
    return true;
  },
});

process.stdout.write(`Built Cloudflare app assets at ${target}\n`);
