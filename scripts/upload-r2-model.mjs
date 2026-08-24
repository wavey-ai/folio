import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const accountId = "c57bb20727aa3564966d2bb693abddce";
const bucket = "folio-public-assets";
const key = "models/qwen3.5-0.8b/bd258782e35f7f45/Qwen3.5-0.8B-Q4_K_M.gguf";
const modelPath = resolve(root, "build/runtime-assets/Qwen3.5-0.8B-Q4_K_M.gguf");
const publicUrl = `https://assets.folio.wavey.ai/${key}`;
const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
const expectedSize = 532_517_120;
const expectedSha256 = "bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517";

await verifyLocalModel();
if (await publicObjectMatches()) {
  process.stdout.write("The Folio model is already published and verified.\n");
  process.exit(0);
}

const auth = await cloudflareAuth();
const permissionGroups = await cloudflare(
  `/accounts/${accountId}/tokens/permission_groups`,
  { auth },
);
const requiredPermissions = [
  findPermission(permissionGroups, "Workers R2 Storage Bucket Item Read"),
  findPermission(permissionGroups, "Workers R2 Storage Bucket Item Write"),
];
const token = await cloudflare(`/accounts/${accountId}/tokens`, {
  auth,
  method: "POST",
  body: {
    name: `Folio model upload ${new Date().toISOString()}`,
    expires_on: new Date(Date.now() + 60 * 60 * 1_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
    policies: [{
      effect: "allow",
      resources: {
        [`com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`]: "*",
      },
      permission_groups: requiredPermissions.map(({ id }) => ({ id })),
    }],
  },
});

if (!token.id || !token.value) throw new Error("Cloudflare did not return the upload credential.");
const awsEnvironment = {
  ...process.env,
  AWS_ACCESS_KEY_ID: token.id,
  AWS_SECRET_ACCESS_KEY: createHash("sha256").update(token.value).digest("hex"),
  AWS_DEFAULT_REGION: "auto",
  AWS_REGION: "auto",
  AWS_EC2_METADATA_DISABLED: "true",
  AWS_PAGER: "",
};
delete awsEnvironment.CLOUDFLARE_API_KEY;
delete awsEnvironment.CLOUDFLARE_EMAIL;
delete awsEnvironment.CLOUDFLARE_API_TOKEN;

try {
  process.stdout.write("Uploading the Folio model with multipart transfer…\n");
  await command("aws", [
    "s3", "cp", modelPath, `s3://${bucket}/${key}`,
    "--endpoint-url", endpoint,
    "--content-type", "application/octet-stream",
    "--cache-control", "public, max-age=31536000, immutable",
    "--metadata", `sha256=${expectedSha256}`,
    "--cli-connect-timeout", "30",
    "--cli-read-timeout", "0",
  ], awsEnvironment);

  const metadata = JSON.parse(await command("aws", [
    "s3api", "head-object",
    "--bucket", bucket,
    "--key", key,
    "--endpoint-url", endpoint,
    "--output", "json",
  ], awsEnvironment, true));
  if (Number(metadata.ContentLength) !== expectedSize) {
    throw new Error(`R2 stored ${metadata.ContentLength} bytes; expected ${expectedSize}.`);
  }
  if (metadata.Metadata?.sha256 !== expectedSha256) {
    throw new Error("R2 did not retain the model checksum metadata.");
  }
  await verifyPublicObject();
  process.stdout.write("The Folio model is published and verified.\n");
} finally {
  await cloudflare(`/accounts/${accountId}/tokens/${token.id}`, {
    auth,
    method: "DELETE",
  }).catch((error) => {
    process.stderr.write(`Cloudflare token cleanup needs attention: ${error.message}\n`);
  });
}

async function cloudflareAuth() {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` };
  }
  if (process.env.CLOUDFLARE_EMAIL && process.env.CLOUDFLARE_API_KEY) {
    return {
      "X-Auth-Email": process.env.CLOUDFLARE_EMAIL,
      "X-Auth-Key": process.env.CLOUDFLARE_API_KEY,
    };
  }
  const credentials = JSON.parse(await command("npx", [
    "--yes", "wrangler", "auth", "token", "--json",
  ], process.env, true));
  if (!credentials.token) throw new Error("Wrangler did not return its Cloudflare session.");
  return { Authorization: `Bearer ${credentials.token}` };
}

async function cloudflare(path, { auth: headers, method = "GET", body } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    const message = payload.errors?.map((error) => error.message).join("; ")
      || `${response.status} ${response.statusText}`;
    throw new Error(`Cloudflare API: ${message}`);
  }
  return payload.result;
}

function findPermission(groups, name) {
  const permission = groups.find((group) => group.name === name);
  if (!permission) throw new Error(`Cloudflare permission is unavailable: ${name}.`);
  return permission;
}

async function verifyLocalModel() {
  const information = await stat(modelPath);
  if (information.size !== expectedSize) {
    throw new Error(`The local model has ${information.size} bytes; expected ${expectedSize}.`);
  }
  const digest = await fileSha256(modelPath);
  if (digest !== expectedSha256) throw new Error("The local model checksum does not match.");
}

async function publicObjectMatches() {
  try {
    await verifyPublicObject();
    return true;
  } catch {
    return false;
  }
}

async function verifyPublicObject() {
  const head = await fetch(publicUrl, { method: "HEAD", signal: AbortSignal.timeout(30_000) });
  if (!head.ok) throw new Error(`The public model returned HTTP ${head.status}.`);
  if (Number(head.headers.get("content-length")) !== expectedSize) {
    throw new Error("The public model length does not match.");
  }
  if (head.headers.get("content-type") !== "application/octet-stream") {
    throw new Error("The public model content type does not match.");
  }
  if (head.headers.get("cache-control") !== "public, max-age=31536000, immutable") {
    throw new Error("The public model cache policy does not match.");
  }

  const starts = [0, expectedSize - 1_024];
  for (const start of starts) {
    const end = start + 1_023;
    const range = await fetch(publicUrl, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: AbortSignal.timeout(30_000),
    });
    const remote = Buffer.from(await range.arrayBuffer());
    if (range.status !== 206 || remote.byteLength !== 1_024) {
      throw new Error("The public model byte-range check failed.");
    }
    if (range.headers.get("content-range") !== `bytes ${start}-${end}/${expectedSize}`) {
      throw new Error("The public model returned an unexpected byte range.");
    }
    const local = await readLocalRange(start, 1_024);
    if (!remote.equals(local)) {
      throw new Error("The public model byte range does not match the local model.");
    }
  }
}

async function readLocalRange(position, length) {
  const handle = await open(modelPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) throw new Error("The local model byte-range check failed.");
    return buffer;
  } finally {
    await handle.close();
  }
}

function fileSha256(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function command(executable, args, environment, capture = false) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: environment,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    let diagnostics = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { diagnostics += chunk; });
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(`${executable} exited with ${code}. ${diagnostics.trim()}`));
    });
  });
}
