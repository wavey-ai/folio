import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

const sourceUrl = "https://data.discogs.com/?download=data%2F2026%2Fdiscogs_20260801_releases.xml.gz";
const outputUrl = new URL("../web/samples/discogs-releases.xml", import.meta.url);
const partialUrl = new URL("../web/samples/discogs-releases.xml.partial", import.meta.url);
const targetMiB = Number(process.argv[2] || 30);
const targetBytes = targetMiB * 1024 * 1024;

if (!Number.isFinite(targetBytes) || targetBytes < 1024 * 1024) {
  throw new Error("Set the sample size to 1 MiB or more.");
}

await rm(partialUrl, { force: true });

const controller = new AbortController();
const response = await fetch(sourceUrl, { signal: controller.signal });
if (!response.ok || !response.body) {
  throw new Error(`Discogs returned HTTP ${response.status}.`);
}

const compressed = Readable.fromWeb(response.body);
const decompressed = compressed.pipe(createGunzip());
const output = createWriteStream(partialUrl, { encoding: "utf8" });
const decoder = new TextDecoder();
const releaseOpen = "<release ";
let pending = "";
let outputBytes = 0;
let releases = 0;
let complete = false;

await write("<releases>\n");

try {
  for await (const chunk of decompressed) {
    pending += decoder.decode(chunk, { stream: true });
    const firstRelease = pending.indexOf(releaseOpen);
    if (!releases && firstRelease >= 0) pending = pending.slice(firstRelease);

    while (true) {
      const start = pending.indexOf(releaseOpen);
      const close = start < 0 ? -1 : pending.indexOf("</release>", start);
      if (start < 0 || close < 0) break;

      const end = close + "</release>".length;
      const record = `${pending.slice(start, end)}\n`;
      await write(record);
      outputBytes += Buffer.byteLength(record);
      releases += 1;
      pending = pending.slice(end);

      if (outputBytes >= targetBytes) {
        complete = true;
        break;
      }
    }

    if (complete) break;
  }
} finally {
  controller.abort();
  compressed.destroy();
  decompressed.destroy();
}

if (!complete) {
  output.destroy();
  await rm(partialUrl, { force: true });
  throw new Error("The Discogs stream ended before the sample reached its target size.");
}

await write("</releases>\n");
output.end();
await once(output, "close");
await rename(partialUrl, outputUrl);

const file = await stat(outputUrl);
process.stdout.write(`Created ${file.size} bytes with ${releases} complete releases.\n`);

async function write(value) {
  if (output.write(value)) return;
  await once(output, "drain");
}
