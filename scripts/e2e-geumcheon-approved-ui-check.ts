import assert from "node:assert/strict";
import { type ChildProcess, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { sanitizeE2eChildEnvironment } from "../electron/startupProfile";
import { DEFAULT_CONFIG } from "../shared/constants/defaults";
import type { RecordRow } from "../shared/types";
import {
  toPortableCssFileReference,
  toPortableProjectPath
} from "./geumcheon-evidence-paths";
import {
  buildApprovedUiLaunchEnvironment,
  parseApprovedUiRunOptions,
  resolveGeumcheonE2eArtifactRoot,
  type ApprovedUiRunOptions,
  type ApprovedUiVariant
} from "./geumcheon-approved-ui-options";

type Role = "player" | "leaderboard";
type GameVariant = Extract<ApprovedUiVariant, "ai" | "practice">;
type LeaderboardVariant = Extract<ApprovedUiVariant, "ai-leaderboard" | "practice-leaderboard">;
type RunningApp = { app: ElectronApplication; page: Page };
type LocalNasServer = {
  server: https.Server;
  apiBaseUrl: string;
  caPemPath: string;
  tokens: Record<"PC01" | "LEADERBOARD01", string>;
  observations: Array<{
    method: string;
    pathname: string;
    deviceId: string;
    authorized: boolean;
    queryMatched: boolean;
  }>;
};
type ScreenCheck = {
  screen: string;
  resolution: string;
  background: string;
  alpha: number;
  horizontalOverflow: boolean;
  verticalOverflow: boolean;
  buttonsReachable: boolean;
  brokenImages: string[];
  screenshot: string;
};
type LeaderboardBehaviorCheck = {
  variant: LeaderboardVariant;
  resolution: string;
  rowCount: number;
  searchResultCount: number;
  rawIdentityHidden: boolean;
  maskedIdentityVisible: boolean;
  rawIdentityLeakCount: number;
  maskedIdentityMissingCount: number;
  scrollable: boolean;
  scrolled: boolean;
  backgroundAsset: string;
  backgroundPosition: string;
  backgroundSize: string;
  backgroundRepeat: string;
  titleAsset: string;
  titleTag: string;
  titleDisplay: string;
  titleObjectFit: string;
  titleWithinContainer: boolean;
  titleContainerWithinBoard: boolean;
  titleCenterOffsetPx: number;
  titleContainerCenterOffsetPx: number;
  titleCenterRatio: number;
  searchScreenshot: string;
  scrollScreenshot: string;
};

const root = process.cwd();
const artifactRoot = resolveGeumcheonE2eArtifactRoot(
  root,
  "geumcheon_approved_ui",
  process.env.TYPINGKING_E2E_ARTIFACT_ROOT
);
const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const mainJs = path.join(root, "dist-electron", "electron", "main.js");
const eventId = "geumcheon-science-festival-2026";
const officialSessionId = "approved-ui-official";
const rows: ScreenCheck[] = [];
const leaderboardChecks: LeaderboardBehaviorCheck[] = [];
const sizes = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 }
];

function syntheticLeaderboardRows(): RecordRow[] {
  const catalogVersion = "geumcheon-draft-20260825-v1";
  const stage1 = "과학은 질문에서 시작됩니다";
  const stage2 = "태양 에너지는 우리 생활에 새로운 힘을 더합니다";
  const stage3 = "우리가 던진 작은 질문은 관찰과 실험을 거쳐 새로운 과학의 길을 엽니다";
  const base: Omit<RecordRow, "record_id" | "participant_name" | "phone_part2" | "phone_part3" | "phone_full" | "phone_masked" | "participant_result_time_ms" | "participant_avg_cpm" | "duel_time_ms" | "participantKey"> = {
    created_at: "2026-08-29T01:00:00.000Z",
    completed_at: "2026-08-29T01:01:00.000Z",
    phone_part1: "010",
    birth_year: "2014",
    birth_month: "01",
    birth_day: "01",
    birthdate: "2014-01-01",
    birthdate_masked: "2014-**-**",
    privacy_agreed: "true",
    privacy_agreed_at: "2026-08-29T01:00:00.000Z",
    stage1_text: stage1,
    stage2_text: stage2,
    stage3_text: stage3,
    stage_text_catalog_version: catalogVersion,
    stage1_text_id: "gsc26-ai-s1-001",
    stage2_text_id: "gsc26-ai-s2-001",
    stage3_text_id: "gsc26-ai-s3-001",
    stage1_char_count: "13",
    stage2_char_count: "24",
    stage3_char_count: "39",
    total_char_count: "76",
    stage1_time_ms: "10000",
    stage2_time_ms: "10000",
    stage3_time_ms: "10000",
    stage1_cumulative_ms: "10000",
    stage2_cumulative_ms: "20000",
    total_time_ms: "30000",
    display_stage1_sec: "10.00",
    display_stage2_sec: "10.00",
    display_stage3_sec: "10.00",
    display_total_sec: "30.00",
    final_cpm: "500",
    final_accuracy: "100",
    app_version: "1.0.0",
    is_test: "false",
    is_debug: "false",
    debug_mode_type: "",
    memo: "합성 UAT 기록",
    game_mode: "ai_challenge",
    ai_enabled: "true",
    ai_challenge_status: "SUCCESS",
    ai_failed_stage: "",
    ai_stage1_cpm: "400",
    ai_stage2_cpm: "400",
    ai_stage3_cpm: "400",
    ai_stage1_time_ms: "10000",
    ai_stage2_time_ms: "10000",
    ai_stage3_time_ms: "10000",
    ai_total_time_ms: "30000",
    stage1_vs_ai_result: "USER_WIN",
    stage2_vs_ai_result: "USER_WIN",
    stage3_vs_ai_result: "USER_WIN",
    final_vs_ai_result: "USER_WIN",
    stage1_time_diff_ms: "0",
    stage2_time_diff_ms: "0",
    stage3_time_diff_ms: "0",
    final_time_diff_ms: "0",
    ai_result_time_ms: "30000",
    ai_avg_cpm: "400",
    challenge_result_label: "참여자 승리",
    participant_progress_percent: "100",
    ai_progress_percent: "100",
    result_stage: "3",
    original_record_id: "",
    is_admin_edited: "false",
    fairness: {
      catalogVersion,
      totalUserTimeMs: 30000,
      stages: [
        { stageNumber: 1, textId: "gsc26-ai-s1-001", catalogVersion, targetText: stage1, typedText: stage1, userTimeMs: 10000, typingUnits: 30, aiCpm: 400, result: "USER_WIN" },
        { stageNumber: 2, textId: "gsc26-ai-s2-001", catalogVersion, targetText: stage2, typedText: stage2, userTimeMs: 10000, typingUnits: 40, aiCpm: 400, result: "USER_WIN" },
        { stageNumber: 3, textId: "gsc26-ai-s3-001", catalogVersion, targetText: stage3, typedText: stage3, userTimeMs: 10000, typingUnits: 50, aiCpm: 400, result: "USER_WIN" }
      ]
    },
    attemptNumber: 1,
    rankingEligible: true,
    serverReceivedAt: "2026-08-29T01:01:01.000Z",
    completionStatus: "completed"
  };
  return Array.from({ length: 12 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    const phoneLast = String(1001 + index);
    const participantTimeMs = 30000 + index * 1000;
    return {
      ...base,
      record_id: `gsc26-pc${String((index % 10) + 1).padStart(2, "0")}-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      participant_name: `합성참가자${suffix}`,
      phone_part2: "0000",
      phone_part3: phoneLast,
      phone_full: `0100000${phoneLast}`,
      phone_masked: `010-****-${phoneLast}`,
      participant_result_time_ms: String(participantTimeMs),
      participant_avg_cpm: String(520 - index * 5),
      duel_time_ms: String(participantTimeMs),
      participantKey: `synthetic-participant-${suffix}`
    };
  });
}

function maskSyntheticParticipantName(value: string): string {
  return Array.from(value).map((character, index) => (index % 2 === 0 ? character : "*")).join("");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanDir(dir: string): void {
  const resolved = path.resolve(dir);
  assert.equal(
    resolved.startsWith(`${path.resolve(root, "test_artifacts")}${path.sep}`),
    true,
    "Refusing to clean outside test_artifacts"
  );
  fs.rmSync(resolved, { recursive: true, force: true });
  ensureDir(resolved);
}

function writeSyntheticProfiles(
  dir: string,
  role: Role,
  apiBaseUrl: string,
  token: string
): void {
  const deviceId = role === "leaderboard" ? "LEADERBOARD01" : "PC01";
  fs.writeFileSync(path.join(dir, "device-profile.json"), `${JSON.stringify({
    schemaVersion: 1,
    eventProfileId: "geumcheon-2026",
    eventId,
    deviceId,
    role,
    apiBaseUrl,
    sessions: {
      official: { sessionId: officialSessionId, dayNo: 1, roundNo: 1 },
      practice: { sessionId: "approved-ui-practice" }
    },
    requestTimeoutMs: 5000,
    retry: { initialDelayMs: 2000, maxDelayMs: 60000 }
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(dir, "bootstrap-credentials.json"), `${JSON.stringify({
    schemaVersion: 1,
    eventId,
    deviceId,
    apiBaseUrl,
    token
  }, null, 2)}\n`, "utf8");
  const runtimeConfigDir = path.join(dir, "runtime", "config");
  ensureDir(runtimeConfigDir);
  fs.writeFileSync(
    path.join(runtimeConfigDir, "config.json"),
    `${JSON.stringify({
      ...DEFAULT_CONFIG,
      adminPassword: crypto.randomBytes(24).toString("base64url")
    }, null, 2)}\n`,
    "utf8"
  );
}

function createLocalHttpsCertificate(certRoot: string): {
  pfxPath: string;
  caPemPath: string;
  passphrase: string;
} {
  ensureDir(certRoot);
  const pfxPath = path.join(certRoot, "localhost.pfx");
  const caPemPath = path.join(certRoot, "ca.pem");
  const passphrase = `typingking-approved-ui-${process.pid}`;
  const script = String.raw`
$ErrorActionPreference = "Stop"
$pfxPath = [Environment]::GetEnvironmentVariable("TK_UI_PFX_PATH")
$caPemPath = [Environment]::GetEnvironmentVariable("TK_UI_CA_PEM_PATH")
$password = [Environment]::GetEnvironmentVariable("TK_UI_PFX_PASSWORD")
$notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
$notAfter = [DateTimeOffset]::UtcNow.AddDays(1)

$caKey = [Security.Cryptography.RSA]::Create(2048)
$caRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
  "CN=TypingKing Approved UI Root",
  $caKey,
  [Security.Cryptography.HashAlgorithmName]::SHA256,
  [Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$caRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true)
)
$caUsage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
$caRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($caUsage, $true)
)
$caRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($caRequest.PublicKey, $false)
)
$caCertificate = $caRequest.CreateSelfSigned($notBefore, $notAfter)

$serverKey = [Security.Cryptography.RSA]::Create(2048)
$serverRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
  "CN=localhost",
  $serverKey,
  [Security.Cryptography.HashAlgorithmName]::SHA256,
  [Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$serverRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
)
$serverUsage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
$serverRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($serverUsage, $true)
)
$ekuOids = [Security.Cryptography.OidCollection]::new()
[void]$ekuOids.Add([Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1"))
$serverRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($ekuOids, $true)
)
$san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName("localhost")
$san.AddIpAddress([Net.IPAddress]::Parse("127.0.0.1"))
$serverRequest.CertificateExtensions.Add($san.Build())
$serverRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($serverRequest.PublicKey, $false)
)
$serial = [byte[]]::new(16)
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($serial)
$issued = $serverRequest.Create($caCertificate, $notBefore, $notAfter, $serial)
$serverCertificate = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($issued, $serverKey)
$pfxBytes = $serverCertificate.Export(
  [Security.Cryptography.X509Certificates.X509ContentType]::Pfx,
  $password
)
[IO.File]::WriteAllBytes($pfxPath, $pfxBytes)
$pemBody = [Convert]::ToBase64String(
  $caCertificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert),
  [Base64FormattingOptions]::InsertLineBreaks
)
[IO.File]::WriteAllText(
  $caPemPath,
  "-----BEGIN CERTIFICATE-----" + [Environment]::NewLine +
  $pemBody + [Environment]::NewLine +
  "-----END CERTIFICATE-----" + [Environment]::NewLine
)
$serverCertificate.Dispose()
$issued.Dispose()
$serverKey.Dispose()
$caCertificate.Dispose()
$caKey.Dispose()
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...sanitizeE2eChildEnvironment(process.env),
      TK_UI_PFX_PATH: pfxPath,
      TK_UI_CA_PEM_PATH: caPemPath,
      TK_UI_PFX_PASSWORD: passphrase
    }
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !fs.existsSync(pfxPath) || !fs.existsSync(caPemPath)) {
    throw new Error(`Local HTTPS certificate generation failed: ${result.stderr || result.stdout || result.status}`);
  }
  return { pfxPath, caPemPath, passphrase };
}

async function startLocalNasServer(temporaryRoot: string): Promise<LocalNasServer> {
  const certificate = createLocalHttpsCertificate(path.join(temporaryRoot, "certificates"));
  const tokens = {
    PC01: crypto.randomBytes(32).toString("base64url"),
    LEADERBOARD01: crypto.randomBytes(32).toString("base64url")
  } as const;
  const observations: LocalNasServer["observations"] = [];
  const server = https.createServer({
    pfx: fs.readFileSync(certificate.pfxPath),
    passphrase: certificate.passphrase,
    minVersion: "TLSv1.2"
  }, (request, response) => {
    const requestUrl = new URL(request.url || "/", "https://localhost");
    const deviceId = request.headers["x-device-id"];
    const knownDeviceId = deviceId === "PC01" || deviceId === "LEADERBOARD01" ? deviceId : undefined;
    const authorized = Boolean(knownDeviceId && request.headers.authorization === `Bearer ${tokens[knownDeviceId]}`);
    const officialQueryMatched = requestUrl.searchParams.get("session_kind") === "official"
      && requestUrl.searchParams.get("session_id") === officialSessionId
      && requestUrl.searchParams.get("day_no") === "1"
      && requestUrl.searchParams.get("round_no") === "1";
    const practiceQueryMatched = requestUrl.searchParams.get("session_kind") === "practice"
      && requestUrl.searchParams.get("session_id") === "approved-ui-practice"
      && requestUrl.searchParams.get("day_no") === null
      && requestUrl.searchParams.get("round_no") === null;
    const queryMatched = officialQueryMatched || practiceQueryMatched;
    observations.push({
      method: request.method || "",
      pathname: requestUrl.pathname,
      deviceId: String(deviceId || ""),
      authorized,
      queryMatched
    });
    fs.writeFileSync(
      path.join(artifactRoot, "nas-observations.json"),
      `${JSON.stringify(observations, null, 2)}\n`,
      "utf8"
    );
    if (!authorized) {
      response.writeHead(401).end();
      return;
    }
    if (!queryMatched) {
      response.writeHead(403).end();
      return;
    }
    const session = practiceQueryMatched
      ? { kind: "practice", session_id: "approved-ui-practice" }
      : { kind: "official", session_id: officialSessionId, day_no: 1, round_no: 1 };
    if (request.method === "GET" && requestUrl.pathname === "/api/v1/ready") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({
        schema_version: 1,
        status: "ready",
        event_id: eventId,
        device_id: knownDeviceId,
        role: knownDeviceId === "LEADERBOARD01" ? "operator" : "writer",
        session
      }));
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/v1/records") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({
        schema_version: 1,
        event_id: eventId,
        session,
        generated_at: new Date().toISOString(),
        rows: syntheticLeaderboardRows()
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Local HTTPS server did not expose a TCP port");
  }
  return {
    server,
    apiBaseUrl: `https://127.0.0.1:${address.port}`,
    caPemPath: certificate.caPemPath,
    tokens,
    observations
  };
}

async function stopHttpsServer(server: https.Server | undefined): Promise<void> {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const timeoutAt = Date.now() + 5000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < timeoutAt) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function closeRunningApp(app: RunningApp | undefined): Promise<void> {
  if (!app) return;
  const child = app.app.process();
  await Promise.race([
    app.app.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 5000))
  ]);
  await stopProcess(child);
}

function cssAlpha(value: string): number {
  const rgba = value.match(/rgba?\(([^)]+)\)/i);
  if (!rgba) return value.toLowerCase() === "transparent" ? 0 : 1;
  const parts = rgba[1].split(",").map((part) => part.trim());
  if (parts.length < 4) return 1;
  const alpha = Number(parts[3]);
  return Number.isFinite(alpha) ? alpha : 1;
}

async function visibleImageFailures(page: Page, selectors: string[]): Promise<string[]> {
  return page.evaluate((inputSelectors) => {
    return inputSelectors.flatMap((selector) => {
      const images = Array.from(document.querySelectorAll(selector));
      if (images.length === 0) return [`missing:${selector}`];
      return images.flatMap((element) => {
        const image = element as HTMLImageElement;
        const rect = image.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(image).visibility !== "hidden";
        const loaded = image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
        return visible && loaded ? [] : [`${selector}:${image.currentSrc || image.src || "no-src"}`];
      });
    });
  }, selectors);
}

async function captureHiddenWindow(
  running: RunningApp,
  screenshotPath: string
): Promise<void> {
  await running.page.evaluate(() => {
    document.getAnimations().forEach((animation) => animation.pause());
  });
  const pngBase64 = await running.app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Approved UI BrowserWindow is missing");
    const image = await window.webContents.capturePage();
    return image.toPNG().toString("base64");
  });
  fs.writeFileSync(screenshotPath, Buffer.from(pngBase64, "base64"));
}

async function pageMetrics(page: Page): Promise<{
  background: string;
  alpha: number;
  horizontalOverflow: boolean;
  verticalOverflow: boolean;
  buttonsReachable: boolean;
}> {
  const metrics = await page.evaluate(() => {
    const app = document.querySelector(".app") as HTMLElement | null;
    const panel = document.querySelector(".hero-panel, .duel-panel, .leaderboard-board") as HTMLElement | null;
    const doc = document.documentElement;
    const body = document.body;
    const buttons = Array.from(document.querySelectorAll("button")).filter((button) => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    return {
      background: app ? getComputedStyle(app).backgroundImage : "",
      panelBackground: panel ? getComputedStyle(panel).backgroundColor : "",
      scrollWidth: Math.max(doc.scrollWidth, body.scrollWidth),
      clientWidth: doc.clientWidth,
      scrollHeight: Math.max(doc.scrollHeight, body.scrollHeight),
      clientHeight: doc.clientHeight,
      buttonsReachable: buttons.every((button) => {
        const rect = button.getBoundingClientRect();
        const scrollingBody = button.closest<HTMLElement>(".ranking-body");
        if (scrollingBody) {
          const scrollingRect = scrollingBody.getBoundingClientRect();
          const offsetBottom = button.offsetTop + button.offsetHeight;
          return scrollingRect.width > 0
            && scrollingRect.height > 0
            && scrollingRect.right >= 0
            && scrollingRect.left <= innerWidth
            && offsetBottom <= scrollingBody.scrollHeight + 1;
        }
        return rect.right >= 0 && rect.left <= innerWidth && rect.bottom >= 0 && rect.top <= innerHeight;
      })
    };
  });
  return {
    background: metrics.background,
    alpha: cssAlpha(metrics.panelBackground),
    horizontalOverflow: metrics.scrollWidth > metrics.clientWidth + 4,
    verticalOverflow: metrics.scrollHeight > metrics.clientHeight + 8,
    buttonsReachable: metrics.buttonsReachable
  };
}

async function captureAndAssert(
  running: RunningApp,
  screen: string,
  width: number,
  height: number,
  expectedBackgroundFile: string,
  imageSelectors: string[]
): Promise<void> {
  const { page } = running;
  await page.waitForTimeout(400);
  const metrics = await pageMetrics(page);
  const brokenImages = await visibleImageFailures(page, imageSelectors);
  const dir = path.join(artifactRoot, `${width}x${height}`);
  ensureDir(dir);
  const screenshot = path.join(dir, `${screen}.png`);
  await captureHiddenWindow(running, screenshot);
  rows.push({
    screen,
    resolution: `${width}x${height}`,
    background: toPortableCssFileReference(root, metrics.background),
    alpha: metrics.alpha,
    horizontalOverflow: metrics.horizontalOverflow,
    verticalOverflow: metrics.verticalOverflow,
    buttonsReachable: metrics.buttonsReachable,
    brokenImages,
    screenshot: toPortableProjectPath(root, screenshot)
  });
  assert.match(metrics.background, new RegExp(expectedBackgroundFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(metrics.alpha < 1, `${screen} panel must be translucent; computed alpha=${metrics.alpha}`);
  assert.equal(metrics.horizontalOverflow, false, `${screen} has horizontal viewport overflow`);
  assert.equal(metrics.verticalOverflow, false, `${screen} has vertical viewport overflow`);
  assert.equal(metrics.buttonsReachable, true, `${screen} has unreachable visible buttons`);
  assert.deepEqual(brokenImages, [], `${screen} has unloaded or missing images`);
}

async function fillEntryForm(page: Page): Promise<void> {
  await page.locator(".entry-panel input").first().fill("E2E");
  await page.locator(".phone-row select").selectOption("010");
  await page.locator(".phone-row input").nth(0).fill("0000");
  await page.locator(".phone-row input").nth(1).fill("0000");
  await page.locator(".birth-row select").nth(0).selectOption("2000");
  await page.locator(".birth-row select").nth(1).selectOption("1");
  await page.locator(".birth-row select").nth(2).selectOption("1");
  await page.locator(".check-line input").check();
}

async function launchApp(
  variant: ApprovedUiVariant,
  scenarioRoot: string,
  width: number,
  height: number,
  nasServer: LocalNasServer,
  options: ApprovedUiRunOptions
): Promise<RunningApp> {
  const role = variant.endsWith("leaderboard") ? "leaderboard" : "player";
  const deviceId = role === "leaderboard" ? "LEADERBOARD01" : "PC01";
  writeSyntheticProfiles(scenarioRoot, role, nasServer.apiBaseUrl, nasServer.tokens[deviceId]);
  const app = await electron.launch({
    executablePath: electronExe,
    args: ["--disable-gpu", mainJs, `--variant=${variant}`],
    timeout: 30_000,
    env: {
      ...sanitizeE2eChildEnvironment(process.env),
      APP_VARIANT: variant,
      EVENT_PROFILE: "geumcheon-2026",
      PORTABLE_EXECUTABLE_DIR: scenarioRoot,
      TYPINGKING_RUNTIME_ROOT: path.join(scenarioRoot, "runtime"),
      NODE_EXTRA_CA_CERTS: nasServer.caPemPath,
      ...buildApprovedUiLaunchEnvironment(options),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
    }
  });
  try {
    const unsafeParentEnvironmentInherited = await app.evaluate((_electron) =>
      Boolean(
        process.env.NODE_TLS_REJECT_UNAUTHORIZED
        || process.env.TYPINGKING_E2E_PARENT_SECRET_PROBE
      )
    );
    assert.equal(
      unsafeParentEnvironmentInherited,
      false,
      "Electron child must not inherit parent TLS bypass or secret probe variables"
    );
    const page = await app.firstWindow({ timeout: 30_000 });
    await page.setViewportSize({ width, height });
    return { app, page };
  } catch (error) {
    const startupLogPath = path.join(scenarioRoot, "runtime", "logs", "startup_error.log");
    const startupLog = fs.existsSync(startupLogPath) ? fs.readFileSync(startupLogPath, "utf8").trim() : "missing";
    await app.close().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}; startup log=${startupLog}; NAS observations=${JSON.stringify(nasServer.observations)}`);
  }
}

async function runGame(
  variant: GameVariant,
  width: number,
  height: number,
  nasServer: LocalNasServer,
  temporaryRoot: string,
  options: ApprovedUiRunOptions
): Promise<void> {
  const scenarioRoot = path.join(temporaryRoot, `${variant}_${width}x${height}`);
  ensureDir(scenarioRoot);
  let app: RunningApp | undefined;
  try {
    app = await launchApp(variant, scenarioRoot, width, height, nasServer, options);
    const { page } = app;
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(500);
    const initialState = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: document.body.innerText.slice(0, 2000),
      eventProfile: document.documentElement.dataset.eventProfile || "",
      hasFallback: Boolean(document.querySelector(".app-fallback")),
      selectors: Array.from(document.querySelectorAll("main, section"))
        .slice(0, 20)
        .map((element) => element.className)
    }));
    const diagnosticJson = path.join(artifactRoot, `initial-state-${width}x${height}.json`);
    const diagnosticScreenshot = path.join(artifactRoot, `initial-state-${width}x${height}.png`);
    fs.writeFileSync(
      diagnosticJson,
      `${JSON.stringify(initialState, null, 2)}\n`,
      "utf8"
    );
    await captureHiddenWindow(app, diagnosticScreenshot);
    await page.locator(".entry-panel").waitFor({ state: "visible", timeout: 20_000 });
    fs.rmSync(diagnosticJson, { force: true });
    fs.rmSync(diagnosticScreenshot, { force: true });
    await captureAndAssert(
      app,
      `main-${variant}-${width}x${height}`,
      width,
      height,
      "bg_leaderboard_03_typing_hall_of_fame.png",
      [".geumcheon-main-title-image", ".geumcheon-main-robot"]
    );
    await fillEntryForm(page);
    await page.locator(".entry-panel .button-row .primary-button").first().click();
    await page.locator(".challenge-screen").waitFor({ state: "visible", timeout: 20_000 });
    await page.locator(".countdown-overlay").waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    await captureAndAssert(
      app,
      `play-${variant}-${width}x${height}`,
      width,
      height,
      "bg_main_03_geumcheon_data_city.png",
      [".geumcheon-header-title, .brand-header img", ".ai-boss-typing", ".vs-badge", ".stage-badge-img"]
    );
    const stageBadgeSources = await page.locator(".stage-badge-img").evaluateAll((images) =>
      images.map((image) => (image as HTMLImageElement).currentSrc || (image as HTMLImageElement).src)
    );
    assert.equal(stageBadgeSources.length, 3, "play screen must render three stage badge images");
    stageBadgeSources.forEach((source, index) => {
      assert.match(
        source,
        new RegExp(`/events/geumcheon-2026/assets/ai_challenge/stage_badge_${index + 1}\\.png$`),
        `stage ${index + 1} badge must use the Geumcheon event-local asset`
      );
    });
  } finally {
    await closeRunningApp(app);
  }
}

async function runLeaderboard(
  variant: LeaderboardVariant,
  width: number,
  height: number,
  nasServer: LocalNasServer,
  temporaryRoot: string,
  options: ApprovedUiRunOptions
): Promise<void> {
  const scenarioRoot = path.join(temporaryRoot, `${variant}_${width}x${height}`);
  const screenVariant = variant === "ai-leaderboard" ? "ai" : "practice";
  ensureDir(scenarioRoot);
  let app: RunningApp | undefined;
  try {
    app = await launchApp(variant, scenarioRoot, width, height, nasServer, options);
    const { page } = app;
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".leaderboard-app").waitFor({ state: "visible", timeout: 20_000 });
    const rowSelector = ".ranking-table.ai-ranking .ranking-row.ai-row";
    await page.waitForFunction(
      ({ selector, minimum }) => document.querySelectorAll(selector).length >= minimum,
      { selector: rowSelector, minimum: 10 },
      { timeout: 20_000 }
    );
    const centralTitleSelector = ".ranking-table.ai-ranking .leaderboard-ai-title-img";
    await page.locator(centralTitleSelector).waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForFunction(
      (selector) => {
        const image = document.querySelector<HTMLImageElement>(selector);
        return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
      },
      centralTitleSelector,
      { timeout: 20_000 }
    );
    await captureAndAssert(
      app,
      `leaderboard-${screenVariant}-${width}x${height}`,
      width,
      height,
      "stage_01_03_science_classroom.png",
      [".geumcheon-header-title", centralTitleSelector]
    );

    const rowCount = await page.locator(rowSelector).count();
    assert.ok(rowCount >= 10, `leaderboard must render at least 10 synthetic rows; rendered=${rowCount}`);
    const identityText = (await page.locator(rowSelector).allTextContents()).join("\n");
    const syntheticRows = syntheticLeaderboardRows();
    const rawIdentityLeaks = syntheticRows.flatMap((row) => [
      row.participant_name,
      row.phone_full,
      `${row.phone_part1}-${row.phone_part2}-${row.phone_part3}`
    ]).filter((value) => value.length > 0 && identityText.includes(value));
    if (identityText.includes("0000")) rawIdentityLeaks.push("phone_part2:0000");
    const missingMaskedIdentities = syntheticRows.flatMap((row) => [
      maskSyntheticParticipantName(row.participant_name),
      row.phone_masked
    ]).filter((value) => value.length > 0 && !identityText.includes(value));
    const rawIdentityHidden = rawIdentityLeaks.length === 0;
    const maskedIdentityVisible = missingMaskedIdentities.length === 0;
    assert.deepEqual(rawIdentityLeaks, [], "leaderboard exposed a raw synthetic identity");
    assert.deepEqual(missingMaskedIdentities, [], "leaderboard did not render every expected masked identity");

    const structure = await page.evaluate(() => {
      const app = document.querySelector<HTMLElement>(".leaderboard-app");
      const board = document.querySelector<HTMLElement>(".ranking-table.ai-ranking");
      const title = board?.querySelector<HTMLImageElement>(".leaderboard-ai-title-img");
      const titleContainer = title?.closest<HTMLElement>(".leaderboard-mode-title");
      const boardRect = board?.getBoundingClientRect();
      const titleContainerRect = titleContainer?.getBoundingClientRect();
      const titleRect = title?.getBoundingClientRect();
      const appStyle = app ? getComputedStyle(app) : undefined;
      const style = title ? getComputedStyle(title) : undefined;
      const tolerance = 1;
      const titleWithinContainer = Boolean(titleRect && titleContainerRect
        && titleRect.left >= titleContainerRect.left - tolerance
        && titleRect.right <= titleContainerRect.right + tolerance
        && titleRect.top >= titleContainerRect.top - tolerance
        && titleRect.bottom <= titleContainerRect.bottom + tolerance);
      const titleContainerWithinBoard = Boolean(titleContainerRect && boardRect
        && titleContainerRect.left >= boardRect.left - tolerance
        && titleContainerRect.right <= boardRect.right + tolerance
        && titleContainerRect.top >= boardRect.top - tolerance
        && titleContainerRect.bottom <= boardRect.bottom + tolerance);
      return {
        background: appStyle?.backgroundImage || "",
        backgroundPosition: appStyle?.backgroundPosition || "",
        backgroundSize: appStyle?.backgroundSize || "",
        backgroundRepeat: appStyle?.backgroundRepeat || "",
        titleSrc: title?.currentSrc || title?.src || "",
        titleTag: title?.tagName || "",
        titleDisplay: style?.display || "",
        titleObjectFit: style?.objectFit || "",
        inTitleContainer: Boolean(titleContainer),
        titleWithinContainer,
        titleContainerWithinBoard,
        titleCenterOffsetPx: titleRect && boardRect
          ? Math.abs((titleRect.left + titleRect.width / 2) - (boardRect.left + boardRect.width / 2))
          : Number.POSITIVE_INFINITY,
        titleContainerCenterOffsetPx: titleContainerRect && boardRect
          ? Math.abs((titleContainerRect.left + titleContainerRect.width / 2) - (boardRect.left + boardRect.width / 2))
          : Number.POSITIVE_INFINITY,
        titleCenterRatio: titleRect && boardRect && boardRect.width > 0
          ? ((titleRect.left + titleRect.width / 2) - boardRect.left) / boardRect.width
          : Number.NaN
      };
    });
    assert.match(structure.background, /stage_01_03_science_classroom\.png/);
    assert.match(structure.titleSrc, /ai_title_oneline_trimmed\.png$/);
    assert.equal(structure.titleTag, "IMG");
    assert.equal(structure.titleDisplay, "block");
    assert.equal(structure.titleObjectFit, "contain");
    assert.equal(structure.inTitleContainer, true);
    assert.equal(structure.titleWithinContainer, true, "leaderboard title must remain inside its title container");
    assert.equal(structure.titleContainerWithinBoard, true, "leaderboard title container must remain inside the approved board");
    const centerTolerancePx = Math.max(2, width * 0.002);
    assert.ok(
      structure.titleCenterOffsetPx <= centerTolerancePx,
      `leaderboard title must remain horizontally centered; offset=${structure.titleCenterOffsetPx}`
    );
    assert.ok(
      structure.titleContainerCenterOffsetPx <= centerTolerancePx,
      `leaderboard title container must remain horizontally centered; offset=${structure.titleContainerCenterOffsetPx}`
    );

    const searchInput = page.locator(".search-input");
    await searchInput.fill("1007");
    await page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length === 1,
      rowSelector,
      { timeout: 10_000 }
    );
    const searchResultCount = await page.locator(rowSelector).count();
    assert.equal(searchResultCount, 1, "masked-phone search must select one synthetic row");
    assert.match(await page.locator(rowSelector).first().innerText(), /010-\*\*\*\*-1007/);
    const evidenceDir = path.join(artifactRoot, `${width}x${height}`);
    const searchScreenshotPath = path.join(evidenceDir, `leaderboard-${screenVariant}-${width}x${height}-search.png`);
    await captureHiddenWindow(app, searchScreenshotPath);
    await searchInput.fill("");
    await page.waitForFunction(
      ({ selector, expected }) => document.querySelectorAll(selector).length === expected,
      { selector: rowSelector, expected: rowCount },
      { timeout: 10_000 }
    );
    await page.locator(rowSelector).first().scrollIntoViewIfNeeded();
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await captureHiddenWindow(
      app,
      path.join(evidenceDir, `leaderboard-${screenVariant}-${width}x${height}.png`)
    );

    const scrollMetrics = await page.locator(".ranking-table.ai-ranking .ranking-body").evaluate(async (element) => {
      const node = element as HTMLElement;
      const before = node.scrollTop;
      node.scrollTop = node.scrollHeight;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return {
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        before,
        after: node.scrollTop
      };
    });
    const scrollable = scrollMetrics.scrollHeight > scrollMetrics.clientHeight;
    const scrolled = scrollMetrics.after > scrollMetrics.before;
    assert.equal(scrollable, true, "populated leaderboard body must be scrollable");
    assert.equal(scrolled, true, "leaderboard body did not scroll to lower rows");
    const scrollScreenshotPath = path.join(evidenceDir, `leaderboard-${screenVariant}-${width}x${height}-scroll.png`);
    await captureHiddenWindow(app, scrollScreenshotPath);
    leaderboardChecks.push({
      variant,
      resolution: `${width}x${height}`,
      rowCount,
      searchResultCount,
      rawIdentityHidden,
      maskedIdentityVisible,
      rawIdentityLeakCount: rawIdentityLeaks.length,
      maskedIdentityMissingCount: missingMaskedIdentities.length,
      scrollable,
      scrolled,
      backgroundAsset: toPortableCssFileReference(root, structure.background),
      backgroundPosition: structure.backgroundPosition,
      backgroundSize: structure.backgroundSize,
      backgroundRepeat: structure.backgroundRepeat,
      titleAsset: toPortableCssFileReference(root, `url("${structure.titleSrc}")`),
      titleTag: structure.titleTag,
      titleDisplay: structure.titleDisplay,
      titleObjectFit: structure.titleObjectFit,
      titleWithinContainer: structure.titleWithinContainer,
      titleContainerWithinBoard: structure.titleContainerWithinBoard,
      titleCenterOffsetPx: structure.titleCenterOffsetPx,
      titleContainerCenterOffsetPx: structure.titleContainerCenterOffsetPx,
      titleCenterRatio: structure.titleCenterRatio,
      searchScreenshot: toPortableProjectPath(root, searchScreenshotPath),
      scrollScreenshot: toPortableProjectPath(root, scrollScreenshotPath)
    });
  } finally {
    await closeRunningApp(app);
  }
}

async function runInteractiveReview(
  options: Extract<ApprovedUiRunOptions, { mode: "interactive" }>,
  nasServer: LocalNasServer,
  temporaryRoot: string
): Promise<void> {
  const scenarioRoot = path.join(temporaryRoot, `interactive_${options.variant}`);
  ensureDir(scenarioRoot);
  let app: RunningApp | undefined;
  try {
    app = await launchApp(options.variant, scenarioRoot, 1920, 1080, nasServer, options);
    console.log("[금천 1회차 검토] 합성 Credential과 로컬 HTTPS Mock NAS를 사용 중입니다.");
    console.log("[금천 1회차 검토] 검토를 마치면 프로그램 창을 닫아 주세요.");
    await app.page.waitForEvent("close", { timeout: 0 });
  } finally {
    await closeRunningApp(app);
  }
}

function writeReport(): void {
  ensureDir(artifactRoot);
  const lines = [
    "# Geumcheon approved UI E2E",
    "",
    "| Screen | Resolution | Alpha | Horizontal overflow | Vertical overflow | Buttons reachable | Broken images | Screenshot |",
    "| -- | --: | --: | -- | -- | -- | -- | -- |",
    ...rows.map((row) =>
      `| ${row.screen} | ${row.resolution} | ${row.alpha.toFixed(3)} | ${row.horizontalOverflow ? "YES" : "NO"} | ${row.verticalOverflow ? "YES" : "NO"} | ${row.buttonsReachable ? "YES" : "NO"} | ${row.brokenImages.length ? row.brokenImages.join("<br>") : "NO"} | ${row.screenshot} |`
    ),
    "",
    "## Populated leaderboard behavior",
    "",
    "| Variant | Resolution | Rows | Search rows | Raw leaks | Missing masks | Scrollable | Scrolled | Background | Title center offset | Search screenshot | Scroll screenshot |",
    "| -- | --: | --: | --: | --: | --: | -- | -- | -- | --: | -- | -- |",
    ...leaderboardChecks.map((check) =>
      `| ${check.variant} | ${check.resolution} | ${check.rowCount} | ${check.searchResultCount} | ${check.rawIdentityLeakCount} | ${check.maskedIdentityMissingCount} | ${check.scrollable ? "YES" : "NO"} | ${check.scrolled ? "YES" : "NO"} | ${check.backgroundAsset} (${check.backgroundPosition}/${check.backgroundSize}/${check.backgroundRepeat}) | ${check.titleCenterOffsetPx.toFixed(2)} px | ${check.searchScreenshot} | ${check.scrollScreenshot} |`
    )
  ];
  fs.writeFileSync(path.join(artifactRoot, "report.md"), `${lines.join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(artifactRoot, "summary.json"), `${JSON.stringify({ rows, leaderboardChecks }, null, 2)}\n`, "utf8");
}

function assertLeaderboardResolutionParity(): void {
  for (const variant of ["ai-leaderboard", "practice-leaderboard"] as const) {
    const checks = leaderboardChecks.filter((check) => check.variant === variant);
    assert.equal(checks.length, 2, `${variant} must have populated evidence at both resolutions`);
    const structure = checks.map((check) => ({
      backgroundAsset: check.backgroundAsset,
      backgroundPosition: check.backgroundPosition,
      backgroundSize: check.backgroundSize,
      backgroundRepeat: check.backgroundRepeat,
      titleAsset: check.titleAsset,
      titleTag: check.titleTag,
      titleDisplay: check.titleDisplay,
      titleObjectFit: check.titleObjectFit,
      titleWithinContainer: check.titleWithinContainer,
      titleContainerWithinBoard: check.titleContainerWithinBoard
    }));
    assert.deepEqual(structure[0], structure[1], `${variant} title/background structure differs by resolution`);
    assert.ok(
      Math.abs(checks[0].titleCenterRatio - checks[1].titleCenterRatio) <= 0.002,
      `${variant} normalized title center differs by resolution`
    );
  }
}

async function main(): Promise<void> {
  const options = parseApprovedUiRunOptions(process.argv.slice(2));
  if (options.mode === "automated") {
    cleanDir(artifactRoot);
  } else {
    ensureDir(artifactRoot);
  }
  assert.ok(fs.existsSync(electronExe), `Electron executable not found: ${electronExe}`);
  assert.ok(fs.existsSync(mainJs), `Built Electron main not found: ${mainJs}. Run npm run build first.`);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-approved-ui-"));
  let nasServer: LocalNasServer | undefined;
  try {
    nasServer = await startLocalNasServer(temporaryRoot);
    if (options.mode === "interactive") {
      await runInteractiveReview(options, nasServer, temporaryRoot);
    } else {
      for (const size of sizes) {
        await runGame("ai", size.width, size.height, nasServer, temporaryRoot, options);
        await runLeaderboard("ai-leaderboard", size.width, size.height, nasServer, temporaryRoot, options);
        await runGame("practice", size.width, size.height, nasServer, temporaryRoot, options);
        await runLeaderboard("practice-leaderboard", size.width, size.height, nasServer, temporaryRoot, options);
      }
      assertLeaderboardResolutionParity();
    }
  } finally {
    await stopHttpsServer(nasServer?.server).catch(() => undefined);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    if (options.mode === "automated") {
      writeReport();
    }
  }
  if (options.mode === "automated") {
    console.log(JSON.stringify({
      artifactRoot,
      total: rows.length,
      populatedLeaderboards: leaderboardChecks.length,
      screenshots: [
        ...rows.map((row) => row.screenshot),
        ...leaderboardChecks.flatMap((check) => [check.searchScreenshot, check.scrollScreenshot])
      ]
    }, null, 2));
  }
}

main().catch((error) => {
  writeReport();
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
