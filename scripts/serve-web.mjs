import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const port = Number(process.env.FOLIO_PORT || 8000);
const types = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".xml", "application/xml; charset=utf-8"],
]);

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    const requestedPath = decodeURIComponent(url.pathname);
    let filePath = resolve(root, `.${requestedPath}`);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      respond(response, 403, "Forbidden");
      return;
    }

    let file = await stat(filePath);
    if (file.isDirectory()) {
      filePath = resolve(filePath, "index.html");
      file = await stat(filePath);
    }

    response.writeHead(200, {
      "Content-Length": file.size,
      "Content-Type": types.get(extname(filePath)) || "application/octet-stream",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    respond(response, error?.code === "ENOENT" ? 404 : 500, "File unavailable");
  }
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`Folio is ready at http://127.0.0.1:${port}/web/\n`);
});

function respond(response, status, message) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  response.end(message);
}
