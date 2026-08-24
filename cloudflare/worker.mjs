const APP_HEADERS = Object.freeze({
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/web" || url.pathname.startsWith("/web/")) {
      const suffix = url.pathname.slice(4) || "/";
      return Response.redirect(`${url.origin}${suffix}${url.search}`, 308);
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(APP_HEADERS)) headers.set(name, value);
    if (headers.get("content-type")?.startsWith("text/html")) {
      headers.set("Cache-Control", "no-store, max-age=0");
      headers.set("CDN-Cache-Control", "no-store");
      headers.set("Cloudflare-CDN-Cache-Control", "no-store");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
