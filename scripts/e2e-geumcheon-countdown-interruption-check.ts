import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

type FairnessStage = {
  stageNumber: number;
  textId: string;
  catalogVersion: string;
  targetText: string;
  typedText: string;
  userTimeMs: number;
  typingUnits: number;
  aiCpm: number;
  result: string;
};

type FairnessRecord = {
  fairness?: { catalogVersion: string; stages: FairnessStage[] };
};

const root = process.cwd();
const artifactRoot = path.resolve("test_artifacts", "geumcheon_countdown_interruption_e2e");
const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const mainJs = path.join(root, "dist-electron", "electron", "main.js");
const devServerUrl = "http://127.0.0.1:4174";
const eventConfig = JSON.parse(fs.readFileSync(path.join(root, "events", "geumcheon-2026", "event.config.json"), "utf8"));
const debugProgress = process.env.E2E_DEBUG_PROGRESS === "1";

function progress(message: string): void {
  if (!debugProgress) return;
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.appendFileSync(path.join(artifactRoot, "progress.log"), `${new Date().toISOString()} ${message}\n`);
}

async function removeScenarioDir(dir: string): Promise<void> {
  const timeoutAt = Date.now() + 5000;
  let lastError: unknown;
  while (Date.now() < timeoutAt) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Failed to remove temporary scenario directory: ${dir}${lastError instanceof Error ? ` (${lastError.message})` : ""}`);
}

async function closeElectron(app: Awaited<ReturnType<typeof electron.launch>>, appProcess: ChildProcess): Promise<void> {
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 5000))]).catch(() => undefined);
  if (appProcess.exitCode === null && appProcess.signalCode === null) appProcess.kill();
  const timeoutAt = Date.now() + 5000;
  while (appProcess.exitCode === null && appProcess.signalCode === null && Date.now() < timeoutAt) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (appProcess.exitCode === null && appProcess.signalCode === null) {
    throw new Error(`Electron process ${appProcess.pid} did not exit during cleanup`);
  }
}

function cleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function writeDeviceProfile(dir: string): void {
  fs.writeFileSync(path.join(dir, "device-profile.json"), `${JSON.stringify({
    schemaVersion: 1,
    eventProfileId: "geumcheon-2026",
    eventId: "geumcheon-science-festival-2026",
    deviceId: "PC01",
    role: "player",
    apiBaseUrl: "https://records.example.test",
    sessions: {
      official: { sessionId: "e2e-official", dayNo: 1, roundNo: 1 },
      practice: { sessionId: "e2e-practice" }
    },
    requestTimeoutMs: 5000,
    retry: { initialDelayMs: 2000, maxDelayMs: 60000 }
  }, null, 2)}\n`, "utf8");
}

async function startDevServer(): Promise<ChildProcess> {
  const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
  progress("Vite: spawning");
  const server = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", "4174", "--strictPort"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  server.stdout?.on("data", (chunk) => progress(`Vite stdout ${String(chunk).trim()}`));
  server.stderr?.on("data", (chunk) => progress(`Vite stderr ${String(chunk).trim()}`));
  server.once("exit", (code, signal) => progress(`Vite exited code=${code} signal=${signal}`));
  const timeoutAt = Date.now() + 15000;
  while (Date.now() < timeoutAt) {
    try {
      const response = await fetch(devServerUrl);
      if (response.ok) {
        progress(`Vite: ready status=${response.status}`);
        return server;
      }
    } catch {
      // The Vite process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  server.kill();
  throw new Error("Vite renderer server did not start");
}

async function waitForJson(dir: string): Promise<string> {
  const timeoutAt = Date.now() + 12000;
  while (Date.now() < timeoutAt) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
    if (files.length > 0) return path.join(dir, files[0]);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Interrupted Geumcheon record was not written: ${dir}`);
}

async function waitForRunningStage(page: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>["firstWindow"]>>): Promise<void> {
  await page.locator(".countdown-overlay").waitFor({ state: "visible", timeout: 7000 });
  await page.locator(".countdown-overlay").waitFor({ state: "hidden", timeout: 7000 });
}

async function completeCurrentStage(page: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>["firstWindow"]>>): Promise<void> {
  await waitForRunningStage(page);
  const targetLocator = page.locator(".duel-target").first();
  const allTextareas = page.locator("textarea");
  const textareaLocator = page.locator("textarea:visible").first();
  const target = (await targetLocator.textContent()) ?? "";
  const filledText = target.replace(/\u00a0/g, " ").trim();
  await textareaLocator.fill(filledText);
  const textareaCount = await allTextareas.count();
  const textareaVisible = await Promise.all(
    Array.from({ length: textareaCount }, (_, index) => allTextareas.nth(index).isVisible())
  );
  const typedValue = await textareaLocator.inputValue();
  progress(`stage completion input ${JSON.stringify({
    displayedTarget: target,
    normalizedTarget: filledText,
    typedValue,
    exactTargetMatch: typedValue === filledText,
    textareaCount,
    textareaVisible,
    modalVisible: await page.locator(".challenge-modal").isVisible(),
    screenVisible: await page.locator(".challenge-screen").isVisible()
  })}`);
  await page.locator(".challenge-modal").waitFor({ state: "visible", timeout: 7000 });
  await page.getByRole("button", { name: "다음 스테이지" }).click();
}

async function runCountdownInterruption(terminalStage: 1 | 2 | 3): Promise<FairnessRecord> {
  const scenarioRoot = path.join(os.tmpdir(), "typingking-geumcheon-countdown-interruption-e2e", `stage-${terminalStage}`);
  const runtimeRoot = path.join(scenarioRoot, "runtime");
  const oneDriveRoot = path.join(scenarioRoot, "onedrive");
  await removeScenarioDir(scenarioRoot);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(oneDriveRoot, { recursive: true });
  writeDeviceProfile(scenarioRoot);
  progress(`stage-${terminalStage}: launching Electron`);
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let appProcess: ChildProcess | undefined;
  try {
    try {
      app = await electron.launch({
      executablePath: electronExe,
      // The renderer regression runs on GPU-less automation hosts as well as on Windows desktops.
      args: ["--disable-gpu", mainJs, "--variant=ai"],
      timeout: 15000,
      env: {
        ...process.env,
        APP_VARIANT: "ai",
        EVENT_PROFILE: "geumcheon-2026",
        PORTABLE_EXECUTABLE_DIR: scenarioRoot,
        TYPINGKING_RUNTIME_ROOT: runtimeRoot,
        VITE_DEV_SERVER_URL: devServerUrl,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
      }
      });
      progress(`stage-${terminalStage}: Electron launch resolved`);
    } catch (error) {
      progress(`stage-${terminalStage}: Electron launch rejected ${error instanceof Error ? error.stack || error.message : String(error)}`);
      throw error;
    }
    appProcess = app.process();
    progress(`stage-${terminalStage}: Electron launched pid=${appProcess.pid}`);
    const page = await app.firstWindow({ timeout: 15000 });
    page.on("console", (message) => progress(`stage-${terminalStage}: console ${message.type()} ${message.text()}`));
    page.on("pageerror", (error) => progress(`stage-${terminalStage}: pageerror ${error.stack || error.message}`));
    progress(`stage-${terminalStage}: first window url=${page.url()}`);
    progress(`stage-${terminalStage}: document ${JSON.stringify(await page.evaluate(() => ({
      readyState: document.readyState,
      body: document.body?.innerText.slice(0, 500),
      entryPanels: document.querySelectorAll(".entry-panel").length,
      challengeScreens: document.querySelectorAll(".challenge-screen").length,
      countdowns: document.querySelectorAll(".countdown-overlay").length
    })))}`);
    await page.evaluate(async (rootPath) => {
      const api = (window as any).typingKing;
      await api.updateOneDriveSettings({
        syncMode: "onedrive_manual",
        pcRole: "player",
        pcId: "PC01",
        oneDriveRoot: rootPath,
        recordBaseFolderName: "Geumcheon_Countdown_E2E",
        dayNo: 1,
        roundNo: 1
      });
      await api.validateOneDriveSetup();
    }, oneDriveRoot);
    progress(`stage-${terminalStage}: OneDrive settings validated`);

    await page.locator(".entry-panel .field input").first().fill("E2E");
    await page.locator(".phone-row select").selectOption("010");
    await page.locator(".phone-row input").nth(0).fill("0000");
    await page.locator(".phone-row input").nth(1).fill("0000");
    await page.locator(".birth-row select").nth(0).selectOption("2000");
    await page.locator(".birth-row select").nth(1).selectOption("1");
    await page.locator(".birth-row select").nth(2).selectOption("1");
    await page.locator(".check-line input").check();
    await page.locator(".entry-panel .button-row .primary-button").first().click();
    progress(`stage-${terminalStage}: entry submitted`);
    await page.locator(".challenge-screen").waitFor({ state: "visible", timeout: 15000 });
    progress(`stage-${terminalStage}: challenge screen visible`);

    for (let stage = 1; stage < terminalStage; stage += 1) await completeCurrentStage(page);

    const countdown = page.locator(".countdown-overlay");
    await countdown.waitFor({ state: "visible", timeout: 7000 });
    progress(`stage-${terminalStage}: target countdown visible value=${JSON.stringify(await countdown.innerText())}`);
    assert.match(await countdown.innerText(), /^[123]$/);
    await page.locator(".game-main-button").click();
    progress(`stage-${terminalStage}: interruption requested`);
    await page.locator(".game-confirm-modal").waitFor({ state: "visible", timeout: 3000 });
    await page.locator(".game-confirm-modal .primary-button").click();
    progress(`stage-${terminalStage}: interruption confirmed`);
    await page.locator(".entry-panel").waitFor({ state: "visible", timeout: 12000 });

    const incoming = path.join(oneDriveRoot, "Geumcheon_Countdown_E2E", "1일차", "1회차", "incoming", "ai");
    const jsonPath = await waitForJson(incoming);
    progress(`stage-${terminalStage}: record found ${jsonPath}`);
    return JSON.parse(fs.readFileSync(jsonPath, "utf8")) as FairnessRecord;
  } finally {
    let cleanupError: unknown;
    if (app) {
      progress(`stage-${terminalStage}: closing Electron`);
      try {
        await closeElectron(app, appProcess!);
      } catch (error) {
        cleanupError = error;
        progress(`stage-${terminalStage}: Electron cleanup failed ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await removeScenarioDir(scenarioRoot);
      progress(`stage-${terminalStage}: Electron and temp scenario cleaned`);
    } catch (error) {
      cleanupError = cleanupError || error;
      progress(`stage-${terminalStage}: temp scenario cleanup failed ${error instanceof Error ? error.message : String(error)}`);
    }
    if (cleanupError) throw cleanupError;
  }
}

async function main(): Promise<void> {
  cleanDir(artifactRoot);
  let devServer: ChildProcess | undefined;
  try {
    devServer = await startDevServer();
    const requestedStage = process.env.E2E_STAGE ? Number(process.env.E2E_STAGE) : undefined;
    const terminalStages: Array<1 | 2 | 3> = requestedStage === undefined ? [1, 2, 3] : [requestedStage as 1 | 2 | 3];
    for (const terminalStage of terminalStages) {
      assert.ok(terminalStage === 1 || terminalStage === 2 || terminalStage === 3, "E2E_STAGE must be 1, 2, or 3");
      const record = await runCountdownInterruption(terminalStage);
      const fairness = record.fairness;
      assert.ok(fairness, `stage ${terminalStage}: fairness payload is missing`);
      assert.equal(fairness.stages.length, terminalStage);
      assert.equal(fairness.catalogVersion, eventConfig.stageTextCatalogVersion);
      fairness.stages.forEach((stage, index) => {
        const stageNumber = index + 1;
        const range = eventConfig.aiChallenge.official.stageSpeedRanges[`stage${stageNumber}`];
        assert.equal(stage.stageNumber, stageNumber);
        assert.match(stage.textId, new RegExp(`^gsc26-ai-s${stageNumber}-\\d{3}$`));
        assert.equal(stage.catalogVersion, eventConfig.stageTextCatalogVersion);
        assert.ok(stage.aiCpm >= range.min && stage.aiCpm <= range.max, `stage ${stageNumber}: planned CPM ${stage.aiCpm} outside configured range`);
      });
      assert.equal(fairness.stages.at(-1)?.result, "INTERRUPTED");
    }
    console.log(JSON.stringify({ pass: 3, fail: 0, cleanup: artifactRoot }, null, 2));
  } finally {
    if (devServer && !devServer.killed) devServer.kill();
    if (!debugProgress) fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  if (debugProgress) {
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.appendFileSync(path.join(artifactRoot, "progress.log"), `${new Date().toISOString()} failure ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  }
  console.error(error);
  process.exitCode = 1;
});
