self.addEventListener("message", async ({ data }) => {
  const { id, operation } = data;
  try {
    if (operation !== "check") throw new Error(`Unknown capability operation: ${operation}`);
    self.postMessage({ id, result: await checkCapabilities(data.isolated) });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
});

async function checkCapabilities(pageIsolated) {
  const userAgent = navigator.userAgent || "";
  const safariMatch = userAgent.match(/Version\/(\d+(?:\.\d+)?).*Safari\//i);
  const safari = Boolean(safariMatch) && !/(Chrome|Chromium|CriOS|Edg|OPR)\//i.test(userAgent);
  const secureContext = self.isSecureContext;
  const webgpuApi = Boolean(navigator.gpu);
  const adapter = webgpuApi
    ? await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }).catch(() => null)
    : null;
  const features = adapter ? Array.from(adapter.features).sort() : [];
  const shaderF16 = features.includes("shader-f16");
  const webgpuReady = secureContext && Boolean(adapter) && shaderF16;
  const guidance = [];
  const sharedMemory = typeof SharedArrayBuffer !== "undefined";
  const isolated = Boolean(pageIsolated ?? self.crossOriginIsolated);

  if (!secureContext) {
    guidance.push("Open Folio with HTTPS or from localhost.");
  }
  if (secureContext && (!isolated || !sharedMemory)) {
    guidance.push("Start Folio with node scripts/serve-web.mjs, then reload this page.");
  }

  return {
    browser: safari ? `Safari ${safariMatch[1]}` : browserName(userAgent),
    platform: navigator.platform || "This device",
    secureContext,
    webgpuApi,
    adapter: Boolean(adapter),
    shaderF16,
    webgpuReady,
    features,
    sharedMemory,
    isolated,
    hardwareConcurrency: navigator.hardwareConcurrency || 1,
    recommendedBackend: "cpu",
    guidance,
  };
}

function browserName(userAgent) {
  if (/Edg\//i.test(userAgent)) return "Edge";
  if (/(Chrome|Chromium|CriOS)\//i.test(userAgent)) return "Chrome";
  if (/Firefox\//i.test(userAgent)) return "Firefox";
  return "This browser";
}
