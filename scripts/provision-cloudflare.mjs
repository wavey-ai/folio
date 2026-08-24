import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const config = resolve(root, "wrangler.jsonc");
const cors = resolve(root, "cloudflare/r2-cors.json");
const bucket = "folio-public-assets";
const domain = "assets.folio.wavey.ai";
const zoneId = "02ee0e316263ae94c16ae24e3089a04e";

if (!await succeeds(["r2", "bucket", "info", bucket])) {
  await run(["r2", "bucket", "create", bucket, "--location", "weur"]);
}
await run(["r2", "bucket", "cors", "set", bucket, "--file", cors, "--force"]);
const domains = await capture(["r2", "bucket", "domain", "list", bucket]);
if (!domains.includes(domain)) {
  await run([
    "r2", "bucket", "domain", "add", bucket,
    "--domain", domain,
    "--zone-id", zoneId,
    "--min-tls", "1.2",
    "--force",
  ]);
}

async function succeeds(args) {
  try {
    await capture(args);
    return true;
  } catch {
    return false;
  }
}

function run(args) {
  return command(args, "inherit");
}

function capture(args) {
  return command(args, "pipe");
}

function command(args, stdio) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "npx",
      ["--yes", "wrangler", ...args, "--config", config],
      { cwd: root, stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    if (stdio !== "inherit") {
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(`wrangler ${args.join(" ")} exited with ${code}`));
    });
  });
}
