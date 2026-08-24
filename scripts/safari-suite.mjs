import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const targetUrl = process.env.FOLIO_URL || "https://folio.wavey.ai/";
const testAssistant = process.env.FOLIO_SAFARI_ASSISTANT === "1";
const minimizeWindow = process.env.FOLIO_SAFARI_MINIMIZE !== "0";
const returnSpace = process.env.FOLIO_SAFARI_RETURN_SPACE || "";
assert.ok(["", "left", "right"].includes(returnSpace), "FOLIO_SAFARI_RETURN_SPACE must be left or right.");
const port = Number(process.env.SAFARIDRIVER_PORT || 4455);
const driverUrl = `http://127.0.0.1:${port}`;
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
const output = resolve(root, process.env.FOLIO_SAFARI_OUTPUT || `build/safari-suite/${runId}`);
const screenshots = join(output, "screenshots");
const fixtures = join(output, "fixtures");
const report = {
  startedAt: new Date().toISOString(),
  url: targetUrl,
  browser: "Safari",
  assistant: testAssistant,
  minimized: minimizeWindow,
  returnSpace,
  steps: [],
};

await Promise.all([
  mkdir(screenshots, { recursive: true }),
  mkdir(fixtures, { recursive: true }),
]);

const jsonPath = join(fixtures, "safari-customers.json");
const xmlPath = join(fixtures, "safari-catalog.xml");
await Promise.all([
  writeFile(jsonPath, JSON.stringify({
    marker: "SAFARI_JSON_MARKER",
    customers: [
      {
        name: "Jam Cafe",
        orders: [
          { placedAt: "2026-08-20", total: 125.5, items: ["Coffee", "Cake"] },
          { placedAt: "2026-08-21", total: 32, items: ["Tea"] },
        ],
      },
      {
        name: "Wave Records",
        orders: [{ placedAt: "2026-08-22", total: 240, items: ["Vinyl"] }],
      },
    ],
  }, null, 2)),
  writeFile(xmlPath, `<?xml version="1.0" encoding="UTF-8"?>
<catalog xmlns:folio="https://folio.wavey.ai/test" edition="2026">
  <marker>SAFARI_XML_MARKER</marker>
  <artist id="a1" active="true">
    <name>Björk</name>
    <release year="1997"><title>Homogenic</title><style>Electronic</style></release>
    <release year="2001"><title>Vespertine</title><style>Electronic</style></release>
  </artist>
  <artist id="a2" active="true">
    <name>Burial</name>
    <release year="2007"><title>Untrue</title><style>Electronic</style></release>
  </artist>
  <folio:source><![CDATA[Safari & WebKit]]></folio:source>
</catalog>
`),
]);

let driver = null;
let sessionId = "";
let returnedFromAutomationSpace = false;

try {
  driver = await startDriver();
  sessionId = await createSession();
  await command("POST", `/session/${sessionId}/window/rect`, {
    width: 1440,
    height: 1000,
    x: 20,
    y: 20,
  });
  if (returnSpace) {
    await switchSpace(returnSpace);
    returnedFromAutomationSpace = true;
  } else if (minimizeWindow) {
    await command("POST", `/session/${sessionId}/window/minimize`, {});
  }

  await step("open Folio in Safari", async () => {
    await command("POST", `/session/${sessionId}/url`, { url: targetUrl }, 120_000);
    await waitFor("Safari workspace", `
      const engine = document.querySelector("#engine-state");
      return engine?.classList.contains("ready")
        && ["Ready for a document", "Previous workspace restored", "Workspace resumed"]
          .includes(document.querySelector("#activity-title")?.textContent);
    `, 600_000);
    assert.equal(await execute("return document.title;"), "Folio");
    report.browserRuntime = await execute(`
      return {
        userAgent: navigator.userAgent,
        vendor: navigator.vendor,
        platform: navigator.platform,
        webkit: /AppleWebKit\\//.test(navigator.userAgent),
        webGPU: Boolean(navigator.gpu),
      };
    `);
    assert.equal(report.browserRuntime.vendor, "Apple Computer, Inc.");
    assert.equal(report.browserRuntime.webkit, true);
    await screenshot("01-empty-safari.png");
  });

  await step("render the Wavey footer mark in Safari", async () => {
    await execute(`
      document.querySelector(".site-footer")?.scrollIntoView({ block: "center" });
      return true;
    `);
    await waitFor("Safari Wavey footer", `
      const icon = document.querySelector(".wavey-credit-icon");
      const image = document.querySelector(".wavey-credit-image");
      const picture = document.querySelector(".wavey-credit-picture");
      const pixels = document.querySelectorAll(".wavey-credit-pixel");
      const credit = document.querySelector(".wavey-credit-label")?.textContent || "";
      return icon
        && getComputedStyle(icon).overflow === "hidden"
        && picture
        && image?.complete
        && image.naturalWidth > 0
        && /wavey-(10cee1b60b2c\.avif|7c0f05bb2a40\.webp)$|wavey\.png$/.test(image.currentSrc)
        && pixels.length === 64
        && credit.includes("by wavey.ai");
    `, 30_000);
    await screenshot("02-wavey-footer-safari.png");
    await execute(`window.scrollTo({ top: 0 }); return true;`);
  });

  await step("upload JSON and query PostgreSQL", async () => {
    await uploadDocument(jsonPath, basename(jsonPath));
    await waitForDocument(basename(jsonPath), 240_000);
    assert.equal(await runSql(`
      SELECT count(*)
      FROM nodes
      WHERE value = 'SAFARI_JSON_MARKER';
    `), "1");
    assert.equal(await runSql(`
      SELECT count(*)
      FROM nodes
      WHERE name LIKE '%__customers__orders'
        AND path = 'total';
    `), "3");
    await screenshot("03-json-result-safari.png");
  });

  await step("replace JSON with XML and query PostgreSQL", async () => {
    await uploadDocument(xmlPath, basename(xmlPath));
    await waitForDocument(basename(xmlPath), 240_000);
    assert.equal(await runSql(`
      SELECT count(*)
      FROM nodes
      WHERE value = 'SAFARI_XML_MARKER';
    `), "1");
    assert.equal(await runSql(`
      SELECT count(*)
      FROM nodes
      WHERE value = 'SAFARI_JSON_MARKER';
    `), "0");
    assert.equal(await runSql(`
      SELECT count(*)
      FROM nodes
      WHERE name LIKE '%__artist'
        AND path = '@id';
    `), "2");
    assert.equal(await runSql(`
      SELECT count(*)
      FROM nodes
      WHERE value IN ('Homogenic', 'Vespertine', 'Untrue')
        AND (path = 'title' OR path = 'release__title');
    `), "3");
    await screenshot("04-xml-result-safari.png");
  });

  await step("clear SQL and resume the Safari workspace", async () => {
    const sql = `SELECT count(*)
      FROM nodes
      WHERE value IN ('Homogenic', 'Vespertine', 'Untrue')
        AND (path = 'title' OR path = 'release__title');`;
    await execute(`document.querySelector("#clear-sql-button").click(); return true;`);
    const cleared = await execute(`
      return {
        sql: document.querySelector("#sql-output")?.value || "",
        runDisabled: document.querySelector("#run-button")?.disabled,
        clearDisabled: document.querySelector("#clear-sql-button")?.disabled,
        rowCount: document.querySelector("#row-count")?.textContent || "",
      };
    `);
    assert.deepEqual(cleared, {
      sql: "",
      runDisabled: true,
      clearDisabled: true,
      rowCount: "0 rows",
    });
    assert.equal(await runSql(sql), "3");

    await command("POST", `/session/${sessionId}/url`, { url: "about:blank" }, 30_000);
    await command("POST", `/session/${sessionId}/back`, {}, 120_000);
    await waitFor("resumed Safari workspace", `
      const expected = ${JSON.stringify(sql)}.trim();
      return document.querySelector("#engine-state")?.classList.contains("ready")
        && document.querySelector("#sql-output")?.value === expected
        && document.querySelector("#result-wrap tbody td")?.textContent === "3";
    `, 600_000);
    assert.equal(await execute(`return document.querySelector("#activity-title")?.textContent;`), "Workspace resumed");
  });

  await step("load the Discogs demo and run a relationship query", async () => {
    await execute(`
      document.querySelector("#demo-button").click();
      return true;
    `);
    await waitForDocument("Discogs releases", 900_000);
    await waitFor("Safari demo report", `
      const sql = document.querySelector("#sql-output")?.value || "";
      const result = document.querySelector("#result-wrap tbody");
      const runButton = document.querySelector("#run-button");
      return sql.includes("parent_id") && result && runButton && !runButton.disabled;
    `, 300_000, [], true);
    const status = await execute(`return document.querySelector("#document-status")?.textContent || "";`);
    const values = Number(status.match(/([\d,]+) values/)?.[1]?.replaceAll(",", "") || 0);
    assert.ok(values > 750_000, `Safari mapped ${values} demo values.`);
    const demoReport = await execute(`
      return {
        sql: document.querySelector("#sql-output")?.value || "",
        rows: document.querySelectorAll("#result-wrap tbody tr").length,
        columns: [...document.querySelectorAll("#result-wrap thead th")]
          .map((cell) => cell.textContent || ""),
      };
    `);
    assert.match(demoReport.sql, /parent_id/);
    assert.ok(demoReport.rows > 0, "Safari returned rows from the relationship report.");
    report.demoReport = demoReport;
    await screenshot("05-discogs-result-safari.png");
  });

  if (testAssistant) {
    await step("load and warm the local model in Safari", async () => {
      await execute(`document.querySelector("#model-load-button").click(); return true;`);
      await waitFor("Safari local model", `
        const status = document.querySelector("#model-status")?.textContent || "";
        const service = document.querySelector("#model-service-state")?.textContent || "";
        return status === "Local model ready" && (service === "GPU" || service === "CPU");
      `, 900_000, [], true);
      const model = await execute(`
        return {
          backend: document.querySelector("#model-service-state")?.textContent || "",
          status: document.querySelector("#model-status")?.textContent || "",
          detail: document.querySelector("#model-progress-copy")?.textContent || "",
        };
      `);
      assert.match(model.detail, /Health check:/);
      report.model = model;
      await screenshot("06-model-ready-safari.png");
    });

    await step("ask the local model and run its PostgreSQL in Safari", async () => {
      await execute(`
        const input = document.querySelector("#ask-input");
        input.value = "Which artists have the most Electronic releases? Include release, track, and label totals.";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("#chat-button").click();
        return true;
      `);
      await waitFor("Safari assistant report", `
        const title = document.querySelector("#builder-title")?.textContent || "";
        const sql = document.querySelector("#agent-sql-output")?.value || "";
        const rows = document.querySelectorAll("#result-wrap tbody tr").length;
        const button = document.querySelector("#chat-button");
        return title.includes("Query ready")
          && sql.includes("parent_id")
          && rows > 0
          && button
          && !button.disabled;
      `, 900_000, [], true);
      report.assistantResult = await execute(`
        return {
          title: document.querySelector("#builder-title")?.textContent || "",
          sqlLength: document.querySelector("#agent-sql-output")?.value.length || 0,
          agentReadOnly: document.querySelector("#agent-sql-output")?.readOnly,
          userReadOnly: document.querySelector("#sql-output")?.readOnly,
          userDisabled: document.querySelector("#sql-output")?.disabled,
          rows: document.querySelectorAll("#result-wrap tbody tr").length,
        };
      `);
      assert.equal(report.assistantResult.agentReadOnly, true);
      assert.equal(report.assistantResult.userReadOnly, false);
      assert.equal(report.assistantResult.userDisabled, false);
      await screenshot("07-assistant-result-safari.png");
    });
  }

  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = { message: error.message, stack: error.stack };
  if (sessionId) {
    report.failureUi = await captureUiState().catch(() => null);
    await screenshot("failure-safari.png").catch(() => {});
  }
  throw error;
} finally {
  if (returnSpace && !returnedFromAutomationSpace) {
    await switchSpace(returnSpace).catch(() => {});
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (sessionId) {
    await command("DELETE", `/session/${sessionId}`, undefined, 30_000).catch(() => {});
  }
  if (driver) driver.kill("SIGTERM");
  process.stdout.write(`Safari report: ${join(output, "report.json")}\n`);
}

async function startDriver() {
  const child = spawn("/usr/bin/safaridriver", ["--port", String(port), "--diagnose"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${driverUrl}/status`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return child;
    } catch {}
    await delay(200);
  }
  child.kill("SIGTERM");
  throw new Error("SafariDriver did not start.");
}

async function createSession() {
  const value = await command("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "Safari",
        pageLoadStrategy: "normal",
      },
    },
  }, 60_000);
  assert.equal(value.capabilities.browserName, "Safari");
  process.stdout.write(`Safari ${value.capabilities.browserVersion} on ${value.capabilities.platformName}\n`);
  return value.sessionId;
}

async function command(method, path, body, timeout = 30_000) {
  const response = await fetch(`${driverUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : { value: null };
  if (!response.ok || payload.value?.error) {
    const message = payload.value?.message
      || payload.value?.error
      || `${response.status} ${response.statusText}`;
    throw new Error(`SafariDriver: ${message}`);
  }
  return payload.value;
}

function execute(script, args = []) {
  return command("POST", `/session/${sessionId}/execute/sync`, { script, args }, 60_000);
}

async function uploadDocument(path, label) {
  await execute(`document.querySelector("#file-input").value = ""; return true;`);
  const element = await command("POST", `/session/${sessionId}/element`, {
    using: "css selector",
    value: "#file-input",
  });
  const elementId = element["element-6066-11e4-a52e-4f735466cecf"];
  await command("POST", `/session/${sessionId}/element/${elementId}/value`, {
    text: path,
    value: [...path],
  });
  await waitFor(`Safari read ${label}`, `
    return (document.querySelector("#document-status")?.textContent || "").includes(arguments[0]);
  `, 30_000, [label]);
}

async function waitForDocument(label, timeout) {
  await waitFor(`Safari prepared ${label}`, `
    const status = document.querySelector("#document-status")?.textContent || "";
    const preparation = document.querySelector("#document-prep");
    return preparation?.getAttribute("aria-busy") === "false"
      && status.includes(arguments[0])
      && status.includes(" values.");
  `, timeout, [label], true);
  const status = await execute(`return document.querySelector("#document-status")?.textContent || "";`);
  assert.doesNotMatch(status, /needs attention|Review/i);
}

async function runSql(sql) {
  await execute(`
    const output = document.querySelector("#sql-output");
    output.value = arguments[0].trim();
    output.dispatchEvent(new Event("input", { bubbles: true }));
    window.__folioSafariResultObserver?.disconnect();
    window.__folioSafariResultMutations = 0;
    window.__folioSafariResultObserver = new MutationObserver(() => {
      window.__folioSafariResultMutations += 1;
    });
    window.__folioSafariResultObserver.observe(
      document.querySelector("#result-wrap"),
      { childList: true, subtree: true, characterData: true },
    );
    document.querySelector("#run-button").click();
    return true;
  `, [sql]);
  await waitFor("Safari query result", `
    const firstCell = document.querySelector("#result-wrap tbody td")?.textContent;
    const runButton = document.querySelector("#run-button");
    return window.__folioSafariResultMutations > 0
      && typeof firstCell === "string"
      && runButton
      && !runButton.disabled;
  `, 300_000, [], true);
  const value = await execute(`
    window.__folioSafariResultObserver?.disconnect();
    return document.querySelector("#result-wrap tbody td")?.textContent || "";
  `);
  return value;
}

async function waitFor(label, script, timeout, args = [], showProgress = false) {
  const started = Date.now();
  let nextProgress = started + 5_000;
  let previousProgress = "";
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      if (await execute(script, args)) return;
      lastError = null;
      if (showProgress && Date.now() >= nextProgress) {
        const state = await captureUiState();
        const fatal = [
          state.documentClass.includes("error") ? state.document : "",
          state.postgresClass.includes("error") ? state.postgres : "",
          state.modelClass.includes("error") ? `${state.model} — ${state.modelDetail}` : "",
        ].find(Boolean);
        if (fatal) throw new Error(`${label}: ${fatal}`);
        const progress = [
          state.document,
          state.postgres,
          state.model,
          state.modelDetail,
          state.activity,
        ].filter(Boolean).join(" · ");
        if (progress && progress !== previousProgress) {
          process.stdout.write(`  ${progress}\n`);
          previousProgress = progress;
        }
        nextProgress = Date.now() + 5_000;
      }
    } catch (error) {
      if (/invalid session id|no such window|browsing context.*discarded/i.test(error.message)) {
        throw error;
      }
      lastError = error;
    }
    await delay(300);
  }
  throw new Error(`${label} timed out.${lastError ? ` ${lastError.message}` : ""}`);
}

function captureUiState() {
  return execute(`
    return {
      document: document.querySelector("#document-status")?.textContent || "",
      documentClass: document.querySelector("#document-service")?.className || "",
      postgres: document.querySelector("#postgres-runtime-status")?.textContent || "",
      postgresClass: document.querySelector("#postgres-runtime")?.className || "",
      model: document.querySelector("#model-status")?.textContent || "",
      modelDetail: document.querySelector("#model-progress-copy")?.textContent || "",
      modelClass: document.querySelector("#model-loader")?.className || "",
      modelBackend: document.querySelector("#model-service-state")?.textContent || "",
      activity: document.querySelector("#activity-title")?.textContent || "",
      activityDetail: document.querySelector("#activity-detail")?.textContent || "",
      assistant: document.querySelector("#assistant-feedback")?.textContent || "",
      builder: document.querySelector("#builder-title")?.textContent || "",
      sql: document.querySelector("#sql-output")?.value || "",
      activityLog: document.querySelector("#activity-log")?.textContent || "",
    };
  `);
}

async function screenshot(name) {
  if (minimizeWindow) {
    report.screenshotsSkipped = "Safari was minimized for unattended testing.";
    return;
  }
  const encoded = await command("GET", `/session/${sessionId}/screenshot`, undefined, 60_000);
  await writeFile(join(screenshots, name), Buffer.from(encoded, "base64"));
}

async function step(name, action) {
  const started = performance.now();
  process.stdout.write(`→ ${name}\n`);
  try {
    await action();
    const durationMs = Math.round(performance.now() - started);
    report.steps.push({ name, status: "passed", durationMs });
    process.stdout.write(`✓ ${name} (${durationMs} ms)\n`);
  } catch (error) {
    report.steps.push({
      name,
      status: "failed",
      durationMs: Math.round(performance.now() - started),
      message: error.message,
    });
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function switchSpace(direction) {
  const keyCode = direction === "left" ? 123 : 124;
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("/usr/bin/osascript", [
      "-e",
      `tell application \"System Events\" to key code ${keyCode} using control down`,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Could not switch ${direction}: ${stderr.trim()}`));
    });
  });
  await delay(1_000);
}
