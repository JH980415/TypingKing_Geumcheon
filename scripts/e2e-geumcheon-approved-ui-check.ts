import assert from "node:assert/strict";
import { type ChildProcess, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { sanitizeE2eChildEnvironment } from "../electron/startupProfile";
import {
  buildApprovedUiLaunchEnvironment,
  parseApprovedUiRunOptions,
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

const root = process.cwd();
const artifactRoot = path.resolve("test_artifacts", "geumcheon_approved_ui");
const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const mainJs = path.join(root, "dist-electron", "electron", "main.js");
const eventId = "geumcheon-science-festival-2026";
const officialSessionId = "approved-ui-official";
const rows: ScreenCheck[] = [];
const sizes = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 }
];

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
        rows: []
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
    background: metrics.background,
    alpha: metrics.alpha,
    horizontalOverflow: metrics.horizontalOverflow,
    verticalOverflow: metrics.verticalOverflow,
    buttonsReachable: metrics.buttonsReachable,
    brokenImages,
    screenshot
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
    await captureAndAssert(
      app,
      `leaderboard-${screenVariant}-${width}x${height}`,
      width,
      height,
      "stage_01_03_science_classroom.png",
      [".geumcheon-header-title"]
    );
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
    )
  ];
  fs.writeFileSync(path.join(artifactRoot, "report.md"), `${lines.join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(artifactRoot, "summary.json"), `${JSON.stringify({ rows }, null, 2)}\n`, "utf8");
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
    }
  } finally {
    await stopHttpsServer(nasServer?.server).catch(() => undefined);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    if (options.mode === "automated") {
      writeReport();
    }
  }
  if (options.mode === "automated") {
    console.log(JSON.stringify({ artifactRoot, total: rows.length, screenshots: rows.map((row) => row.screenshot) }, null, 2));
  }
}

main().catch((error) => {
  writeReport();
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
