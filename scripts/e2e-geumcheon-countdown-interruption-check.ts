import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type Page } from "playwright-core";
import {
  buildForcedExitChildEnvironment,
  type CapturedRecordEnvelope,
  startLocalHealthServer,
  stopHttpsServer,
  writeSyntheticProfiles
} from "./e2e-geumcheon-forced-exit-check";

const root = process.cwd();

export function resolveCountdownArtifactRoot(
  environment: Record<string, string | undefined> = process.env,
  projectRoot = root
): string {
  return resolveExplicitR2ArtifactRoot("geumcheon_countdown_interruption_e2e", environment, projectRoot);
}

function resolveExplicitR2ArtifactRoot(
  defaultName: string,
  environment: Record<string, string | undefined>,
  projectRoot: string
): string {
  const base = path.resolve(projectRoot);
  const override = environment.TYPINGKING_E2E_ARTIFACT_ROOT?.trim();
  if (!override) return path.join(base, "test_artifacts", defaultName);

  const resolved = path.resolve(path.isAbsolute(override) ? override : path.join(base, override));
  const allowedRoot = path.join(base, "test_artifacts", "R2");
  const relative = path.relative(allowedRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("TYPINGKING_E2E_ARTIFACT_ROOT must resolve under test_artifacts/R2/<run-name>");
  }
  return resolved;
}

const artifactRoot = resolveCountdownArtifactRoot(process.env, root);
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

export function writeCountdownDeviceProfile(
  dir: string,
  apiBaseUrl = "https://records.example.test"
): void {
  writeSyntheticProfiles(dir, apiBaseUrl);
}

export function shouldKeepCountdownEvidence(
  environment: Record<string, string | undefined> = process.env,
  resolvedArtifactRoot = artifactRoot,
  projectRoot = root
): boolean {
  if (environment.TYPINGKING_E2E_KEEP_EVIDENCE !== "1") return false;
  if (!environment.TYPINGKING_E2E_ARTIFACT_ROOT?.trim()) return false;
  const base = path.resolve(projectRoot);
  const allowedRoot = path.join(base, "test_artifacts", "R2");
  const relative = path.relative(allowedRoot, path.resolve(resolvedArtifactRoot));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
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

async function writeCountdownDiagnostic(page: Page, terminalStage: 1 | 2 | 3, label: string): Promise<void> {
  fs.mkdirSync(path.join(artifactRoot, "diagnostics"), { recursive: true });
  const diagnostic = await page.evaluate(async () => {
    const api = (window as any).typingKing;
    const bootstrap = api?.getBootstrap
      ? await api.getBootstrap().catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      : { ok: false, error: "typingKing IPC API unavailable" };
    const bootstrapData = bootstrap?.ok ? bootstrap.data : undefined;
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      bodyText: document.body?.innerText.slice(0, 1500) || "",
      selectors: {
        entryPanel: document.querySelectorAll(".entry-panel").length,
        entryPanelVisibleInput: document.querySelectorAll(".entry-panel .field input").length,
        phoneSelect: document.querySelectorAll(".phone-row select").length,
        phoneInput: document.querySelectorAll(".phone-row input").length,
        birthSelect: document.querySelectorAll(".birth-row select").length,
        checkLineInput: document.querySelectorAll(".check-line input").length,
        challengeScreen: document.querySelectorAll(".challenge-screen").length,
        fallback: document.querySelectorAll(".empty-state, .app-fallback").length
      },
      bootstrap: bootstrap?.ok ? {
        variant: bootstrapData?.variant,
        mode: bootstrapData?.mode,
        eventProfileId: bootstrapData?.eventProfile?.profileId,
        deviceId: bootstrapData?.deviceProfile?.deviceId,
        deviceRole: bootstrapData?.deviceProfile?.role,
        syncMode: bootstrapData?.config?.syncMode,
        pcRole: bootstrapData?.config?.pcRole,
        pcId: bootstrapData?.config?.pcId,
        recordBaseFolderName: bootstrapData?.config?.recordBaseFolderName,
        dayNo: bootstrapData?.config?.dayNo,
        roundNo: bootstrapData?.config?.roundNo
      } : bootstrap
    };
  }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  const base = path.join(artifactRoot, "diagnostics", `stage-${terminalStage}-${label}`);
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
  await page.screenshot({ path: `${base}.png`, fullPage: false }).catch(() => undefined);
}

async function waitForCountdownEntryPanel(page: Page, terminalStage: 1 | 2 | 3): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).typingKing), undefined, { timeout: 15000 });
  await page.locator(".entry-panel").first().waitFor({ state: "visible", timeout: 45000 }).catch(async (error) => {
    await writeCountdownDiagnostic(page, terminalStage, "entry-panel-timeout").catch(() => undefined);
    const diagnostic = await page.evaluate(() => ({
      readyState: document.readyState,
      body: document.body?.innerText.slice(0, 1000),
      entryPanels: document.querySelectorAll(".entry-panel").length,
      challengeScreens: document.querySelectorAll(".challenge-screen").length,
      fallbackScreens: document.querySelectorAll(".empty-state, .app-fallback").length
    })).catch((caught) => ({ error: caught instanceof Error ? caught.message : String(caught) }));
    progress(`stage-${terminalStage}: entry panel wait failed ${JSON.stringify(diagnostic)}`);
    throw error;
  });
}

async function waitForCapturedCountdownRecord(
  capturedRecords: CapturedRecordEnvelope[],
  outboxPendingDir: string,
  page: Page,
  terminalStage: 1 | 2 | 3
): Promise<CapturedRecordEnvelope> {
  const timeoutAt = Date.now() + 12000;
  while (Date.now() < timeoutAt) {
    const pendingFiles = fs.existsSync(outboxPendingDir) ? fs.readdirSync(outboxPendingDir) : [];
    if (capturedRecords[0] && pendingFiles.length === 0) return capturedRecords[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeCountdownDiagnostic(page, terminalStage, "save-record-timeout").catch(() => undefined);
  throw new Error("Interrupted Geumcheon NAS record POST was not captured");
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

async function runCountdownInterruption(terminalStage: 1 | 2 | 3): Promise<CapturedRecordEnvelope> {
  const scenarioRoot = path.join(os.tmpdir(), "typingking-geumcheon-countdown-interruption-e2e", `stage-${terminalStage}`);
  const runtimeRoot = path.join(scenarioRoot, "runtime");
  await removeScenarioDir(scenarioRoot);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  let readinessServer: Awaited<ReturnType<typeof startLocalHealthServer>> | undefined;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let appProcess: ChildProcess | undefined;
  try {
    readinessServer = await startLocalHealthServer(path.join(scenarioRoot, "certs"), { captureRecords: true });
    writeCountdownDeviceProfile(scenarioRoot, readinessServer.apiBaseUrl);
    progress(`stage-${terminalStage}: launching Electron`);
    try {
      app = await electron.launch({
      executablePath: electronExe,
      // The renderer regression runs on GPU-less automation hosts as well as on Windows desktops.
      args: ["--disable-gpu", mainJs, "--variant=ai"],
      timeout: 15000,
      env: buildForcedExitChildEnvironment({
        APP_VARIANT: "ai",
        EVENT_PROFILE: "geumcheon-2026",
        PORTABLE_EXECUTABLE_DIR: scenarioRoot,
        TYPINGKING_RUNTIME_ROOT: runtimeRoot,
        VITE_DEV_SERVER_URL: devServerUrl,
        NODE_EXTRA_CA_CERTS: readinessServer.caPemPath,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
      })
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
    await writeCountdownDiagnostic(page, terminalStage, "after-first-window");
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
    await waitForCountdownEntryPanel(page, terminalStage);

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

    const envelope = await waitForCapturedCountdownRecord(
      readinessServer.capturedRecords,
      path.join(runtimeRoot, "nas", "outbox", "official", "pending"),
      page,
      terminalStage
    );
    progress(`stage-${terminalStage}: authenticated NAS record POST acknowledged and outbox flushed`);
    return envelope;
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
      await stopHttpsServer(readinessServer?.server);
    } catch (error) {
      cleanupError = cleanupError || error;
      progress(`stage-${terminalStage}: HTTPS server cleanup failed ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await removeScenarioDir(scenarioRoot);
      progress(`stage-${terminalStage}: Electron, HTTPS server, and temp scenario cleaned`);
    } catch (error) {
      cleanupError = cleanupError || error;
      progress(`stage-${terminalStage}: temp scenario cleanup failed ${error instanceof Error ? error.message : String(error)}`);
    }
    if (cleanupError) throw cleanupError;
  }
}

type CountdownResult = {
  terminalStage: 1 | 2 | 3;
  envelope: CapturedRecordEnvelope;
};

function writeCountdownReport(results: CountdownResult[]): void {
  fs.mkdirSync(artifactRoot, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    artifactRoot,
    total: results.length,
    passed: results.length,
    failed: 0,
    results: results.map(({ terminalStage, envelope }) => {
      const fairness = envelope.row.fairness;
      const terminal = fairness?.stages.at(-1);
      return {
        terminalStage,
        envelope: {
          schemaVersion: envelope.schema_version,
          eventId: envelope.event_id,
          session: envelope.session
        },
        record: {
          recordId: envelope.row.record_id,
          interruptionReason: envelope.row.memo,
          gameMode: envelope.row.game_mode,
          challengeResultLabel: envelope.row.challenge_result_label,
          aiChallengeStatus: envelope.row.ai_challenge_status,
          finalVsAiResult: envelope.row.final_vs_ai_result,
          resultStage: envelope.row.result_stage
        },
        fairness: {
          catalogVersion: fairness?.catalogVersion ?? "",
          totalUserTimeMs: fairness?.totalUserTimeMs ?? 0,
          stageCount: fairness?.stages.length ?? 0,
          terminal: terminal ? {
            stageNumber: terminal.stageNumber,
            textId: terminal.textId,
            catalogVersion: terminal.catalogVersion,
            typedText: terminal.typedText,
            userTimeMs: terminal.userTimeMs,
            typingUnits: terminal.typingUnits,
            aiCpm: terminal.aiCpm,
            result: terminal.result
          } : null
        }
      };
    })
  };
  fs.writeFileSync(path.join(artifactRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const lines = [
    "# Geumcheon countdown interruption E2E report",
    "",
    `- Generated: ${summary.generatedAt}`,
    "- Result: PASS",
    `- Scenarios: ${summary.total}, passed ${summary.passed}, failed ${summary.failed}`,
    "",
    "| Terminal stage | Result stage | Reason | Outcome | Fairness result | AI CPM |",
    "| ---: | ---: | --- | --- | --- | ---: |",
    ...summary.results.map((result) =>
      `| ${result.terminalStage} | ${result.record.resultStage} | ${result.record.interruptionReason} | ${result.record.challengeResultLabel} | ${result.fairness.terminal?.result ?? ""} | ${result.fairness.terminal?.aiCpm ?? ""} |`
    )
  ];
  fs.writeFileSync(path.join(artifactRoot, "report.md"), `${lines.join("\n")}\n`, "utf8");
}

async function main(): Promise<void> {
  cleanDir(artifactRoot);
  const keepEvidence = shouldKeepCountdownEvidence(process.env, artifactRoot, root);
  const results: CountdownResult[] = [];
  let devServer: ChildProcess | undefined;
  try {
    devServer = await startDevServer();
    const requestedStage = process.env.E2E_STAGE ? Number(process.env.E2E_STAGE) : undefined;
    const terminalStages: Array<1 | 2 | 3> = requestedStage === undefined ? [1, 2, 3] : [requestedStage as 1 | 2 | 3];
    for (const terminalStage of terminalStages) {
      assert.ok(terminalStage === 1 || terminalStage === 2 || terminalStage === 3, "E2E_STAGE must be 1, 2, or 3");
      const envelope = await runCountdownInterruption(terminalStage);
      assert.equal(envelope.schema_version, 1);
      assert.equal(envelope.event_id, "geumcheon-science-festival-2026");
      assert.deepEqual(envelope.session, {
        kind: "official",
        session_id: "forced-exit-e2e-official",
        day_no: 1,
        round_no: 1
      });
      assert.match(envelope.row.record_id, /^gsc26-pc01-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(envelope.row.memo, "사용자 중단:메인화면");
      assert.equal(envelope.row.game_mode, "ai_challenge");
      assert.equal(envelope.row.challenge_result_label, "중단 패배");
      assert.equal(envelope.row.ai_challenge_status, "FAILED");
      assert.equal(envelope.row.final_vs_ai_result, "AI_WIN");
      assert.equal(envelope.row.result_stage, String(terminalStage));
      const fairness = envelope.row.fairness;
      assert.ok(fairness, `stage ${terminalStage}: fairness payload is missing`);
      assert.equal(fairness.stages.length, terminalStage);
      assert.equal(fairness.catalogVersion, eventConfig.stageTextCatalogVersion);
      fairness.stages.forEach((stage, index) => {
        const stageNumber = index + 1;
        const range = eventConfig.aiChallenge.official.stageSpeedRanges[`stage${stageNumber}`];
        assert.equal(stage.stageNumber, stageNumber);
        assert.match(stage.textId, new RegExp(`^gsc26-ai-s${stageNumber}-\\d{3}$`));
        assert.equal(stage.catalogVersion, eventConfig.stageTextCatalogVersion);
        assert.notEqual(stage.targetText, "");
        assert.ok(Number.isFinite(stage.userTimeMs) && stage.userTimeMs >= 0);
        assert.ok(Number.isInteger(stage.typingUnits) && stage.typingUnits >= 0);
        assert.ok(stage.aiCpm >= range.min && stage.aiCpm <= range.max, `stage ${stageNumber}: planned CPM ${stage.aiCpm} outside configured range`);
        assert.equal(stage.result, stageNumber === terminalStage ? "INTERRUPTED" : "USER_WIN");
      });
      assert.equal(
        fairness.totalUserTimeMs,
        fairness.stages.reduce((total, stage) => total + stage.userTimeMs, 0)
      );
      const terminal = fairness.stages.at(-1);
      assert.ok(terminal);
      assert.equal(terminal.stageNumber, terminalStage);
      assert.equal(terminal.typedText, "");
      assert.equal(terminal.userTimeMs, 0);
      assert.equal(terminal.typingUnits, 0);
      assert.equal(terminal.result, "INTERRUPTED");
      results.push({ terminalStage, envelope });
    }
    if (keepEvidence) writeCountdownReport(results);
    console.log(JSON.stringify({ pass: results.length, fail: 0, cleanup: artifactRoot }, null, 2));
  } finally {
    if (devServer && !devServer.killed) devServer.kill();
    if (!debugProgress && !keepEvidence) fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    const keepEvidence = shouldKeepCountdownEvidence(process.env, artifactRoot, root);
    if (debugProgress || keepEvidence) {
      fs.mkdirSync(artifactRoot, { recursive: true });
      fs.appendFileSync(path.join(artifactRoot, "progress.log"), `${new Date().toISOString()} failure ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    }
    console.error(error);
    process.exitCode = 1;
  });
}
