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
  const gpuProbe = adapter && shaderF16
    ? await probeWebGPU(adapter)
    : { ready: false, error: "" };
  const webgpuReady = secureContext && gpuProbe.ready;
  const guidance = [];
  const sharedMemory = typeof SharedArrayBuffer !== "undefined";
  const isolated = Boolean(pageIsolated ?? self.crossOriginIsolated);

  if (!secureContext) {
    guidance.push("Open Folio with HTTPS or from localhost.");
  }
  if (secureContext && (!isolated || !sharedMemory)) {
    guidance.push("Start Folio with node scripts/serve-web.mjs, then reload this page.");
  }
  if (secureContext && webgpuApi && adapter && !shaderF16) {
    guidance.push("Use a browser profile that exposes 16-bit GPU shaders.");
  }
  if (secureContext && shaderF16 && !gpuProbe.ready) {
    guidance.push("Restart this browser, then let Folio check the GPU again.");
  }

  return {
    browser: safari ? `Safari ${safariMatch[1]}` : browserName(userAgent),
    platform: navigator.platform || "This device",
    secureContext,
    webgpuApi,
    adapter: Boolean(adapter),
    shaderF16,
    webgpuReady,
    gpuProbeError: gpuProbe.error,
    features,
    adapterInfo: adapter ? readAdapterInfo(adapter) : null,
    adapterLimits: adapter ? {
      maxBufferSize: Number(adapter.limits.maxBufferSize || 0),
      maxStorageBufferBindingSize: Number(adapter.limits.maxStorageBufferBindingSize || 0),
    } : null,
    sharedMemory,
    isolated,
    hardwareConcurrency: navigator.hardwareConcurrency || 1,
    recommendedBackend: webgpuReady ? "webgpu" : "cpu",
    guidance,
  };
}

async function probeWebGPU(adapter) {
  let device;
  try {
    device = await adapter.requestDevice({ requiredFeatures: ["shader-f16"] });
    device.pushErrorScope("validation");
    const module = device.createShaderModule({
      code: `enable f16;
        @compute @workgroup_size(1)
        fn main() { let value = f16(1.0); _ = value; }`,
    });
    await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const validationError = await device.popErrorScope();
    if (validationError) throw validationError;
    return { ready: true, error: "" };
  } catch (error) {
    return { ready: false, error: error?.message || String(error) };
  } finally {
    device?.destroy();
  }
}

function readAdapterInfo(adapter) {
  const info = adapter.info || {};
  return {
    architecture: info.architecture || "",
    device: info.device || "",
    description: info.description || "",
    vendor: info.vendor || "",
  };
}

function browserName(userAgent) {
  if (/Edg\//i.test(userAgent)) return "Edge";
  if (/(Chrome|Chromium|CriOS)\//i.test(userAgent)) return "Chrome";
  if (/Firefox\//i.test(userAgent)) return "Firefox";
  return "This browser";
}
