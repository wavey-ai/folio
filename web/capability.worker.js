self.addEventListener("message", async ({ data }) => {
  const { id, operation } = data;
  try {
    if (operation !== "check") throw new Error(`Unknown capability operation: ${operation}`);
    self.postMessage({ id, result: await checkCapabilities() });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
});

async function checkCapabilities() {
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

  if (!secureContext) {
    guidance.push("Open Folio with HTTPS or from localhost.");
  }
  if (secureContext && !webgpuApi && safari) {
    guidance.push("Open Safari Settings, then Advanced, and show features for web developers.");
    guidance.push("Open Develop, then Feature Flags, and turn on WebGPU.");
    guidance.push("Restart Safari, then open Folio again.");
  } else if (secureContext && !webgpuApi) {
    guidance.push("Use a current browser with WebGPU support.");
  } else if (webgpuApi && !adapter) {
    guidance.push("Restart the browser so it can connect to the GPU.");
  } else if (adapter && !shaderF16) {
    guidance.push("Update the browser to enable 16-bit GPU shaders.");
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
    sharedMemory: typeof SharedArrayBuffer !== "undefined",
    recommendedBackend: webgpuReady ? "webgpu" : "cpu",
    guidance,
  };
}

function browserName(userAgent) {
  if (/Edg\//i.test(userAgent)) return "Edge";
  if (/(Chrome|Chromium|CriOS)\//i.test(userAgent)) return "Chrome";
  if (/Firefox\//i.test(userAgent)) return "Firefox";
  return "This browser";
}
