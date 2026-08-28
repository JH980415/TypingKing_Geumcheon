import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { sanitizeE2eChildEnvironment } from "../electron/startupProfile";
import { RECORD_HEADER_LABELS, RECORD_HEADERS } from "../shared/constants/defaults";
import type { RecordRow } from "../shared/types";

type ScenarioKind = "window-close" | "forced-kill-restart" | "leaderboard-display";

type Check = {
  name: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
};

type ScenarioResult = {
  scenario: ScenarioKind;
  verdict: "PASS" | "FAIL";
  checks: Check[];
  record?: Pick<
    RecordRow,
    | "record_id"
    | "challenge_result_label"
    | "ai_challenge_status"
    | "ai_stage1_cpm"
    | "final_vs_ai_result"
    | "memo"
    | "result_stage"
    | "total_time_ms"
    | "participant_avg_cpm"
    | "participant_progress_percent"
  >;
  error?: string;
};

type ScenarioExecution = {
  result: ScenarioResult;
  fullRecord?: RecordRow;
};

type SnapshotRequestObservation = {
  method: string;
  pathname: string;
  queryMatched: boolean;
  authorizationMatched: boolean;
  deviceMatched: boolean;
  probe: boolean;
};

type ScenarioPaths = {
  root: string;
  artifactRoot: string;
  runtimeRoot: string;
  outboxPendingDir: string;
  outboxBlockedDir: string;
  checkpointPath: string;
  recordsPath: string;
  screenshotPath: string;
  failureScreenshotPath: string;
  uiDiagnosticPath: string;
};

const root = process.cwd();
const artifactRoot = path.resolve("test_artifacts", "geumcheon_forced_exit_e2e");
const temporaryRunRoot = path.join(os.tmpdir(), "typingking-geumcheon-forced-exit-e2e", `${process.pid}-${Date.now()}`);
const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const mainJs = path.join(root, "dist-electron", "electron", "main.js");
const pollIntervalMs = 100;
const nasEventId = "geumcheon-science-festival-2026";
const officialSessionId = "forced-exit-e2e-official";
const playerDeviceId = "PC01";
const leaderboardDeviceId = "LEADERBOARD01";
const playerToken = "6".repeat(64);
const leaderboardToken = "7".repeat(64);

export function buildForcedExitChildEnvironment(
  overrides: NodeJS.ProcessEnv,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...sanitizeE2eChildEnvironment(inheritedEnvironment),
    ...overrides
  };
}

function cleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function scenarioPaths(kind: ScenarioKind): ScenarioPaths {
  const scenarioRoot = path.join(temporaryRunRoot, kind);
  const artifactScenarioRoot = path.join(artifactRoot, "scenarios", kind);
  const runtimeRoot = path.join(scenarioRoot, "runtime");
  return {
    root: scenarioRoot,
    artifactRoot: artifactScenarioRoot,
    runtimeRoot,
    outboxPendingDir: path.join(runtimeRoot, "nas", "outbox", "official", "pending"),
    outboxBlockedDir: path.join(runtimeRoot, "nas", "outbox", "official", "blocked"),
    checkpointPath: path.join(runtimeRoot, "nas", "active-attempt-official.bin"),
    recordsPath: path.join(runtimeRoot, "data", "records.csv"),
    screenshotPath: path.join(artifactScenarioRoot, "stage-1-before-exit.png"),
    failureScreenshotPath: path.join(artifactScenarioRoot, "failure.png"),
    uiDiagnosticPath: path.join(artifactScenarioRoot, "ui-readiness-diagnostic.json")
  };
}

function writeSyntheticProfiles(scenarioRoot: string, apiBaseUrl: string): void {
  fs.mkdirSync(scenarioRoot, { recursive: true });
  fs.writeFileSync(
    path.join(scenarioRoot, "device-profile.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      eventProfileId: "geumcheon-2026",
      eventId: "geumcheon-science-festival-2026",
      deviceId: playerDeviceId,
      role: "player",
      apiBaseUrl,
      sessions: {
        official: { sessionId: "forced-exit-e2e-official", dayNo: 1, roundNo: 1 },
        practice: { sessionId: "forced-exit-e2e-practice" }
      },
      requestTimeoutMs: 1000,
      retry: { initialDelayMs: 1000, maxDelayMs: 2000 }
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(scenarioRoot, "bootstrap-credentials.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      eventId: "geumcheon-science-festival-2026",
        deviceId: playerDeviceId,
        apiBaseUrl,
        token: playerToken
    }, null, 2)}\n`,
    "utf8"
  );
}

function writeSyntheticLeaderboardProfiles(scenarioRoot: string, apiBaseUrl: string): void {
  fs.mkdirSync(scenarioRoot, { recursive: true });
  fs.writeFileSync(
    path.join(scenarioRoot, "device-profile.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      eventProfileId: "geumcheon-2026",
      eventId: nasEventId,
      deviceId: leaderboardDeviceId,
      role: "leaderboard",
      apiBaseUrl,
      sessions: {
        official: { sessionId: officialSessionId, dayNo: 1, roundNo: 1 },
        practice: { sessionId: "forced-exit-e2e-practice" }
      },
      requestTimeoutMs: 5_000,
      retry: { initialDelayMs: 1_000, maxDelayMs: 2_000 }
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(scenarioRoot, "bootstrap-credentials.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      eventId: nasEventId,
        deviceId: leaderboardDeviceId,
        apiBaseUrl,
        token: leaderboardToken
    }, null, 2)}\n`,
    "utf8"
  );
}

async function waitUntil(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<void> {
  const timeoutAt = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < timeoutAt) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  const detail = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new Error(`Timed out waiting for ${description}${detail}`);
}

function createLocalHttpsCertificate(certRoot: string): {
  pfxPath: string;
  caPemPath: string;
  passphrase: string;
} {
  fs.mkdirSync(certRoot, { recursive: true });
  const pfxPath = path.join(certRoot, "localhost.pfx");
  const caPemPath = path.join(certRoot, "ca.pem");
  const passphrase = `typingking-e2e-${process.pid}`;
  const script = String.raw`
$ErrorActionPreference = "Stop"
$pfxPath = [Environment]::GetEnvironmentVariable("TK_E2E_PFX_PATH")
$caPemPath = [Environment]::GetEnvironmentVariable("TK_E2E_CA_PEM_PATH")
$password = [Environment]::GetEnvironmentVariable("TK_E2E_PFX_PASSWORD")
$notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
$notAfter = [DateTimeOffset]::UtcNow.AddDays(1)

$caKey = [Security.Cryptography.RSA]::Create(2048)
$caRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
  "CN=TypingKing E2E Root",
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
$rng.Dispose()
$serial[0] = $serial[0] -band 0x7f
$serial[15] = $serial[15] -bor 1
$issued = $serverRequest.Create($caCertificate, $notBefore, $notAfter, $serial)
$serverCertificate = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($issued, $serverKey)

[IO.File]::WriteAllBytes(
  $pfxPath,
  $serverCertificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password)
)
$base64 = [Convert]::ToBase64String(
  $caCertificate.RawData,
  [Base64FormattingOptions]::InsertLineBreaks
)
$pem = "-----BEGIN CERTIFICATE-----" + [Environment]::NewLine + $base64 + [Environment]::NewLine + "-----END CERTIFICATE-----" + [Environment]::NewLine
[IO.File]::WriteAllText($caPemPath, $pem, [Text.Encoding]::ASCII)

$serverCertificate.Dispose()
$issued.Dispose()
$serverKey.Dispose()
$caCertificate.Dispose()
$caKey.Dispose()
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: buildForcedExitChildEnvironment({
        TK_E2E_PFX_PATH: pfxPath,
        TK_E2E_CA_PEM_PATH: caPemPath,
        TK_E2E_PFX_PASSWORD: passphrase
      })
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || !fs.existsSync(pfxPath) || !fs.existsSync(caPemPath)) {
    throw new Error(`Local HTTPS certificate generation failed: ${result.stderr || result.stdout || result.status}`);
  }
  return { pfxPath, caPemPath, passphrase };
}

async function startLocalSnapshotServer(record: RecordRow, certRoot: string): Promise<{
  server: https.Server;
  apiBaseUrl: string;
  caPemPath: string;
  observations: SnapshotRequestObservation[];
}> {
  const certificate = createLocalHttpsCertificate(certRoot);
  const observations: SnapshotRequestObservation[] = [];
  const snapshot = {
    schema_version: 1,
    event_id: nasEventId,
    session: {
      kind: "official",
      session_id: officialSessionId,
      day_no: 1,
      round_no: 1
    },
    generated_at: new Date().toISOString(),
    rows: [record]
  };
  const server = https.createServer(
    {
      pfx: fs.readFileSync(certificate.pfxPath),
      passphrase: certificate.passphrase,
      minVersion: "TLSv1.2"
    },
    (request, response) => {
      const requestUrl = new URL(request.url || "/", "https://localhost");
      const queryMatched =
        requestUrl.searchParams.get("session_kind") === "official" &&
        requestUrl.searchParams.get("session_id") === officialSessionId &&
        requestUrl.searchParams.get("day_no") === "1" &&
        requestUrl.searchParams.get("round_no") === "1";
      const authorizationMatched = request.headers.authorization === `Bearer ${leaderboardToken}`;
      const deviceMatched = request.headers["x-device-id"] === leaderboardDeviceId;
      observations.push({
        method: request.method || "",
        pathname: requestUrl.pathname,
        queryMatched,
        authorizationMatched,
        deviceMatched,
        probe: String(request.headers["user-agent"] || "").startsWith("typingking-e2e-")
      });
      if (request.method === "GET" && requestUrl.pathname === "/api/v1/ready" && queryMatched) {
        if (!authorizationMatched) {
          response.writeHead(401).end();
          return;
        }
        if (!deviceMatched) {
          response.writeHead(403).end();
          return;
        }
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        response.end(JSON.stringify({
          schema_version: 1,
          status: "ready",
          event_id: nasEventId,
          device_id: leaderboardDeviceId,
          role: "operator",
          session: snapshot.session
        }));
        return;
      }
      if (request.method !== "GET" || requestUrl.pathname !== "/api/v1/records" || !queryMatched) {
        response.writeHead(404).end();
        return;
      }
      if (!authorizationMatched) {
        response.writeHead(401).end();
        return;
      }
      if (!deviceMatched) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify(snapshot));
    }
  );
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Local HTTPS snapshot server did not expose a TCP port");
  }
  return {
    server,
    apiBaseUrl: `https://127.0.0.1:${address.port}`,
    caPemPath: certificate.caPemPath,
    observations
  };
}

async function startLocalHealthServer(certRoot: string): Promise<{
  server: https.Server;
  apiBaseUrl: string;
  caPemPath: string;
  observations: SnapshotRequestObservation[];
}> {
  const certificate = createLocalHttpsCertificate(certRoot);
  const observations: SnapshotRequestObservation[] = [];
  const server = https.createServer(
    {
      pfx: fs.readFileSync(certificate.pfxPath),
      passphrase: certificate.passphrase,
      minVersion: "TLSv1.2"
    },
    (request, response) => {
      const requestUrl = new URL(request.url || "/", "https://localhost");
      if (request.method !== "GET" || requestUrl.pathname !== "/api/v1/ready") {
        response.writeHead(503, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        response.end(JSON.stringify({ error: "test server offline" }));
        return;
      }
      const queryMatched = requestUrl.searchParams.get("session_kind") === "official"
        && requestUrl.searchParams.get("session_id") === officialSessionId
        && requestUrl.searchParams.get("day_no") === "1"
        && requestUrl.searchParams.get("round_no") === "1";
      const authorizationMatched = request.headers.authorization === `Bearer ${playerToken}`;
      const deviceMatched = request.headers["x-device-id"] === playerDeviceId;
      observations.push({
        method: request.method || "",
        pathname: requestUrl.pathname,
        queryMatched,
        authorizationMatched,
        deviceMatched,
        probe: true
      });
      if (!authorizationMatched) {
        response.writeHead(401).end();
        return;
      }
      if (!deviceMatched || !queryMatched) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify({
        schema_version: 1,
        status: "ready",
        event_id: nasEventId,
        device_id: playerDeviceId,
        role: "writer",
        session: {
          kind: "official",
          session_id: officialSessionId,
          day_no: 1,
          round_no: 1
        }
      }));
    }
  );
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Local HTTPS health server did not expose a TCP port");
  }
  return {
    server,
    apiBaseUrl: `https://127.0.0.1:${address.port}`,
    caPemPath: certificate.caPemPath,
    observations
  };
}

async function stopHttpsServer(server: https.Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function probeLocalHttps(apiBaseUrl: string, caPemPath: string): Promise<{ status: number | null; stderr: string }> {
  const script = String.raw`
const query = new URLSearchParams({
  session_kind: "official",
  session_id: process.env.TK_E2E_SESSION_ID,
  day_no: "1",
  round_no: "1"
});
fetch(process.env.TK_E2E_API_BASE_URL + "/api/v1/records?" + query.toString(), {
  signal: AbortSignal.timeout(5000),
  headers: {
    authorization: "Bearer " + process.env.TK_E2E_TOKEN,
    "x-device-id": process.env.TK_E2E_DEVICE_ID,
    accept: "application/json",
    "user-agent": "typingking-e2e-node-probe"
  }
}).then((response) => {
  process.exitCode = response.ok ? 0 : 2;
}).catch((error) => {
  console.error(error && error.cause && error.cause.code ? error.cause.code : String(error));
  process.exitCode = 1;
});
`;
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    env: buildForcedExitChildEnvironment({
      NODE_EXTRA_CA_CERTS: caPemPath,
      TK_E2E_API_BASE_URL: apiBaseUrl,
      TK_E2E_SESSION_ID: officialSessionId,
      TK_E2E_TOKEN: leaderboardToken,
      TK_E2E_DEVICE_ID: leaderboardDeviceId
    })
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-4_000);
  });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status) => resolve({ status, stderr: stderr.trim() }));
  });
}

function forceKillProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || !pid || pid < 1) throw new Error("Refusing to kill a process without an exact positive PID");
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && child.exitCode === null && child.signalCode === null) {
      throw new Error(`taskkill failed for PID ${pid}: ${result.stderr || result.stdout}`);
    }
    return;
  }
  child.kill("SIGKILL");
}

async function stopProcess(child: ChildProcess | undefined, force = false): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (force) forceKillProcessTree(child);
  else child.kill();
  await waitUntil(`process ${child.pid} to exit`, () => child.exitCode !== null || child.signalCode !== null, 5_000)
    .catch(() => {
      forceKillProcessTree(child);
    });
  await waitUntil(`process ${child.pid} forced cleanup`, () => child.exitCode !== null || child.signalCode !== null, 5_000);
}

async function cleanupApp(app: ElectronApplication | undefined, child: ChildProcess | undefined): Promise<void> {
  await stopProcess(child, true).catch(() => undefined);
  if (!app) return;
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000))
  ]);
}

async function launchApp(paths: ScenarioPaths, caPemPath: string): Promise<ElectronApplication> {
  return await electron.launch({
    executablePath: electronExe,
    args: ["--disable-gpu", mainJs, "--variant=ai"],
    timeout: 15_000,
    env: buildForcedExitChildEnvironment({
      APP_VARIANT: "ai",
      EVENT_PROFILE: "geumcheon-2026",
      PORTABLE_EXECUTABLE_DIR: paths.root,
      TYPINGKING_RUNTIME_ROOT: paths.runtimeRoot,
      NODE_EXTRA_CA_CERTS: caPemPath,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
    })
  });
}

async function launchLeaderboardApp(paths: ScenarioPaths, caPemPath: string): Promise<ElectronApplication> {
  return await electron.launch({
    executablePath: electronExe,
    args: ["--disable-gpu", mainJs, "--variant=ai-leaderboard"],
    timeout: 15_000,
    env: buildForcedExitChildEnvironment({
      APP_VARIANT: "ai-leaderboard",
      EVENT_PROFILE: "geumcheon-2026",
      PORTABLE_EXECUTABLE_DIR: paths.root,
      TYPINGKING_RUNTIME_ROOT: paths.runtimeRoot,
      NODE_EXTRA_CA_CERTS: caPemPath,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
    })
  });
}

async function installSyntheticNasReadiness(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("records:checkStartReady");
    ipcMain.handle("records:checkStartReady", () => ({
      ok: true,
      data: { ready: true }
    }));
  });
}

async function installSyntheticLeaderboardRecords(
  app: ElectronApplication,
  record: RecordRow
): Promise<void> {
  await app.evaluate(({ ipcMain }, row) => {
    ipcMain.removeHandler("records:list");
    ipcMain.handle("records:list", () => ({
      ok: true,
      data: [row]
    }));
  }, record);
}

async function visibleLocatorCount(page: Page, selector: string): Promise<number> {
  const locator = page.locator(selector);
  const count = await locator.count();
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) visible += 1;
  }
  return visible;
}

async function collectUiReadinessDiagnostic(page: Page): Promise<Record<string, unknown>> {
  const [
    title,
    readyState,
    hasTypingKing,
    entryPanels,
    visibleEntryPanels,
    emptyStates,
    visibleEmptyStates,
    appFallbacks,
    visibleAppFallbacks,
    challengeScreens,
    visibleChallengeScreens,
    rawBodyText
  ] = await Promise.all([
    page.title().catch((error) => `TITLE_READ_FAILED:${error instanceof Error ? error.message : String(error)}`),
    page.evaluate(() => document.readyState).catch((error) => `READY_STATE_READ_FAILED:${error instanceof Error ? error.message : String(error)}`),
    page.evaluate(() => Boolean((window as any).typingKing)).catch(() => false),
    page.locator(".entry-panel").count().catch(() => 0),
    visibleLocatorCount(page, ".entry-panel").catch(() => 0),
    page.locator(".empty-state").count().catch(() => 0),
    visibleLocatorCount(page, ".empty-state").catch(() => 0),
    page.locator(".app-fallback").count().catch(() => 0),
    visibleLocatorCount(page, ".app-fallback").catch(() => 0),
    page.locator(".challenge-screen").count().catch(() => 0),
    visibleLocatorCount(page, ".challenge-screen").catch(() => 0),
    page.locator("body").innerText({ timeout: 1_000 }).catch((error) => `BODY_TEXT_READ_FAILED:${error instanceof Error ? error.message : String(error)}`)
  ]);
  const bodyText = String(rawBodyText)
    .replace(/\s+/g, " ")
    .replace(/강제종료 E2E/g, "[participant]")
    .replace(/010[-\s]?0000[-\s]?0000/g, "[phone]")
    .slice(0, 800);
  return {
    url: page.url(),
    title,
    readyState,
    hasTypingKing,
    entryPanels,
    visibleEntryPanels,
    emptyStates,
    visibleEmptyStates,
    appFallbacks,
    visibleAppFallbacks,
    challengeScreens,
    visibleChallengeScreens,
    bodyText
  };
}

async function writeFailureDiagnostics(page: Page, paths: ScenarioPaths): Promise<void> {
  fs.mkdirSync(paths.artifactRoot, { recursive: true });
  const diagnostic = await collectUiReadinessDiagnostic(page).catch((error) => ({
    diagnosticError: error instanceof Error ? error.message : String(error),
    url: page.url()
  }));
  fs.writeFileSync(paths.uiDiagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
  await page.screenshot({ path: paths.failureScreenshotPath, fullPage: false }).catch(() => undefined);
}

async function waitForMeaningfulStartUi(page: Page, paths: ScenarioPaths): Promise<void> {
  await waitUntil("meaningful start UI", async () => {
    if (await page.locator(".entry-panel").first().isVisible().catch(() => false)) return true;
    const hasFallback = await page.locator(".empty-state, .app-fallback").first().isVisible().catch(() => false);
    if (hasFallback) {
      const diagnostic = await collectUiReadinessDiagnostic(page);
      throw new Error(`Renderer reached fallback UI: ${JSON.stringify(diagnostic)}`);
    }
    return false;
  }, 45_000).catch(async (error) => {
    await writeFailureDiagnostics(page, paths).catch(() => undefined);
    const diagnostic = await collectUiReadinessDiagnostic(page).catch((caught) => ({
      diagnosticError: caught instanceof Error ? caught.message : String(caught),
      url: page.url()
    }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}; ui=${JSON.stringify(diagnostic)}`);
  });
}
async function prepareAttempt(page: Page, paths: ScenarioPaths): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).typingKing), undefined, { timeout: 15_000 });

  await waitForMeaningfulStartUi(page, paths);
  await page.locator(".entry-panel .field input").first().fill("강제종료 E2E");
  await page.locator(".phone-row select").selectOption("010");
  await page.locator(".phone-row input").nth(0).fill("0000");
  await page.locator(".phone-row input").nth(1).fill("0000");
  await page.locator(".birth-row select").nth(0).selectOption("2014");
  await page.locator(".birth-row select").nth(1).selectOption("1");
  await page.locator(".birth-row select").nth(2).selectOption("1");
  await page.locator(".check-line input").check();
  await page.locator(".entry-panel .button-row .primary-button").first().click();

  await page.locator(".challenge-screen").waitFor({ state: "visible", timeout: 15_000 }).catch(async (error) => {
    await writeFailureDiagnostics(page, paths).catch(() => undefined);
    const diagnostic = await collectUiReadinessDiagnostic(page).catch((caught) => ({
      diagnosticError: caught instanceof Error ? caught.message : String(caught),
      url: page.url()
    }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}; ui=${JSON.stringify(diagnostic)}`);
  });
  const countdown = page.locator(".countdown-overlay");
  await countdown.waitFor({ state: "visible", timeout: 7_000 });
  await countdown.waitFor({ state: "hidden", timeout: 7_000 });

  const target = ((await page.locator(".duel-target").first().textContent()) ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[\r\n]/g, "")
    .trim();
  const targetChars = Array.from(target);
  if (targetChars.length < 6) throw new Error(`Stage 1 target is too short for partial typo scenario: ${target}`);
  const correctPrefix = targetChars.slice(0, 4).join("");
  const wrongChar = targetChars[4] === "!" ? "?" : "!";
  const typed = `${correctPrefix}${wrongChar}`;
  const input = page.locator("textarea:visible").first();
  await input.fill(typed);
  await page.waitForFunction(
    (expected) => {
      const value = (document.querySelector("textarea:enabled") as HTMLTextAreaElement | null)?.value ?? "";
      const correct = document.querySelectorAll(".user-duel .duel-input-highlight .correct").length;
      const wrong = document.querySelectorAll(".user-duel .duel-input-highlight .wrong").length;
      return value.replace(/[\r\n]/g, "") === expected && correct > 0 && wrong > 0;
    },
    typed,
    { timeout: 5_000 }
  );
  await page.waitForFunction(() => {
    const text = document.querySelector(".user-duel .duel-metrics")?.textContent ?? "";
    return /[1-9][0-9,.]*타\/분/.test(text);
  }, undefined, { timeout: 5_000 });
  fs.mkdirSync(path.dirname(paths.screenshotPath), { recursive: true });
  await page.screenshot({ path: paths.screenshotPath, fullPage: false });
}

function readLocalRecords(recordsPath: string): RecordRow[] {
  if (!fs.existsSync(recordsPath)) return [];
  const rows = parse(fs.readFileSync(recordsPath, "utf8"), {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true
  }) as Array<Record<string, string>>;
  return rows.map((source) => Object.fromEntries(
    RECORD_HEADERS.map((key) => [key, source[key] ?? source[RECORD_HEADER_LABELS[key]] ?? ""])
  ) as unknown as RecordRow);
}

async function waitForLocalRecord(recordsPath: string): Promise<RecordRow | undefined> {
  let record: RecordRow | undefined;
  await waitUntil("one local RecordRow", () => {
    const rows = readLocalRecords(recordsPath);
    record = rows.length === 1 ? rows[0] : undefined;
    return Boolean(record);
  }, 10_000).catch(() => undefined);
  return record;
}

function addCheck(checks: Check[], name: string, actual: unknown, expected: unknown, passed: boolean): void {
  checks.push({ name, actual, expected, passed });
}

function addRecordChecks(checks: Check[], row: RecordRow | undefined): void {
  addCheck(checks, "local RecordRow exists", Boolean(row), true, Boolean(row));
  if (!row) return;
  for (const [field, expected] of [
    ["challenge_result_label", "중단 패배"],
    ["ai_challenge_status", "FAILED"],
    ["final_vs_ai_result", "AI_WIN"],
    ["memo", "사용자 중단:프로그램 종료"],
    ["result_stage", "1"]
  ] as const) {
    addCheck(checks, field, row[field], expected, row[field] === expected);
  }
  for (const field of ["total_time_ms", "participant_avg_cpm", "participant_progress_percent"] as const) {
    const numeric = Number(row[field]);
    addCheck(checks, `${field} > 0`, row[field], "> 0", Number.isFinite(numeric) && numeric > 0);
  }
  const stageOneAiCpm = Number(row.ai_stage1_cpm);
  addCheck(
    checks,
    "ai_stage1_cpm in official range",
    row.ai_stage1_cpm,
    "150-200",
    Number.isFinite(stageOneAiCpm) && stageOneAiCpm >= 150 && stageOneAiCpm <= 200
  );
}

function addOutboxChecks(checks: Check[], paths: ScenarioPaths, row: RecordRow | undefined): void {
  const names = fs.existsSync(paths.outboxPendingDir)
    ? fs.readdirSync(paths.outboxPendingDir).filter((name) => name.endsWith(".bin")).sort()
    : [];
  const blockedNames = fs.existsSync(paths.outboxBlockedDir)
    ? fs.readdirSync(paths.outboxBlockedDir).filter((name) => name.endsWith(".bin")).sort()
    : [];
  addCheck(checks, "exactly one encrypted NAS outbox file", names.length, 1, names.length === 1);
  addCheck(checks, "no blocked NAS outbox files", blockedNames, [], blockedNames.length === 0);

  const expectedName = row ? `${row.record_id}.bin` : undefined;
  addCheck(
    checks,
    "outbox filename uses stable record ID",
    names,
    expectedName ? [expectedName] : "local RecordRow required",
    Boolean(expectedName) && names.length === 1 && names[0] === expectedName
  );

  const outboxBytes = expectedName && names[0] === expectedName
    ? fs.readFileSync(path.join(paths.outboxPendingDir, expectedName))
    : undefined;
  const plaintextNameVisible = outboxBytes?.includes(Buffer.from("강제종료 E2E", "utf8"));
  const plaintextPhoneVisible = outboxBytes?.includes(Buffer.from("01000000000", "utf8"));
  addCheck(checks, "outbox hides plaintext participant name", plaintextNameVisible, false, plaintextNameVisible === false);
  addCheck(checks, "outbox hides plaintext phone number", plaintextPhoneVisible, false, plaintextPhoneVisible === false);
}

function summarizedRecord(row: RecordRow | undefined): ScenarioResult["record"] {
  if (!row) return undefined;
  return {
    record_id: row.record_id,
    challenge_result_label: row.challenge_result_label,
    ai_challenge_status: row.ai_challenge_status,
    ai_stage1_cpm: row.ai_stage1_cpm,
    final_vs_ai_result: row.final_vs_ai_result,
    memo: row.memo,
    result_stage: row.result_stage,
    total_time_ms: row.total_time_ms,
    participant_avg_cpm: row.participant_avg_cpm,
    participant_progress_percent: row.participant_progress_percent
  };
}

async function runWindowClose(): Promise<ScenarioExecution> {
  const paths = scenarioPaths("window-close");
  cleanDir(paths.root);
  fs.mkdirSync(paths.artifactRoot, { recursive: true });
  const checks: Check[] = [];
  let readinessServer: Awaited<ReturnType<typeof startLocalHealthServer>> | undefined;
  let app: ElectronApplication | undefined;
  let appProcess: ChildProcess | undefined;
  let row: RecordRow | undefined;
  let error: string | undefined;
  try {
    readinessServer = await startLocalHealthServer(path.join(paths.root, "certs"));
    writeSyntheticProfiles(paths.root, readinessServer.apiBaseUrl);
    app = await launchApp(paths, readinessServer.caPemPath);
    appProcess = app.process();
    const page = await app.firstWindow({ timeout: 15_000 });
    await installSyntheticNasReadiness(app);
    await prepareAttempt(page, paths);
    const window = await app.browserWindow(page);
    await window.evaluate((browserWindow) => browserWindow.close()).catch(() => undefined);
    await waitUntil("Electron exit after BrowserWindow close", () => (
      appProcess!.exitCode !== null || appProcess!.signalCode !== null
    ), 10_000);
    row = await waitForLocalRecord(paths.recordsPath);
    addCheck(checks, "exactly one local record", readLocalRecords(paths.recordsPath).length, 1, readLocalRecords(paths.recordsPath).length === 1);
    addRecordChecks(checks, row);
    addOutboxChecks(checks, paths, row);
  } catch (caught) {
    const failure = caught instanceof Error ? caught.stack || caught.message : String(caught);
    const startupLogPath = path.join(paths.runtimeRoot, "logs", "startup_error.log");
    const startupLog = fs.existsSync(startupLogPath) ? fs.readFileSync(startupLogPath, "utf8").trim() : "";
    error = `${failure}\nreadiness=${JSON.stringify(readinessServer?.observations ?? [])}\nstartup=${startupLog}`;
  } finally {
    await cleanupApp(app, appProcess);
    await stopHttpsServer(readinessServer?.server);
  }
  if (error) addCheck(checks, "scenario completed without harness error", error, "no error", false);
  return {
    result: {
      scenario: "window-close",
      verdict: checks.length > 0 && checks.every((check) => check.passed) ? "PASS" : "FAIL",
      checks,
      record: summarizedRecord(row),
      error
    },
    fullRecord: row
  };
}

async function runForcedKillRestart(): Promise<ScenarioExecution> {
  const paths = scenarioPaths("forced-kill-restart");
  cleanDir(paths.root);
  fs.mkdirSync(paths.artifactRoot, { recursive: true });
  const checks: Check[] = [];
  let readinessServer: Awaited<ReturnType<typeof startLocalHealthServer>> | undefined;
  let firstApp: ElectronApplication | undefined;
  let firstProcess: ChildProcess | undefined;
  let restartedApp: ElectronApplication | undefined;
  let restartedProcess: ChildProcess | undefined;
  let row: RecordRow | undefined;
  let error: string | undefined;
  try {
    readinessServer = await startLocalHealthServer(path.join(paths.root, "certs"));
    writeSyntheticProfiles(paths.root, readinessServer.apiBaseUrl);
    firstApp = await launchApp(paths, readinessServer.caPemPath);
    firstProcess = firstApp.process();
    const page = await firstApp.firstWindow({ timeout: 15_000 });
    await installSyntheticNasReadiness(firstApp);
    await prepareAttempt(page, paths);

    const preRestartRecordCount = readLocalRecords(paths.recordsPath).length;
    let checkpointBeforeRestart = false;
    await waitUntil("encrypted active-attempt checkpoint", () => fs.existsSync(paths.checkpointPath), 5_000)
      .then(() => { checkpointBeforeRestart = true; })
      .catch(() => undefined);
    addCheck(checks, "no local record before forced exit", preRestartRecordCount, 0, preRestartRecordCount === 0);
    addCheck(checks, "encrypted checkpoint exists before forced exit", checkpointBeforeRestart, true, checkpointBeforeRestart);

    await stopProcess(firstProcess, true);
    firstApp = undefined;
    firstProcess = undefined;

    restartedApp = await launchApp(paths, readinessServer.caPemPath);
    restartedProcess = restartedApp.process();
    await restartedApp.firstWindow({ timeout: 15_000 });
    row = await waitForLocalRecord(paths.recordsPath);
    const postRestartRecordCount = readLocalRecords(paths.recordsPath).length;
    let checkpointRemoved = false;
    await waitUntil("active-attempt checkpoint removal", () => !fs.existsSync(paths.checkpointPath), 5_000)
      .then(() => { checkpointRemoved = true; })
      .catch(() => undefined);
    addCheck(checks, "exactly one recovered local record", postRestartRecordCount, 1, postRestartRecordCount === 1);
    addCheck(checks, "checkpoint removed after recovery", checkpointRemoved, true, checkpointRemoved);
    addRecordChecks(checks, row);
    addOutboxChecks(checks, paths, row);
  } catch (caught) {
    const failure = caught instanceof Error ? caught.stack || caught.message : String(caught);
    const startupLogPath = path.join(paths.runtimeRoot, "logs", "startup_error.log");
    const startupLog = fs.existsSync(startupLogPath) ? fs.readFileSync(startupLogPath, "utf8").trim() : "";
    error = `${failure}\nreadiness=${JSON.stringify(readinessServer?.observations ?? [])}\nstartup=${startupLog}`;
  } finally {
    await cleanupApp(firstApp, firstProcess);
    await cleanupApp(restartedApp, restartedProcess);
    await stopHttpsServer(readinessServer?.server);
  }
  if (error) addCheck(checks, "scenario completed without harness error", error, "no error", false);
  return {
    result: {
      scenario: "forced-kill-restart",
      verdict: checks.length > 0 && checks.every((check) => check.passed) ? "PASS" : "FAIL",
      checks,
      record: summarizedRecord(row),
      error
    },
    fullRecord: row
  };
}

function truncatedDecimal(value: number, digits: number, fixed = false): string {
  if (!Number.isFinite(value)) return "0";
  const factor = 10 ** digits;
  const truncated = Math.trunc(value * factor) / factor;
  return fixed ? truncated.toFixed(digits) : String(truncated);
}

function expectedLeaderboardProgress(record: RecordRow): string {
  const value = Number(record.participant_progress_percent);
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return `진행률 ${truncatedDecimal(clamped, 2, true)}%`;
}

function expectedLeaderboardCpm(record: RecordRow): string {
  const value = Number(record.participant_avg_cpm);
  return Number.isFinite(value) ? `평균 ${truncatedDecimal(value, 2)}타` : "평균 산정불가";
}

function expectedLeaderboardStage(record: RecordRow): string {
  const numeric = Number(record.result_stage);
  const stage = Number.isFinite(numeric) ? Math.max(1, Math.min(3, Math.round(numeric))) : 1;
  return `Stage ${stage}`;
}

function expectedLeaderboardTime(record: RecordRow): string {
  const rawTime = Number(record.duel_time_ms || record.total_time_ms);
  if (!Number.isFinite(rawTime)) return "산정불가";
  const numericStage = Number(record.result_stage);
  const stage = Number.isFinite(numericStage) ? Math.max(1, Math.min(3, Math.round(numericStage))) : 1;
  const charCount = [record.stage1_char_count, record.stage2_char_count, record.stage3_char_count]
    .slice(0, stage)
    .reduce((sum, value) => {
      const numeric = Number(value);
      return sum + (Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0);
    }, 0);
  return `${truncatedDecimal(rawTime / 1000, 2, true)}초, ${Math.trunc(charCount).toLocaleString("ko-KR")}글자`;
}

async function runLeaderboardDisplay(sourceRecord: RecordRow): Promise<ScenarioResult> {
  const paths = scenarioPaths("leaderboard-display");
  cleanDir(paths.root);
  fs.mkdirSync(paths.artifactRoot, { recursive: true });
  const checks: Check[] = [];
  let app: ElectronApplication | undefined;
  let appProcess: ChildProcess | undefined;
  let page: Page | undefined;
  let snapshotServer: Awaited<ReturnType<typeof startLocalSnapshotServer>> | undefined;
  let error: string | undefined;
  try {
    snapshotServer = await startLocalSnapshotServer(sourceRecord, path.join(paths.root, "certs"));
    const tlsProbe = await probeLocalHttps(snapshotServer.apiBaseUrl, snapshotServer.caPemPath);
    addCheck(checks, "Node trusts throwaway local CA", tlsProbe.status, 0, tlsProbe.status === 0);
    if (tlsProbe.status !== 0) {
      throw new Error(`Node TLS probe failed: ${tlsProbe.stderr || tlsProbe.status}`);
    }
    writeSyntheticLeaderboardProfiles(paths.root, snapshotServer.apiBaseUrl);
    app = await launchLeaderboardApp(paths, snapshotServer.caPemPath);
    appProcess = app.process();
    page = await app.firstWindow({ timeout: 20_000 });
    await page.waitForFunction(() => Boolean((window as any).typingKing), undefined, { timeout: 15_000 });
    const caEnvVisible = await app.evaluate((_electron) => Boolean(process.env.NODE_EXTRA_CA_CERTS));
    addCheck(checks, "Electron main receives extra CA path", caEnvVisible, true, caEnvVisible);
    const electronTlsProbe = await app.evaluate(async (_electron, input) => {
      try {
        const query = new URLSearchParams({
          session_kind: "official",
          session_id: input.sessionId,
          day_no: "1",
          round_no: "1"
        });
        const response = await fetch(`${input.apiBaseUrl}/api/v1/records?${query.toString()}`, {
          signal: AbortSignal.timeout(5_000),
          headers: {
            authorization: `Bearer ${input.token}`,
            "x-device-id": input.deviceId,
            accept: "application/json",
            "user-agent": "typingking-e2e-electron-probe"
          }
        });
        return { ok: response.ok, status: response.status, errorCode: "" };
      } catch (caught) {
        const error = caught as { cause?: { code?: unknown }; code?: unknown };
        const errorCode = typeof error.cause?.code === "string"
          ? error.cause.code
          : typeof error.code === "string"
            ? error.code
            : "UNKNOWN";
        return { ok: false, status: 0, errorCode };
      }
    }, {
      apiBaseUrl: snapshotServer.apiBaseUrl,
      sessionId: officialSessionId,
      token: leaderboardToken,
      deviceId: leaderboardDeviceId
    });
    addCheck(
      checks,
      "Electron main trusts throwaway local CA",
      electronTlsProbe.ok ? electronTlsProbe.status : electronTlsProbe.errorCode,
      200,
      electronTlsProbe.ok && electronTlsProbe.status === 200
    );
    if (!electronTlsProbe.ok) {
      throw new Error(`Electron main TLS probe failed: ${electronTlsProbe.errorCode}`);
    }

    const interruptedRow = page.locator(".ranking-row.ai-row").filter({
      has: page.locator(".result-lose", { hasText: "중단 패배" })
    }).first();
    await interruptedRow.waitFor({ state: "visible", timeout: 20_000 });

    const resultLabel = ((await interruptedRow.locator(".result-lose").textContent()) || "").trim();
    const stageText = ((await interruptedRow.locator("span").nth(4).textContent()) || "").trim();
    const participantStatus = interruptedRow.locator(".status-cell").first();
    const progressText = ((await participantStatus.locator("strong").textContent()) || "").trim();
    const cpmText = ((await participantStatus.locator("em").textContent()) || "").trim();
    const timeText = ((await interruptedRow.locator(".time-cell").textContent()) || "").trim();

    addCheck(checks, "leaderboard interrupted result label", resultLabel, "중단 패배", resultLabel === "중단 패배");
    const expectedStage = expectedLeaderboardStage(sourceRecord);
    addCheck(checks, "leaderboard exit stage", stageText, expectedStage, stageText === expectedStage);
    const expectedProgress = expectedLeaderboardProgress(sourceRecord);
    addCheck(checks, "leaderboard participant progress", progressText, expectedProgress, progressText === expectedProgress);
    const expectedCpm = expectedLeaderboardCpm(sourceRecord);
    addCheck(checks, "leaderboard participant average CPM", cpmText, expectedCpm, cpmText === expectedCpm);
    const expectedTime = expectedLeaderboardTime(sourceRecord);
    addCheck(checks, "leaderboard exit time and stage characters", timeText, expectedTime, timeText === expectedTime);

    const matchingRequests = snapshotServer.observations.filter((observation) =>
      !observation.probe &&
      observation.method === "GET" &&
      observation.pathname === "/api/v1/records" &&
      observation.queryMatched &&
      observation.authorizationMatched &&
      observation.deviceMatched
    ).length;
    addCheck(
      checks,
      "leaderboard authenticated HTTPS snapshot request",
      matchingRequests,
      ">= 1",
      matchingRequests >= 1
    );
    await interruptedRow.screenshot({ path: path.join(paths.artifactRoot, "interrupted-row.png") });
  } catch (caught) {
    error = caught instanceof Error ? caught.stack || caught.message : String(caught);
    if (snapshotServer) {
      const reachedServer = snapshotServer.observations.length;
      const matchedRequest = snapshotServer.observations.some((observation) =>
        !observation.probe &&
        observation.method === "GET" &&
        observation.pathname === "/api/v1/records" &&
        observation.queryMatched &&
        observation.authorizationMatched &&
        observation.deviceMatched
      );
      addCheck(checks, "HTTPS requests reached local snapshot server", reachedServer, ">= 1", reachedServer >= 1);
      addCheck(checks, "HTTPS request contract matched", matchedRequest, true, matchedRequest);
    }
    if (page) await writeFailureDiagnostics(page, paths).catch(() => undefined);
  } finally {
    await cleanupApp(app, appProcess);
    await stopHttpsServer(snapshotServer?.server).catch(() => undefined);
  }
  if (error) addCheck(checks, "scenario completed without harness error", error, "no error", false);
  return {
    scenario: "leaderboard-display",
    verdict: checks.length > 0 && checks.every((check) => check.passed) ? "PASS" : "FAIL",
    checks,
    record: summarizedRecord(sourceRecord),
    error
  };
}

async function runLeaderboardDisplaySynthetic(sourceRecord: RecordRow): Promise<ScenarioResult> {
  const paths = scenarioPaths("leaderboard-display");
  cleanDir(paths.root);
  fs.mkdirSync(paths.artifactRoot, { recursive: true });
  writeSyntheticLeaderboardProfiles(paths.root, "https://records.example.invalid");
  const checks: Check[] = [];
  let app: ElectronApplication | undefined;
  let appProcess: ChildProcess | undefined;
  let page: Page | undefined;
  let error: string | undefined;
  try {
    app = await launchLeaderboardApp(paths, "");
    appProcess = app.process();
    page = await app.firstWindow({ timeout: 20_000 });
    await installSyntheticLeaderboardRecords(app, sourceRecord);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean((window as any).typingKing), undefined, { timeout: 15_000 });

    const interruptedRow = page.locator(".ranking-row.ai-row").filter({
      has: page.locator(".result-lose", { hasText: "중단 패배" })
    }).first();
    await interruptedRow.waitFor({ state: "visible", timeout: 20_000 });

    const resultLabel = ((await interruptedRow.locator(".result-lose").textContent()) || "").trim();
    const stageText = ((await interruptedRow.locator("span").nth(4).textContent()) || "").trim();
    const participantStatus = interruptedRow.locator(".status-cell").first();
    const progressText = ((await participantStatus.locator("strong").textContent()) || "").trim();
    const cpmText = ((await participantStatus.locator("em").textContent()) || "").trim();
    const timeText = ((await interruptedRow.locator(".time-cell").textContent()) || "").trim();

    addCheck(checks, "leaderboard interrupted result label", resultLabel, "중단 패배", resultLabel === "중단 패배");
    const expectedStage = expectedLeaderboardStage(sourceRecord);
    addCheck(checks, "leaderboard exit stage", stageText, expectedStage, stageText === expectedStage);
    const expectedProgress = expectedLeaderboardProgress(sourceRecord);
    addCheck(checks, "leaderboard participant progress", progressText, expectedProgress, progressText === expectedProgress);
    const expectedCpm = expectedLeaderboardCpm(sourceRecord);
    addCheck(checks, "leaderboard participant average CPM", cpmText, expectedCpm, cpmText === expectedCpm);
    const expectedTime = expectedLeaderboardTime(sourceRecord);
    addCheck(checks, "leaderboard exit time and stage characters", timeText, expectedTime, timeText === expectedTime);
    addCheck(checks, "leaderboard source isolated from external NAS", "synthetic records:list IPC", "synthetic records:list IPC", true);
    await interruptedRow.screenshot({ path: path.join(paths.artifactRoot, "interrupted-row.png") });
  } catch (caught) {
    error = caught instanceof Error ? caught.stack || caught.message : String(caught);
    if (page) {
      await writeFailureDiagnostics(page, paths).catch(() => undefined);
    }
  } finally {
    await cleanupApp(app, appProcess);
  }
  if (error) addCheck(checks, "scenario completed without harness error", error, "no error", false);
  return {
    scenario: "leaderboard-display",
    verdict: checks.length > 0 && checks.every((check) => check.passed) ? "PASS" : "FAIL",
    checks,
    record: summarizedRecord(sourceRecord),
    error
  };
}

function writeReport(results: ScenarioResult[]): void {
  const summary = {
    generatedAt: new Date().toISOString(),
    contract: {
      artifactRoot,
      files: {
        machineReadable: "summary.json",
        humanReadable: "report.md",
        screenshots: [
          "scenarios/window-close/stage-1-before-exit.png",
          "scenarios/forced-kill-restart/stage-1-before-exit.png",
          "scenarios/leaderboard-display/interrupted-row.png"
        ],
        observations: "scenarios/<scenario>/observed.json"
      },
      privacy: "summary/report/observed files include only asserted RecordRow fields, stable outbox filenames, and boolean plaintext checks; synthetic participant source data stays in the temporary runtime and is deleted"
    },
    total: results.length,
    passed: results.filter((result) => result.verdict === "PASS").length,
    failed: results.filter((result) => result.verdict === "FAIL").length,
    results
  };
  for (const result of results) {
    const dir = path.join(artifactRoot, "scenarios", result.scenario);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "observed.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  fs.writeFileSync(path.join(artifactRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const lines = [
    "# Geumcheon forced-exit E2E report",
    "",
    `- Generated: ${summary.generatedAt}`,
    `- Result: ${summary.failed === 0 ? "PASS" : "RED / FAIL"}`,
    `- Scenarios: ${summary.total}, passed ${summary.passed}, failed ${summary.failed}`,
    "- External services: not used; device profiles, credentials, runtime, NAS readiness, and leaderboard records are synthetic and local to the disposable E2E process.",
    "",
    "| Scenario | Check | Expected | Actual | Result |",
    "| --- | --- | --- | --- | --- |"
  ];
  for (const result of results) {
    for (const check of result.checks) {
      lines.push(
        `| ${markdownCell(result.scenario)} | ${markdownCell(check.name)} | ${markdownCell(check.expected)} | ${markdownCell(check.actual)} | ${check.passed ? "PASS" : "FAIL"} |`
      );
    }
  }
  lines.push("", "## Artifact convention", "");
  lines.push("- `summary.json`: machine-readable verdict and non-PII asserted fields.");
  lines.push("- `report.md`: human-readable check table.");
  lines.push("- `scenarios/<scenario>/stage-1-before-exit.png`: partial-correct plus typo UI evidence.");
  lines.push("- `scenarios/leaderboard-display/interrupted-row.png`: actual AI leaderboard interrupted-row DOM evidence.");
  lines.push("- `scenarios/<scenario>/observed.json`: non-PII contract checks and asserted RecordRow fields.");
  lines.push("- Raw synthetic runtime/checkpoint files use an OS temporary directory and are removed after the run.");
  fs.writeFileSync(path.join(artifactRoot, "report.md"), `${lines.join("\n")}\n`, "utf8");
}

function markdownCell(value: unknown): string {
  return JSON.stringify(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "\\n");
}

async function main(): Promise<void> {
  cleanDir(artifactRoot);
  if (!fs.existsSync(electronExe)) throw new Error(`Electron executable not found: ${electronExe}`);
  if (!fs.existsSync(mainJs)) throw new Error(`Built Electron main not found: ${mainJs}. Run npm run build:main first.`);

  const results: ScenarioResult[] = [];
  try {
    const windowClose = await runWindowClose();
    results.push(windowClose.result);
    const forcedKillRestart = await runForcedKillRestart();
    results.push(forcedKillRestart.result);
    const sourceRecord = forcedKillRestart.fullRecord || windowClose.fullRecord;
    if (sourceRecord) {
      results.push(await runLeaderboardDisplay(sourceRecord));
    } else {
      results.push({
        scenario: "leaderboard-display",
        verdict: "FAIL",
        checks: [{
          name: "full interrupted RecordRow available for leaderboard",
          actual: false,
          expected: true,
          passed: false
        }],
        error: "No interrupted RecordRow was produced by either exit scenario"
      });
    }
  } finally {
    writeReport(results);
    fs.rmSync(temporaryRunRoot, { recursive: true, force: true });
  }

  const failures = results.filter((result) => result.verdict === "FAIL");
  console.log(JSON.stringify({ artifactRoot, total: results.length, pass: results.length - failures.length, fail: failures.length }, null, 2));
  if (failures.length > 0) {
    for (const result of failures) {
      console.error(`${result.scenario}: ${result.checks.filter((check) => !check.passed).map((check) => check.name).join(", ")}`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.writeFileSync(
      path.join(artifactRoot, "harness-error.txt"),
      `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
      "utf8"
    );
    console.error(error);
    process.exitCode = 1;
  });
}
