import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { REVIEW_LOCAL_ADMIN_PASSWORD } from "../electron/adminAccessSession";
import { parseStageTextCatalog } from "../shared/events/stageTextCatalog";
import type { SaveRecordInput } from "../shared/types";

type Variant = "ai" | "ai-leaderboard" | "practice" | "practice-leaderboard";
type Role = "player" | "leaderboard";
type Session = "official" | "practice";

type ArtifactInput = { variant: string; exePath: string };
type ArtifactFinding = { variant: string; exePath: string; bytes: number; sha256: string; pe: boolean; listing: string[] };
type RuntimeObservation = {
  expectedVariant?: string;
  expectedRole?: string;
  expectedSession?: string;
  bootstrap?: any;
  notices?: unknown[];
  observedHelperProcesses?: string[];
  credentialPopupCount?: number;
  commandWindowCount?: number;
  cleanExit?: boolean;
  residualProcessCount?: number;
  unexpectedFiles?: string[];
};

export const REVIEW_EXTERNAL_STORAGE_API_METHODS = [
  "publishStageTextsToOneDrive",
  "getOneDriveSettings",
  "updateOneDriveSettings",
  "validateOneDriveSetup",
  "pokeOneDriveSync",
  "cleanupLegacyOneDriveArtifacts",
  "chooseOneDriveRoot",
  "openSessionFolder"
] as const;

export function assessReviewExternalStorageBoundary(
  observations: Array<{ method: string; rejected: boolean }>
): string[] {
  const byMethod = new Map(observations.map((observation) => [observation.method, observation]));
  const violations: string[] = [];
  for (const method of REVIEW_EXTERNAL_STORAGE_API_METHODS) {
    const observation = byMethod.get(method);
    if (!observation) violations.push(`REVIEW_EXTERNAL_STORAGE_MISSING:${method}`);
    else if (!observation.rejected) violations.push(`REVIEW_EXTERNAL_STORAGE_ACCEPTED:${method}`);
  }
  return violations;
}

const MIN_PORTABLE_BYTES = 10 * 1024 * 1024;
const FALLBACK_NOTICE = "문구 파일이 없어 기본 문구로 생성합니다.";
const LEADERBOARD_REJECTED_SAVE_INPUT: SaveRecordInput = {
  participant_name: "리더보드 저장 거부 확인",
  phone_part1: "010",
  phone_part2: "0000",
  phone_part3: "0001",
  birth_year: "2012",
  birth_month: "01",
  birth_day: "02",
  privacy_agreed: true,
  privacy_agreed_at: "2026-09-03T01:00:00.000Z",
  stageTexts: ["1234", "5678", "9012"],
  stageTimesMs: [1000, 1000, 1000]
};
const canonicalStageTexts = parseStageTextCatalog(
  fs.readFileSync(path.resolve("events/geumcheon-2026/stage_texts.csv"), "utf8")
).reduce((byStage, row) => {
  const stage = Number(row.stage_number);
  byStage.set(stage, new Set([...(byStage.get(stage) ?? []), row.text]));
  return byStage;
}, new Map<number, Set<string>>());

export function assessStageSeedEvidence(input: {
  exists: boolean;
  notices: unknown[];
  drawnStageTexts: string[];
}): { seededBeforeInitialization: boolean; canonicalDrawObserved: boolean } {
  const canonicalDrawObserved = input.drawnStageTexts.length === 3
    && input.drawnStageTexts.every((text, index) => canonicalStageTexts.get(index + 1)?.has(text));
  return {
    seededBeforeInitialization: input.exists && !input.notices.includes(FALLBACK_NOTICE),
    canonicalDrawObserved
  };
}
const POLL_MS = 100;

export function expectedRendererTitle(variant: string): string {
  switch (variant) {
    case "ai": return "G-Science AI 타자왕";
    case "ai-leaderboard": return "G-Science AI 타자왕 리더보드";
    case "practice": return "G-Science AI 타자왕 연습모드";
    case "practice-leaderboard": return "G-Science AI 타자왕 연습모드 리더보드";
    default: throw new Error(`Unknown review variant: ${variant}`);
  }
}
export function expectedMaskedPhoneSearchNeedle(variant: string): string {
  if (variant === "ai") return "6101";
  if (variant === "practice") return "6201";
  throw new Error(`Masked-phone search is only valid for player variants: ${variant}`);
}

const specs: Array<{
  variant: Variant;
  role: Role;
  session: Session;
  arg: string;
  fileName: string;
  title: string;
  selector: string;
}> = [
  { variant: "ai", role: "player", session: "official", arg: "--ai", fileName: "G-Science AI 타자왕_검토용.exe", title: expectedRendererTitle("ai"), selector: ".entry-panel" },
  { variant: "practice", role: "player", session: "practice", arg: "--practice", fileName: "G-Science AI 타자왕_연습모드_검토용.exe", title: expectedRendererTitle("practice"), selector: ".entry-panel" },
  { variant: "ai-leaderboard", role: "leaderboard", session: "official", arg: "--ai-leaderboard", fileName: "G-Science AI 타자왕_리더보드_검토용.exe", title: expectedRendererTitle("ai-leaderboard"), selector: ".leaderboard-app" },
  { variant: "practice-leaderboard", role: "leaderboard", session: "practice", arg: "--practice-leaderboard", fileName: "G-Science AI 타자왕_연습모드_리더보드_검토용.exe", title: expectedRendererTitle("practice-leaderboard"), selector: ".leaderboard-app" }
];

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function snapshotDirectory(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const snapshot: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(root, fullPath).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        snapshot.push(`${relativePath}/`);
        visit(fullPath);
      } else {
        const bytes = fs.statSync(fullPath).size;
        snapshot.push(`${relativePath}:${bytes}:${sha256(fullPath)}`);
      }
    }
  };
  visit(root);
  return snapshot;
}

async function observeExternalStorageBoundary(
  page: Page
): Promise<Array<{ method: string; rejected: boolean }>> {
  return page.evaluate(async (methods) => {
    const api = (window as any).typingKing;
    const calls: Record<string, () => Promise<any>> = {
      publishStageTextsToOneDrive: () => api.publishStageTextsToOneDrive(),
      getOneDriveSettings: () => api.getOneDriveSettings(),
      updateOneDriveSettings: () => api.updateOneDriveSettings({ syncMode: "local" }),
      validateOneDriveSetup: () => api.validateOneDriveSetup(),
      pokeOneDriveSync: () => api.pokeOneDriveSync("review-boundary-check"),
      cleanupLegacyOneDriveArtifacts: () => api.cleanupLegacyOneDriveArtifacts(),
      chooseOneDriveRoot: () => api.chooseOneDriveRoot(),
      openSessionFolder: () => api.openSessionFolder()
    };
    const observations: Array<{ method: string; rejected: boolean }> = [];
    for (const method of methods) {
      try {
        const response = await calls[method]();
        observations.push({ method, rejected: response?.ok === false });
      } catch {
        observations.push({ method, rejected: false });
      }
    }
    return observations;
  }, REVIEW_EXTERNAL_STORAGE_API_METHODS);
}

export function inspectReviewArtifacts(inputs: ArtifactInput[]): { artifacts: ArtifactFinding[]; violations: string[] } {
  const violations: string[] = [];
  const artifacts = inputs.map(({ variant, exePath }) => {
    const bytes = fs.statSync(exePath).size;
    const header = Buffer.alloc(2);
    const handle = fs.openSync(exePath, "r");
    try { fs.readSync(handle, header, 0, 2, 0); } finally { fs.closeSync(handle); }
    const pe = header.equals(Buffer.from("MZ"));
    const listing = fs.readdirSync(path.dirname(exePath)).sort();
    const hash = sha256(exePath);
    if (!pe) violations.push(`${variant}:NON_PE`);
    if (bytes < MIN_PORTABLE_BYTES) violations.push(`${variant}:UNDERSIZED:${bytes}`);
    for (const sibling of listing.filter((name) => name !== path.basename(exePath))) {
      violations.push(`${variant}:UNEXPECTED_SIBLING:${sibling}`);
    }
    return { variant, exePath, bytes, sha256: hash, pe, listing };
  });
  const byHash = new Map<string, string[]>();
  for (const artifact of artifacts) byHash.set(artifact.sha256, [...(byHash.get(artifact.sha256) ?? []), artifact.variant]);
  for (const [hash, variants] of byHash) {
    if (variants.length > 1) violations.push(`DUPLICATE_HASH:${hash}:${variants.join(",")}`);
  }
  return { artifacts, violations };
}

export function assessRuntimeObservation(input: RuntimeObservation): string[] {
  const violations: string[] = [];
  const context = input.bootstrap?.reviewContext;
  if (!context || context.environment !== "review" || context.profileId !== "geumcheon-2026"
    || context.eventId !== "geumcheon-science-festival-2026-review" || context.buildId !== "R2.0.4-R5"
    || context.storageKind !== "local" || context.role !== input.expectedRole
    || context.sessionKind !== input.expectedSession || input.bootstrap?.variant !== input.expectedVariant) {
    violations.push("REVIEW_CONTEXT_MISSING");
  }
  if ((input.notices ?? []).includes(FALLBACK_NOTICE)) violations.push("STAGE_TEXT_FALLBACK");
  if ((input.observedHelperProcesses ?? []).length) violations.push("UNEXPECTED_HELPER_PROCESS");
  if ((input.credentialPopupCount ?? 0) > 0) violations.push("CREDENTIAL_POPUP");
  if ((input.commandWindowCount ?? 0) > 0) violations.push("COMMAND_WINDOW");
  if (input.cleanExit === false) violations.push("UNCLEAN_EXIT");
  if ((input.residualProcessCount ?? 0) > 0) violations.push("RESIDUAL_PROCESS");
  if ((input.unexpectedFiles ?? []).length) violations.push("UNEXPECTED_RUNTIME_FILE");
  return violations;
}

async function waitUntil(description: string, predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`Timed out waiting for ${description}${last instanceof Error ? `: ${last.message}` : ""}`);
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function readCdp(port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/json/version", timeout: 500 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve(JSON.parse(body).webSocketDebuggerUrl); } catch { resolve(undefined); }
      });
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(undefined));
  });
}

function sanitizedEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)/i.test(key)
    && !["APP_VARIANT", "TYPINGKING_EVENT_PROFILE", "TYPINGKING_RUNTIME_ROOT", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS"].includes(key.toUpperCase())
  ));
  return { ...env, ...overrides };
}

function launchViaShellExecute(exePath: string, cwd: string, port: number, env: NodeJS.ProcessEnv): number {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=Start-Process -FilePath $env:TK_R5_EXE -WorkingDirectory $env:TK_R5_CWD -ArgumentList @('--remote-debugging-port=' + $env:TK_R5_PORT) -PassThru",
    "[Console]::Out.Write($p.Id)"
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, env: { ...env, TK_R5_EXE: exePath, TK_R5_CWD: cwd, TK_R5_PORT: String(port) }
  });
  if (result.status !== 0 || !/^\d+$/.test(result.stdout.trim())) throw new Error(`SHELLEXECUTE_FAILED:${result.stderr.trim()}`);
  return Number(result.stdout.trim());
}

type ProcessInfo = { ProcessId: number; ParentProcessId: number; Name: string; CommandLine?: string; MainWindowTitle?: string };
function processTree(rootPid: number): ProcessInfo[] {
  const script = "$p=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine);$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add([int]$env:TK_R5_PID);do{$n=0;foreach($x in $p){if($ids.Contains([int]$x.ParentProcessId)-and $ids.Add([int]$x.ProcessId)){$n++}}}while($n);$p|?{$ids.Contains([int]$_.ProcessId)}|%{$q=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue;[pscustomobject]@{ProcessId=$_.ProcessId;ParentProcessId=$_.ParentProcessId;Name=$_.Name;CommandLine=$_.CommandLine;MainWindowTitle=$q.MainWindowTitle}}|ConvertTo-Json -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, env: { ...process.env, TK_R5_PID: String(rootPid) } });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const value = JSON.parse(result.stdout);
  return (Array.isArray(value) ? value : [value]) as ProcessInfo[];
}

async function playerFlow(page: Page, variant: Variant, outputRoot: string): Promise<{ recordId: string; participantName: string; searchNeedle: string; stageTexts: string[] }> {
  const participantName = variant === "ai" ? "합성공식검증" : "합성연습검증";
  const searchNeedle = expectedMaskedPhoneSearchNeedle(variant);
  await page.locator(".entry-form-group input").first().fill(participantName);
  const phone = page.locator(".phone-row input");
  await phone.nth(0).fill(variant === "ai" ? "5101" : "5201");
  await phone.nth(1).fill(searchNeedle);
  const birth = page.locator(".birth-row select");
  await birth.nth(0).selectOption("2012");
  await birth.nth(1).selectOption("1");
  await birth.nth(2).selectOption("2");
  await page.locator('.entry-form-group input[type="checkbox"]').check();
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-main.png`) });
  await page.locator(".entry-panel .button-row .primary-button").click();
  await page.locator(".challenge-screen").waitFor({ state: "visible", timeout: 30_000 });
  const stageTexts: string[] = [];
  for (let stage = 1; stage <= 3; stage += 1) {
    const input = page.locator("textarea.typing-input");
    await waitUntil(`stage ${stage} input enabled`, () => input.isEnabled(), 15_000);
    const target = (await page.locator(".duel-target").first().innerText()).replace(/\u00a0/g, " ").trim();
    assert.equal(canonicalStageTexts.get(stage)?.has(target), true, `${variant} stage ${stage} did not draw from canonical catalog: ${target}`);
    stageTexts.push(target);
    await input.fill(target);
    const modal = page.locator(".challenge-modal");
    await modal.waitFor({ state: "visible", timeout: 20_000 });
    await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-stage-${stage}.png`) });
    await modal.locator(".primary-button").click();
  }
  await page.locator(".challenge-result-panel").waitFor({ state: "visible", timeout: 20_000 });
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-result.png`) });
  const listed = await page.evaluate(async () => (window as any).typingKing.listRecords());
  const row = listed?.data?.find((candidate: any) => candidate.participant_name === participantName);
  assert.ok(row?.record_id, `${variant} result record missing`);
  return { recordId: row.record_id, participantName, searchNeedle, stageTexts };
}

async function leaderboardFlow(page: Page, expected: { recordId: string; participantName: string; searchNeedle: string }, forbiddenId: string, outputRoot: string, variant: Variant): Promise<{ refreshes: number; crossLeak: number }> {
  let rows: any[] = [];
  let refreshes = 0;
  while (refreshes < 2) {
    refreshes += 1;
    const result = await page.evaluate(async () => (window as any).typingKing.listRecords());
    assert.equal(result?.ok, true);
    rows = result.data;
    if (rows.some((row) => row.record_id === expected.recordId)) break;
    await page.getByRole("button", { name: "새로고침" }).click();
    await waitUntil("leaderboard refresh button enabled", () => page.getByRole("button", { name: "새로고침" }).isEnabled(), 10_000);
  }
  assert.ok(rows.some((row) => row.record_id === expected.recordId), `${variant} pair record not shared within two refreshes`);
  const crossLeak = rows.filter((row) => row.record_id === forbiddenId).length;
  assert.equal(crossLeak, 0, `${variant} cross namespace leak`);
  const recordIdsBeforeRejectedSave = rows.map((row) => row.record_id).sort();
  const rejectedSave = await page.evaluate(
    async (input) => (window as any).typingKing.saveRecord(input),
    LEADERBOARD_REJECTED_SAVE_INPUT
  );
  assert.equal(rejectedSave?.ok, false, `${variant} leaderboard record save was accepted`);
  const recordsAfterRejectedSave = await page.evaluate(async () => (window as any).typingKing.listRecords());
  assert.equal(recordsAfterRejectedSave?.ok, true);
  assert.deepEqual(
    recordsAfterRejectedSave.data.map((row: any) => row.record_id).sort(),
    recordIdsBeforeRejectedSave,
    `${variant} leaderboard rejected save changed record ids`
  );
  const search = page.locator(".search-input");
  await search.fill(expected.searchNeedle);
  await waitUntil("searched leaderboard row", () => page.locator(".ranking-row").count().then((count) => count === 1), 10_000);
  const searchedText = await page.locator(".ranking-row").first().innerText();
  assert.match(searchedText, new RegExp(expected.searchNeedle));
  assert.equal(searchedText.includes(expected.participantName), false, `${variant} exposed raw participant name before admin authorization`);
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-search.png`) });
  await search.fill("");
  await page.getByRole("button", { name: "관리자", exact: true }).click();
  await page.locator(".admin-modal").waitFor({ state: "visible" });
  const loginInputs = page.locator(".admin-login-grid input");
  await loginInputs.nth(0).fill("synthetic-review-admin");
  await loginInputs.nth(1).fill(REVIEW_LOCAL_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "진입", exact: true }).click();
  await page.locator(".admin-toolbar").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByRole("button", { name: "전체기록 보기" }).click();
  await page.getByRole("button", { name: "최고기록만 보기" }).click();
  const picker = page.locator(".admin-record-picker button").first();
  await picker.click();
  assert.match((await picker.getAttribute("class")) ?? "", /selected/);
  await picker.click();
  assert.doesNotMatch((await picker.getAttribute("class")) ?? "", /selected/);
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-admin.png`) });
  return { refreshes, crossLeak };
}

async function runOne(spec: typeof specs[number], exePath: string, outputRoot: string, localAppData: string, paired: Map<Session, { recordId: string; participantName: string }>): Promise<any> {
  const port = await reservePort();
  const env = sanitizedEnvironment({ LOCALAPPDATA: localAppData, APPDATA: path.join(outputRoot, "runtime", "AppData"), TEMP: path.join(outputRoot, "runtime", "Temp"), TMP: path.join(outputRoot, "runtime", "Temp") });
  const pid = launchViaShellExecute(exePath, path.dirname(exePath), port, env);
  let browser: Browser | undefined;
  let page: Page | undefined;
  let error: string | undefined;
  let cleanExit = false;
  let forcedCleanup = false;
  let flow: any;
  let bootstrap: any;
  let storageValidation: any;
  let externalStorageBoundary: any;
  let processes: ProcessInfo[] = [];
  try {
    let ws: string | undefined;
    await waitUntil("portable CDP endpoint", async () => Boolean(ws = await readCdp(port)), 90_000);
    browser = await chromium.connectOverCDP(ws!);
    await waitUntil("packaged renderer page", () => browser!.contexts().flatMap((context) => context.pages()).some((candidate) => candidate.url().startsWith("file:")), 45_000);
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith("file:"))!;
    await page.locator(spec.selector).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.title(), spec.title);
    const bootstrapResult = await page.evaluate(async () => (window as any).typingKing.getBootstrap());
    assert.equal(bootstrapResult?.ok, true);
    bootstrap = bootstrapResult.data;
    const auth = await page.evaluate(async (password) => (window as any).typingKing.validateAdmin(password, "synthetic-review-admin"), REVIEW_LOCAL_ADMIN_PASSWORD);
    assert.equal(auth?.ok, true);
    storageValidation = await page.evaluate(async () => (window as any).typingKing.validateReviewStorage());
    assert.equal(storageValidation?.ok, true);
    const reviewStorageRoot = path.join(
      localAppData,
      "ThePMD",
      "TypingKing",
      "Geumcheon2026",
      "Review",
      spec.session
    );
    const storageBefore = snapshotDirectory(reviewStorageRoot);
    const observations = await observeExternalStorageBoundary(page);
    const storageAfter = snapshotDirectory(reviewStorageRoot);
    externalStorageBoundary = {
      observations,
      storageUnchanged: JSON.stringify(storageAfter) === JSON.stringify(storageBefore)
    };
    assert.deepEqual(assessReviewExternalStorageBoundary(observations), []);
    assert.equal(externalStorageBoundary.storageUnchanged, true, `${spec.variant} external-storage call changed review files`);
    const notices = Array.isArray(bootstrap.notices) ? bootstrap.notices : [];
    assert.equal(notices.includes(FALLBACK_NOTICE), false, `${spec.variant} used fallback stage texts`);
    processes = processTree(pid);
    const helperNames = processes.map((entry) => entry.Name).filter((name) => /^(?:node|cmd|powershell|pwsh|wscript|cscript)\.exe$/i.test(name));
    const titled = processes.filter((entry) => entry.MainWindowTitle?.trim());
    const credentialPopupCount = titled.filter((entry) => /credential|자격 증명|접속정보/i.test(entry.MainWindowTitle!)).length;
    const commandWindowCount = titled.filter((entry) => /^(?:cmd|powershell|pwsh)\.exe$/i.test(entry.Name)).length;
    if (spec.role === "player") {
      flow = await playerFlow(page, spec.variant, outputRoot);
      paired.set(spec.session, flow);
    } else {
      const expected = paired.get(spec.session)!;
      const other = paired.get(spec.session === "official" ? "practice" : "official")!;
      flow = await leaderboardFlow(page, expected, other.recordId, outputRoot, spec.variant);
    }
    const runtimeViolations = assessRuntimeObservation({ expectedVariant: spec.variant, expectedRole: spec.role, expectedSession: spec.session, bootstrap, notices, observedHelperProcesses: helperNames, credentialPopupCount, commandWindowCount });
    assert.deepEqual(runtimeViolations, []);
  } catch (caught) {
    error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputRoot, "screenshots", `${spec.variant}-failure.png`) }).catch(() => undefined);
  } finally {
    if (page && !page.isClosed()) await page.close({ runBeforeUnload: true }).catch(() => undefined);
    if (browser?.isConnected()) await browser.close().catch(() => undefined);
    await waitUntil("portable process tree exit", () => processTree(pid).length === 0, 8_000).catch(() => undefined);
    if (processTree(pid).length) {
      forcedCleanup = true;
      spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
    }
    await waitUntil("forced portable process tree exit", () => processTree(pid).length === 0, 10_000).catch(() => undefined);
    cleanExit = !forcedCleanup && processTree(pid).length === 0;
  }
  const listing = fs.readdirSync(path.dirname(exePath)).sort();
  const unexpectedFiles = listing.filter((name) => name !== path.basename(exePath));
  const finalViolations = assessRuntimeObservation({ expectedVariant: spec.variant, expectedRole: spec.role, expectedSession: spec.session, bootstrap, notices: bootstrap?.notices, cleanExit, residualProcessCount: processTree(pid).length, unexpectedFiles });
  if (finalViolations.length && !error) error = finalViolations.join(",");
  return { variant: spec.variant, role: spec.role, session: spec.session, pid, title: spec.title, bootstrap: bootstrap ? { variant: bootstrap.variant, reviewContext: bootstrap.reviewContext, notices: bootstrap.notices } : null, storageValidation: storageValidation?.data ?? null, externalStorageBoundary, processSnapshot: processes.map(({ ProcessId, ParentProcessId, Name, MainWindowTitle }) => ({ ProcessId, ParentProcessId, Name, MainWindowTitle })), flow, cleanExit, forcedCleanup, residualProcessCount: processTree(pid).length, executableFolderListing: listing, error, verdict: error ? "FAIL" : "PASS" };
}

function parseArgs(argv: string[]): { outputRoot: string; inputs: Map<Variant, string> } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || !argv[index + 1]) throw new Error("Usage: --output <dir> --ai <exe> --ai-leaderboard <exe> --practice <exe> --practice-leaderboard <exe>");
    values.set(argv[index], argv[index + 1]);
  }
  const output = values.get("--output");
  if (!output) throw new Error("Missing --output");
  const inputs = new Map<Variant, string>();
  for (const spec of specs) {
    const value = values.get(spec.arg);
    if (!value) throw new Error(`Missing ${spec.arg}`);
    inputs.set(spec.variant, path.resolve(value));
  }
  return { outputRoot: path.resolve(output), inputs };
}

async function main(): Promise<void> {
  const { outputRoot, inputs } = parseArgs(process.argv.slice(2));
  const allowedRoot = path.resolve("test_artifacts") + path.sep;
  if (!outputRoot.startsWith(allowedRoot)) throw new Error(`Output must be under ${allowedRoot}`);
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(outputRoot, "screenshots"), { recursive: true });
  fs.mkdirSync(path.join(outputRoot, "runtime", "LocalAppData"), { recursive: true });
  fs.mkdirSync(path.join(outputRoot, "runtime", "AppData"), { recursive: true });
  fs.mkdirSync(path.join(outputRoot, "runtime", "Temp"), { recursive: true });
  const staged: ArtifactInput[] = [];
  for (const spec of specs) {
    const dir = path.join(outputRoot, "isolated", spec.variant);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, spec.fileName);
    fs.copyFileSync(inputs.get(spec.variant)!, target);
    staged.push({ variant: spec.variant, exePath: target });
  }
  const preflight = inspectReviewArtifacts(staged);
  assert.deepEqual(preflight.violations, [], preflight.violations.join("\n"));
  const paired = new Map<Session, { recordId: string; participantName: string; searchNeedle: string; stageTexts: string[] }>();
  const results = [];
  for (const spec of specs) {
    results.push(await runOne(spec, staged.find((item) => item.variant === spec.variant)!.exePath, outputRoot, path.join(outputRoot, "runtime", "LocalAppData"), paired));
  }
  const stageSourceHash = sha256(path.resolve("events/geumcheon-2026/stage_texts.csv"));
  const stageSeeds = (["official", "practice"] as const).map((session) => {
    const target = path.join(outputRoot, "runtime", "LocalAppData", "ThePMD", "TypingKing", "Geumcheon2026", "Review", session, "data", "stage_texts.csv");
    const matchingRuns = results.filter((entry) => entry.session === session);
    const playerRun = matchingRuns.find((entry) => entry.role === "player");
    const evidence = assessStageSeedEvidence({
      exists: fs.existsSync(target),
      notices: matchingRuns.flatMap((entry) => entry.bootstrap?.notices ?? []),
      drawnStageTexts: playerRun?.flow?.stageTexts ?? []
    });
    return {
      session,
      path: target,
      exists: fs.existsSync(target),
      canonicalSourceSha256: stageSourceHash,
      postInitializationSha256: fs.existsSync(target) ? sha256(target) : null,
      ...evidence
    };
  });
  const summary = { schemaVersion: 1, generatedAt: new Date().toISOString(), launchMethod: "PowerShell Start-Process (ShellExecute)", actualNasUsed: false, operationalCredentialsUsed: false, offlineSingleExeTest: "HOLD", standaloneExe4: "HOLD", offlineReason: "No proven network-disabled Windows Sandbox or VM was available on this host.", preflight, stageSeeds, results, officialRecordShare: results.find((entry) => entry.variant === "ai-leaderboard")?.verdict === "PASS" ? "PASS" : "HOLD", practiceRecordShare: results.find((entry) => entry.variant === "practice-leaderboard")?.verdict === "PASS" ? "PASS" : "HOLD", crossLeakCount: results.filter((entry) => entry.role === "leaderboard").reduce((sum, entry) => sum + (entry.flow?.crossLeak ?? 0), 0), passed: results.filter((entry) => entry.verdict === "PASS").length, failed: results.filter((entry) => entry.verdict === "FAIL").length };
  fs.writeFileSync(path.join(outputRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ outputRoot, passed: summary.passed, failed: summary.failed, offlineSingleExeTest: summary.offlineSingleExeTest }, null, 2));
  if (summary.failed || stageSeeds.some((entry) => !entry.exists || !entry.seededBeforeInitialization || !entry.canonicalDrawObserved)) process.exitCode = 1;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirect) main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
