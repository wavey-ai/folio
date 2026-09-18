import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "../web/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const options = parseOptions(process.argv.slice(2));
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
const output = resolve(root, options.output || `build/browser-suite/${runId}`);
const fixtures = join(output, "fixtures");
const downloads = join(output, "downloads");
const screenshots = join(output, "screenshots");
const browserProfile = options.profile
  ? resolve(root, options.profile)
  : join(output, "browser-profile");
const report = {
  startedAt: new Date().toISOString(),
  url: options.url,
  assistant: options.assistant,
  steps: [],
  console: [],
  pageErrors: [],
  failedRequests: [],
  failedResponses: [],
  webSources: [],
};

await Promise.all([
  mkdir(fixtures, { recursive: true }),
  mkdir(downloads, { recursive: true }),
  mkdir(screenshots, { recursive: true }),
  mkdir(browserProfile, { recursive: true }),
]);

const fixturePaths = await writeFixtures(fixtures);
const webFixturePaths = options.onlyCsv ? {} : await downloadWebFixtures(fixtures, report.webSources);
let server = null;
let browser = null;
let page = null;

try {
  server = await startLocalServerWhenNeeded(options.url);
  browser = await puppeteer.launch({
    executablePath: options.chrome,
    headless: !options.headed,
    userDataDir: browserProfile,
    protocolTimeout: 1_800_000,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only",
    ],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
  captureBrowserDiagnostics(page, report);
  const session = await page.createCDPSession();
  await session.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
    eventsEnabled: true,
  });

  await runStep("open Folio", async () => {
    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await waitForApplication(page);
    await page.evaluate(() => localStorage.removeItem("folio.saved-work.v1"));
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
    await waitForApplication(page);
    assert.equal(await page.$eval("#saved-work-count", (element) => element.textContent), "0");
    await page.screenshot({ path: join(screenshots, "01-empty-desktop.png"), fullPage: true });
  });

  await runStep("import CSV, query it, and restore it after a reload", async () => {
    assert.match(await page.$eval("#file-input", (input) => input.accept), /\.csv/);
    await uploadDocument(page, fixturePaths.csv, "flat.csv");
    await assertDocumentReady(page, "flat.csv");
    assert.equal(await page.$eval("#table-count", (element) => element.textContent), "1");
    await runSql(page, "SELECT count(DISTINCT id) FROM nodes WHERE name = 'flat';", "2");
    const sql = "SELECT value FROM nodes WHERE name = 'flat' AND path = 'account' AND value = '00123';";
    await runSql(page, sql, "00123");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
    await waitForApplication(page);
    await assertDocumentReady(page, "flat.csv");
    assert.equal(await page.$eval("#sql-output", (element) => element.value), sql);
    await runSql(page, sql, "00123");
    await runSql(page, "SELECT value FROM nodes WHERE name = 'flat' AND path = 'note' AND value <> '';", 'Said "hello"\nagain');
    await page.screenshot({ path: join(screenshots, "csv-desktop.png"), fullPage: true });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(screenshots, "csv-mobile.png"), fullPage: true });
    await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
  });

  await runStep("map complex JSON and query it", async () => {
    await uploadDocument(page, fixturePaths.json, "complex.json");
    await assertDocumentReady(page, "complex.json");
    assert.ok(Number(await page.$eval("#table-count", (element) => element.textContent)) > 0);
    await page.click('[data-schema-query="rows"]');
    await page.waitForFunction(
      () => document.querySelector("#sql-output")?.value.trim() === "SELECT *\nFROM nodes\nLIMIT 10;"
        && Boolean(document.querySelector("#result-wrap table")),
      { timeout: 120_000 },
    );
    await runSql(page, `
      SELECT count(*) AS marker_count
      FROM nodes
      WHERE value = 'JSON_ONLY_MARKER';
    `, "1");
    await page.screenshot({ path: join(screenshots, "02-json-report-desktop.png"), fullPage: true });
  });

  await runStep("replace JSON with complex XML", async () => {
    await uploadDocument(page, fixturePaths.xml, "complex.xml");
    await assertDocumentReady(page, "complex.xml");
    await runSql(page, `
      SELECT count(*) AS prior_document_rows
      FROM nodes
      WHERE value = 'JSON_ONLY_MARKER';
    `, "0");
    const attributeRows = Number(await runSqlAndReadFirstCell(page, `
      SELECT count(*) AS attribute_rows
      FROM nodes
      WHERE path LIKE '@%';
    `));
    assert.ok(attributeRows >= 4, `Expected XML attributes; received ${attributeRows} rows.`);
    await runSql(page, `
      SELECT value AS marker
      FROM nodes
      WHERE value = 'XML_ONLY_MARKER';
    `, "XML_ONLY_MARKER");
  });

  let savedSql = "";
  await runStep("save a query and its current report", async () => {
    savedSql = await page.$eval("#sql-output", (element) => element.value);
    await saveCurrentWork(page, "query", "XML marker query", 1);
    await saveCurrentWork(page, "report", "XML marker report", 2);
    await page.screenshot({ path: join(screenshots, "03-saved-work-desktop.png"), fullPage: false });
    await page.click("#close-saved-work");
  });

  await runStep("replace XML and prove PostgreSQL reset", async () => {
    await uploadDocument(page, fixturePaths.replacement, "replacement.json");
    await assertDocumentReady(page, "replacement.json");
    await runSql(page, `
      SELECT count(*) AS prior_document_rows
      FROM nodes
      WHERE value = 'XML_ONLY_MARKER';
    `, "0");
    await runSql(page, `
      SELECT count(*) AS replacement_rows
      FROM nodes
      WHERE value = 'REPLACEMENT_ONLY_MARKER';
    `, "1");
  });

  await runStep("upload web-sourced JSON and XML without a refresh", async () => {
    const sequence = [
      { ...webFixturePaths.jsonBenchmark, prior: "replacement", minimumRows: 10_000 },
      { ...webFixturePaths.musicBrainzXml, prior: "jsonbenchmark", minimumRows: 100 },
      { ...webFixturePaths.musicBrainzJson, prior: "musicbrainzxml", minimumRows: 100 },
      { ...webFixturePaths.metsProfile, prior: "musicbrainzjson", minimumRows: 10 },
    ];
    for (const document of sequence) {
      await uploadDocument(page, document.path, document.label);
      await assertDocumentReady(page, document.label, 600_000);
      const priorRows = Number(await runSqlAndReadFirstCell(page, `
        SELECT count(*) AS prior_document_rows
        FROM nodes
        WHERE name LIKE '${document.prior}__%';
      `));
      assert.equal(priorRows, 0, `${document.label} retains rows from ${document.prior}.`);
      const loadedRows = Number(await runSqlAndReadFirstCell(page, `
        SELECT count(*) AS loaded_rows
        FROM nodes
        WHERE name LIKE '${document.source}__%';
      `));
      assert.ok(
        loadedRows >= document.minimumRows,
        `${document.label} produced ${loadedRows} rows; expected at least ${document.minimumRows}.`,
      );
    }
  });

  await runStep("keep saved work across a reload", async () => {
    const sqlBeforeReload = await page.$eval("#sql-output", (element) => element.value);
    const resultBeforeReload = await page.$eval("#result-wrap tbody td", (element) => element.textContent);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
    await waitForApplication(page);
    await page.waitForFunction(
      (sql) => document.querySelector("#sql-output")?.value === sql,
      { timeout: 600_000 },
      sqlBeforeReload,
    );
    assert.equal(
      await page.$eval("#result-wrap tbody td", (element) => element.textContent),
      resultBeforeReload,
    );
    await page.waitForFunction(
      () => document.querySelector("#saved-work-count")?.textContent === "2",
      { timeout: 30_000 },
    );
    await openSavedWorkLibrary(page);
    assert.equal(await page.$eval("#saved-query-count", (element) => element.textContent), "1");
    assert.equal(await page.$eval("#saved-report-count", (element) => element.textContent), "1");
  });

  await runStep("rename and reopen the saved query", async () => {
    await clickSavedAction(page, "#saved-query-list", "XML marker query", "Rename");
    await page.waitForSelector("#saved-work-form:not([hidden])");
    await replaceInput(page, "#saved-work-name", "XML marker query renamed");
    await page.click("#confirm-save-work");
    await page.waitForFunction(
      () => document.querySelector("#saved-query-list")?.textContent.includes("XML marker query renamed"),
      { timeout: 15_000 },
    );
    await clickSavedAction(page, "#saved-query-list", "XML marker query renamed", "Open query");
    await page.waitForFunction(
      (sql) => document.querySelector("#sql-output")?.value === sql,
      { timeout: 15_000 },
      savedSql,
    );
    assert.equal(await page.$eval("#copy-button", (element) => element.disabled), false);
    assert.equal(await page.$eval("#save-query", (element) => element.disabled), false);
    assert.equal(await page.$eval("#run-button", (element) => element.disabled), false);
  });

  await runStep("reopen and download the saved report", async () => {
    await openSavedWorkLibrary(page);
    const previousDownloads = new Set(await readdir(downloads));
    await clickSavedAction(page, "#saved-report-list", "XML marker report", "Open report");
    await page.waitForFunction(
      () => document.querySelector("#result-wrap tbody td")?.textContent === "XML_ONLY_MARKER",
      { timeout: 15_000 },
    );
    await page.click("#download-csv");
    const downloaded = await waitForDownload(downloads, previousDownloads);
    assert.match(downloaded, /^folio-complex-xml-report-\d{8}\.csv$/);
    assert.match(await readFile(join(downloads, downloaded), "utf8"), /XML_ONLY_MARKER/);
  });

  await runStep("run the saved query after reopening its source", async () => {
    await uploadDocument(page, fixturePaths.xml, "complex.xml");
    await assertDocumentReady(page, "complex.xml");
    await openSavedWorkLibrary(page);
    await clickSavedAction(page, "#saved-query-list", "XML marker query renamed", "Open query");
    assert.equal(await page.$eval("#run-button", (element) => element.disabled), false);
    assert.equal(await runSqlAndReadFirstCell(page, savedSql), "XML_ONLY_MARKER");
  });

  await runStep("clear SQL and preserve the workspace through navigation", async () => {
    await page.click("#clear-sql-button");
    assert.equal(await page.$eval("#sql-output", (element) => element.value), "");
    assert.equal(await page.$eval("#run-button", (element) => element.disabled), true);
    assert.equal(await page.$eval("#clear-sql-button", (element) => element.disabled), true);
    assert.equal(await page.$eval("#row-count", (element) => element.textContent), "0 rows");

    assert.equal(await runSqlAndReadFirstCell(page, savedSql), "XML_ONLY_MARKER");
    await page.goto("about:blank");
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 120_000 });
    await waitForApplication(page);
    assert.equal(await page.$eval("#sql-output", (element) => element.value), savedSql);
    assert.equal(
      await page.$eval("#result-wrap tbody td", (element) => element.textContent),
      "XML_ONLY_MARKER",
    );
  });

  await runStep("confirm deletion in two steps", async () => {
    await openSavedWorkLibrary(page);
    await clickSavedAction(page, "#saved-query-list", "XML marker query renamed", "Delete");
    await page.waitForFunction(
      () => [...document.querySelectorAll("#saved-query-list button")]
        .some((button) => button.textContent === "Delete?"),
      { timeout: 15_000 },
    );
    assert.equal(await page.$eval("#saved-work-count", (element) => element.textContent), "2");
    await clickSavedAction(page, "#saved-query-list", "XML marker query renamed", "Delete?");
    await page.waitForFunction(
      () => document.querySelector("#saved-work-count")?.textContent === "1",
      { timeout: 15_000 },
    );
    assert.equal(await page.$eval("#saved-query-count", (element) => element.textContent), "0");
    await page.click("#close-saved-work");
  });

  if (options.assistant) {
    await runStep(`ask the local assistant ${options.assistantQuestions === 1 ? "once" : "twice"} and run its terminal queries`, async () => {
      await page.click("#demo-button");
      await assertDocumentReady(page, "Discogs releases", 600_000);
      const questions = [
        "Which Electronic artists span the most releases, tracks, labels, and styles?",
        "Which artists have the most Electronic releases? Include track and label totals.",
      ].slice(0, options.assistantQuestions);
      for (const question of questions) {
        const userSqlBefore = await page.$eval("#sql-output", (element) => element.value);
        const messageCount = await page.$$eval("#schema-chat .chat-message", (messages) => messages.length);
        await replaceInput(page, "#ask-input", question);
        await page.click("#chat-button");
        await page.waitForFunction((previousMessages) => {
          const title = document.querySelector("#builder-title")?.textContent || "";
          const answer = document.querySelector("#schema-chat")?.textContent || "";
          const messages = document.querySelectorAll("#schema-chat .chat-message").length;
          return messages >= previousMessages + 2
            && title === "Query ready · report updated"
            && Boolean(document.querySelector("#result-wrap table"))
            && !answer.includes("needs another pass");
        }, { timeout: 1_800_000 }, messageCount);
        const editors = await page.evaluate(() => ({
          userSql: document.querySelector("#sql-output")?.value || "",
          userReadOnly: document.querySelector("#sql-output")?.readOnly,
          userDisabled: document.querySelector("#sql-output")?.disabled,
          agentSql: document.querySelector("#agent-sql-output")?.value || "",
          agentReadOnly: document.querySelector("#agent-sql-output")?.readOnly,
          agentRunDisabled: document.querySelector("#run-agent-button")?.disabled,
          assistantMessage: [...document.querySelectorAll("#schema-chat .chat-message.assistant p")]
            .at(-1)?.textContent || "",
        }));
        assert.equal(editors.userSql, userSqlBefore, "Folio replaced the user's SQL.");
        assert.equal(editors.userReadOnly, false, "The user's SQL editor became read only.");
        assert.equal(editors.userDisabled, false, "The user's SQL editor became unavailable.");
        assert.match(editors.agentSql, /^\s*(WITH|SELECT)\b/i);
        assert.equal(editors.agentReadOnly, true, "Folio's SQL output must stay read only.");
        assert.equal(editors.agentRunDisabled, false, "Folio's completed SQL should be runnable.");
        assert.match(editors.assistantMessage, /query|report/i);
        assert.doesNotMatch(editors.assistantMessage, /\d[\d,]*\s+(?:releases|tracks|labels)/i);
      }
      await page.screenshot({ path: join(screenshots, "04-assistant-result-desktop.png"), fullPage: true });
    });
  }

  await runStep("show saved work cleanly on mobile", async () => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await openSavedWorkLibrary(page);
    const bounds = await page.$eval("#saved-work-dialog", (dialog) => {
      const rectangle = dialog.getBoundingClientRect();
      return {
        left: rectangle.left,
        right: rectangle.right,
        width: rectangle.width,
        viewport: window.innerWidth,
      };
    });
    assert.ok(bounds.left >= 0, `Dialog starts outside the viewport: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.right <= bounds.viewport + 1, `Dialog ends outside the viewport: ${JSON.stringify(bounds)}`);
    await page.screenshot({ path: join(screenshots, "05-saved-work-mobile.png"), fullPage: false });
    await page.click("#close-saved-work");
    const pageWidth = await page.evaluate(() => ({
      content: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    assert.ok(pageWidth.content <= pageWidth.viewport + 1, `Page overflows: ${JSON.stringify(pageWidth)}`);
    await page.screenshot({ path: join(screenshots, "06-workspace-mobile.png"), fullPage: true });
  });

  await runStep("surface the saved-work storage limit", async () => {
    await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
    await page.evaluate(() => {
      const largeSql = `SELECT '${"x".repeat(1_124_700)}';`;
      const dates = ["2026-08-23T10:00:00.000Z", "2026-08-23T11:00:00.000Z"];
      const items = dates.map((date, index) => ({
        version: 1,
        id: `limit-${index}`,
        kind: "query",
        title: `Large saved query ${index + 1}`,
        documentLabel: "limit.json",
        question: "Storage limit test",
        sql: largeSql,
        report: null,
        createdAt: date,
        updatedAt: date,
      }));
      localStorage.setItem("folio.saved-work.v1", JSON.stringify(items));
    });
    await page.click("#save-query");
    await page.waitForSelector("#saved-work-form:not([hidden])");
    await replaceInput(page, "#saved-work-name", "One more query");
    await page.click("#confirm-save-work");
    await page.waitForFunction(
      () => !document.querySelector("#saved-work-error")?.hidden,
      { timeout: 15_000 },
    );
    assert.match(
      await page.$eval("#saved-work-error", (element) => element.textContent),
      /Saved work is full/,
    );
    await page.screenshot({ path: join(screenshots, "07-storage-limit-desktop.png"), fullPage: false });
  });

  await runStep("check browser diagnostics", async () => {
    assert.deepEqual(report.pageErrors, [], `Page errors: ${JSON.stringify(report.pageErrors, null, 2)}`);
    assert.deepEqual(report.failedResponses, [], `Failed responses: ${JSON.stringify(report.failedResponses, null, 2)}`);
    const actionableRequests = report.failedRequests.filter(
      (request) => !/ERR_ABORTED|NS_BINDING_ABORTED/.test(request.error || ""),
    );
    assert.deepEqual(actionableRequests, [], `Failed requests: ${JSON.stringify(actionableRequests, null, 2)}`);
    const consoleErrors = report.console.filter((entry) => entry.type === "error");
    assert.deepEqual(consoleErrors, [], `Console errors: ${JSON.stringify(consoleErrors, null, 2)}`);
  });

  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = { message: error.message, stack: error.stack };
  if (page) {
    await page.screenshot({ path: join(screenshots, "failure.png"), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close().catch(() => {});
  if (server) server.kill("SIGTERM");
  process.stdout.write(`Browser report: ${join(output, "report.json")}\n`);
}

async function runStep(name, action) {
  if (options.onlyCsv && name !== "open Folio" && name !== "check browser diagnostics" && !name.startsWith("import CSV")) return;
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

function parseOptions(argumentsList) {
  const value = (name) => {
    const inline = argumentsList.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = argumentsList.indexOf(name);
    return index >= 0 ? argumentsList[index + 1] : "";
  };
  return {
    url: value("--url") || process.env.FOLIO_URL || "https://folio.wavey.ai/",
    output: value("--output") || process.env.FOLIO_BROWSER_OUTPUT || "",
    profile: value("--profile") || process.env.FOLIO_BROWSER_PROFILE || "",
    chrome: value("--chrome") || process.env.CHROME_PATH
      || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    assistant: !argumentsList.includes("--skip-assistant")
      && process.env.FOLIO_ASSISTANT !== "0",
    assistantQuestions: argumentsList.includes("--assistant-once") ? 1 : 2,
    headed: argumentsList.includes("--headed") || process.env.FOLIO_HEADED === "1",
    onlyCsv: argumentsList.includes("--only-csv"),
  };
}

async function startLocalServerWhenNeeded(url) {
  const target = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(target.hostname)) return null;
  if (await responds(url)) return null;
  const child = spawn(process.execPath, ["scripts/serve-web.mjs"], {
    cwd: root,
    env: { ...process.env, FOLIO_PORT: target.port || "8000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await responds(url)) return child;
    await delay(200);
  }
  child.kill("SIGTERM");
  throw new Error(`Folio did not start at ${url}.`);
}

async function responds(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function captureBrowserDiagnostics(activePage, target) {
  activePage.on("console", (message) => {
    const entry = {
      at: new Date().toISOString(),
      type: message.type(),
      text: message.text(),
      location: message.location(),
    };
    target.console.push(entry);
    if (["error", "warning"].includes(entry.type)) {
      process.stderr.write(`[browser ${entry.type}] ${entry.text}\n`);
    }
  });
  activePage.on("pageerror", (error) => {
    target.pageErrors.push({ message: error.message, stack: error.stack });
  });
  activePage.on("requestfailed", (request) => {
    target.failedRequests.push({
      url: request.url(),
      method: request.method(),
      error: request.failure()?.errorText || "Request failed",
    });
  });
  activePage.on("response", (response) => {
    if (response.status() < 400) return;
    target.failedResponses.push({
      url: response.url(),
      status: response.status(),
      statusText: response.statusText(),
    });
  });
}

async function waitForApplication(activePage) {
  await activePage.waitForSelector("#engine-state.ready", { timeout: 120_000 });
  await activePage.waitForFunction(
    () => [
      "Ready for a document",
      "Previous workspace restored",
      "Workspace resumed",
    ].includes(document.querySelector("#activity-title")?.textContent),
    { timeout: 600_000 },
  );
}

async function uploadDocument(activePage, path, label) {
  await activePage.$eval("#file-input", (input) => { input.value = ""; });
  const input = await activePage.$("#file-input");
  assert.ok(input, "The document file input is available.");
  await input.uploadFile(path);
  await activePage.waitForFunction(
    (expected) => document.querySelector("#document-status")?.textContent.includes(expected),
    { timeout: 30_000 },
    label,
  );
}

async function assertDocumentReady(activePage, label, timeout = 240_000) {
  await activePage.waitForFunction((expected) => {
    const status = document.querySelector("#document-status")?.textContent || "";
    const preparation = document.querySelector("#document-prep");
    return preparation?.getAttribute("aria-busy") === "false"
      && status.includes(expected)
      && status.includes(" values.");
  }, { timeout }, label);
  const status = await activePage.$eval("#document-status", (element) => element.textContent);
  assert.doesNotMatch(status, /needs attention|Review/i);
}

async function runSql(activePage, sql, firstCell) {
  assert.equal(await runSqlAndReadFirstCell(activePage, sql), firstCell);
}

async function runSqlAndReadFirstCell(activePage, sql) {
  await activePage.$eval("#sql-output", (element, value) => {
    element.value = value.trim();
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, sql);
  await activePage.evaluate(() => {
    window.__folioBrowserResultObserver?.disconnect();
    window.__folioBrowserResultMutations = 0;
    window.__folioBrowserResultObserver = new MutationObserver(() => {
      window.__folioBrowserResultMutations += 1;
    });
    window.__folioBrowserResultObserver.observe(
      document.querySelector("#result-wrap"),
      { childList: true, subtree: true, characterData: true },
    );
  });
  await activePage.click("#run-button");
  await activePage.waitForFunction(() => {
    const firstCell = document.querySelector("#result-wrap tbody td")?.textContent;
    const runButton = document.querySelector("#run-button");
    return window.__folioBrowserResultMutations > 0
      && typeof firstCell === "string"
      && runButton
      && !runButton.disabled;
  }, { timeout: 180_000 });
  const value = await activePage.$eval("#result-wrap tbody td", (cell) => cell.textContent);
  await activePage.evaluate(() => window.__folioBrowserResultObserver?.disconnect());
  return value;
}

async function waitForFirstResult(activePage, value) {
  await activePage.waitForFunction((expected) => {
    const firstCell = document.querySelector("#result-wrap tbody td")?.textContent;
    const runButton = document.querySelector("#run-button");
    return firstCell === expected && runButton && !runButton.disabled;
  }, { timeout: 180_000 }, value);
}

async function saveCurrentWork(activePage, kind, name, expectedCount) {
  await activePage.click(kind === "report" ? "#save-report" : "#save-query");
  await activePage.waitForSelector("#saved-work-form:not([hidden])");
  await replaceInput(activePage, "#saved-work-name", name);
  await activePage.click("#confirm-save-work");
  await activePage.waitForFunction(
    (count) => document.querySelector("#saved-work-count")?.textContent === String(count)
      && document.querySelector("#saved-work-form")?.hidden,
    { timeout: 15_000 },
    expectedCount,
  );
  if (kind === "query") await activePage.click("#close-saved-work");
}

async function replaceInput(activePage, selector, value) {
  await activePage.$eval(selector, (element, nextValue) => {
    element.value = nextValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function waitForDialog(activePage) {
  await activePage.waitForFunction(
    () => document.querySelector("#saved-work-dialog")?.open,
    { timeout: 15_000 },
  );
}

async function openSavedWorkLibrary(activePage) {
  await activePage.evaluate(() => {
    const previousBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, 0);
    window.dispatchEvent(new Event("scroll"));
    document.querySelector("#saved-work-button")?.click();
    document.documentElement.style.scrollBehavior = previousBehavior;
  });
  await waitForDialog(activePage);
}

async function clickSavedAction(activePage, listSelector, title, action) {
  const clicked = await activePage.evaluate((selector, itemTitle, actionLabel) => {
    const item = [...document.querySelectorAll(`${selector} .saved-work-item`)]
      .find((candidate) => candidate.querySelector("strong")?.textContent === itemTitle);
    const button = [...(item?.querySelectorAll("button") || [])]
      .find((candidate) => candidate.textContent === actionLabel);
    button?.click();
    return Boolean(button);
  }, listSelector, title, action);
  assert.equal(clicked, true, `${action} is available for ${title}.`);
}

async function waitForDownload(directory, existing) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const files = await readdir(directory);
    const finished = files.find((file) => !existing.has(file) && !file.endsWith(".crdownload"));
    if (finished && !files.includes(`${finished}.crdownload`)) return finished;
    await delay(100);
  }
  throw new Error("The CSV download did not finish.");
}

async function writeFixtures(directory) {
  const deepJson = {};
  let cursor = deepJson;
  for (let depth = 0; depth < 36; depth += 1) {
    cursor[`level_${depth}`] = {};
    cursor = cursor[`level_${depth}`];
  }
  cursor.marker = "DEEPLY_NESTED_JSON";
  const json = {
    marker: "JSON_ONLY_MARKER",
    emptyArray: [],
    emptyObject: {},
    nullable: null,
    enabled: true,
    largeNumber: 9007199254740993,
    unicode: "Björk 東京 🎵",
    repeated: { name: "parent", child: { name: "child" } },
    records: [
      { id: "one", values: [1, 2, 3], active: false },
      { id: "two", values: [], active: true },
    ],
    deep: deepJson,
  };
  const deepOpen = Array.from({ length: 34 }, (_, index) => `<level index="${index}">`).join("");
  const deepClose = Array.from({ length: 34 }, () => "</level>").join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<catalog xmlns="urn:folio:test" xmlns:meta="urn:folio:meta" id="catalog-1" meta:kind="music">
  <marker>XML_ONLY_MARKER</marker>
  <release id="r1"><title>Björk &amp; 東京</title><artist role="primary">Björk</artist><note><![CDATA[Mix <one> & two]]></note></release>
  <release id="r2"><title>Second</title><artist>Another</artist><artist>Guest</artist><empty/><mixed>Before <strong>inside</strong> after</mixed></release>
  <deep>${deepOpen}<value>DEEPLY_NESTED_XML</value>${deepClose}</deep>
</catalog>`;
  const replacement = {
    marker: "REPLACEMENT_ONLY_MARKER",
    customers: [
      { name: "Jam Cafe", orders: [{ total: 130, date: "2026-08-20" }] },
      { name: "Leaf Shop", orders: [{ total: 45, date: "2026-08-21" }] },
    ],
  };
  const paths = {
    csv: join(directory, "flat.csv"),
    json: join(directory, "complex.json"),
    xml: join(directory, "complex.xml"),
    replacement: join(directory, "replacement.json"),
  };
  await Promise.all([
    writeFile(paths.csv, '\uFEFFname,account,note\r\n"Jam, Cafe",00123,"Said ""hello""\nagain"\r\nLeaf Shop,9007199254740993,\r\n'),
    writeFile(paths.json, `${JSON.stringify(json, null, 2)}\n`),
    writeFile(paths.xml, `${xml}\n`),
    writeFile(paths.replacement, `${JSON.stringify(replacement, null, 2)}\n`),
  ]);
  return paths;
}

async function downloadWebFixtures(directory, diagnostics) {
  const sources = [
    {
      key: "jsonBenchmark",
      url: "https://media.githubusercontent.com/media/antonmedv/json-examples/master/data_10mb.json",
      file: "jsonbenchmark.json",
      format: "json",
      minimumBytes: 10_000_000,
    },
    {
      key: "musicBrainzXml",
      url: "https://musicbrainz.org/ws/2/recording/?query=artist%3ABjork&limit=100&fmt=xml",
      file: "musicbrainzxml.xml",
      format: "xml",
      minimumBytes: 100_000,
    },
    {
      key: "musicBrainzJson",
      url: "https://musicbrainz.org/ws/2/recording/?query=artist%3ABjork&limit=100&fmt=json",
      file: "musicbrainzjson.json",
      format: "json",
      minimumBytes: 100_000,
    },
    {
      key: "metsProfile",
      url: "https://www.loc.gov/standards/mets/profiles/00000020.xml",
      file: "metsprofile.xml",
      format: "xml",
      minimumBytes: 5_000,
    },
  ];
  const downloaded = {};
  for (const source of sources) {
    const bytes = await downloadWebSource(source);
    const path = join(directory, source.file);
    await writeFile(path, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    diagnostics.push({
      url: source.url,
      file: source.file,
      bytes: bytes.byteLength,
      sha256: digest,
    });
    downloaded[source.key] = {
      path,
      label: source.file,
      source: source.file.replace(/\.(json|xml)$/i, ""),
    };
    if (source.url.includes("musicbrainz.org")) await delay(1_100);
  }
  return downloaded;
}

async function downloadWebSource(source) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(source.url, {
        headers: {
          "User-Agent": "Folio/1.0 (https://folio.wavey.ai; jamie@wavey.ai)",
          Accept: source.format === "json" ? "application/json" : "application/xml,text/xml",
        },
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength < source.minimumBytes) {
        throw new Error(`${bytes.byteLength} bytes; expected at least ${source.minimumBytes}`);
      }
      const text = bytes.toString("utf8").trimStart();
      if (source.format === "json") JSON.parse(text);
      else if (!text.startsWith("<")) throw new Error("The response is not XML.");
      process.stdout.write(`Downloaded ${source.file} (${bytes.byteLength.toLocaleString()} bytes)\n`);
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await delay(attempt * 1_000);
    }
  }
  throw new Error(`Could not download ${source.url}: ${lastError?.message || "unknown error"}`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
