import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { sanitizeE2eChildEnvironment } from "../electron/startupProfile";
import { DEFAULT_CONFIG } from "../shared/constants/defaults";
import type { AppConfig } from "../shared/types";
import {
  resolveGeumcheonE2eArtifactRoot,
  resolveGeumcheonReleaseRoot
} from "./geumcheon-approved-ui-options";

type GeumcheonVariant = "ai" | "ai-leaderboard" | "practice" | "practice-leaderboard";
type PcRole = "player" | "leaderboard";
type SessionKind = "official" | "practice";

export function buildPackagedSmokeChildEnvironment(
  overrides: NodeJS.ProcessEnv,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...sanitizeE2eChildEnvironment(inheritedEnvironment),
    TYPINGKING_E2E_PROFILE: "packaged-smoke",
    TYPINGKING_E2E_SUPPRESS_STARTUP_DIALOGS: "1",
    TYPINGKING_E2E_HIDE_WINDOW: "1",
    ...overrides
  };
}

type CaseSpec = {
  variant: GeumcheonVariant;
  fileName: string;
  title: string;
  mode: "game" | "leaderboard";
  role: PcRole;
  deviceId: "PC01" | "LEADERBOARD01";
  sessionKind: SessionKind;
  uiSelector: ".entry-panel" | ".leaderboard-app";
  imageSelector: ".brand-header img" | ".geumcheon-header-title";
};

type Check = {
  name: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
};

type CaseResult = {
  variant: GeumcheonVariant;
  fileName: string;
  verdict: "PASS" | "FAIL";
  checks: Check[];
  screenshot?: string;
  screenshotLimitation?: string;
  error?: string;
  nativeTitleEvidence?: "win32" | "document-fallback";
  nativeTitleLimitation?: string;
};

type RequestObservation = {
  route: "ready" | "health" | "records" | "unexpected";
  method: string;
  deviceId?: string;
  sessionKind?: SessionKind;
  authenticated: boolean;
  queryMatched: boolean;
};

type Session =
  | { kind: "official"; session_id: string; day_no: number; round_no: number }
  | { kind: "practice"; session_id: string };

type CdpVersion = {
  Browser?: string;
  webSocketDebuggerUrl?: string;
};

type NativeTitleProbe = {
  available: boolean;
  titles: string[];
  error?: string;
};

const root = process.cwd();
const releaseRoot = resolveGeumcheonReleaseRoot(root, process.env.TYPINGKING_GEUMCHEON_RELEASE_ROOT);
const artifactRoot = resolveGeumcheonE2eArtifactRoot(
  root,
  "geumcheon_packaged_smoke",
  process.env.TYPINGKING_E2E_ARTIFACT_ROOT
);
const eventProfileId = "geumcheon-2026";
const eventId = "geumcheon-science-festival-2026";
const officialSessionId = "packaged-smoke-official";
const practiceSessionId = "packaged-smoke-practice";
const pollIntervalMs = 100;
const requiredPublicResources = [
  "events/geumcheon-2026/event.config.json",
  "events/geumcheon-2026/stage_texts.csv",
  "events/geumcheon-2026/assets/event-title.png",
  "events/geumcheon-2026/assets/key-visual.png",
  "events/geumcheon-2026/assets/bg_leaderboard_03_typing_hall_of_fame.png",
  "events/geumcheon-2026/assets/bg_main_03_geumcheon_data_city.png",
  "events/geumcheon-2026/assets/robot_03_speed_champion.png",
  "events/geumcheon-2026/assets/robot_04_science_lab.png",
  "events/geumcheon-2026/assets/robot_05_festival_victory.png",
  "events/geumcheon-2026/assets/robot_defeat_01_geumnarae_typer.png",
  "events/geumcheon-2026/assets/stage_01_03_science_classroom.png",
  "events/geumcheon-2026/assets/title_04_science_hologram.png",
  "events/geumcheon-2026/assets/vs_03_science_portal.png",
  "events/geumcheon-2026/assets/ai_challenge/stage_badge_1.png",
  "events/geumcheon-2026/assets/ai_challenge/stage_badge_2.png",
  "events/geumcheon-2026/assets/ai_challenge/stage_badge_3.png",
  "assets/ai_challenge/ai_boss_typing.png",
  "assets/ai_challenge/ai_boss_victory.png",
  "assets/ai_challenge/ai_boss_defeat.png",
  "assets/ai_challenge/vs_badge.png",
  "assets/ai_challenge/stage_badge_1.png",
  "assets/ai_challenge/stage_badge_2.png",
  "assets/ai_challenge/stage_badge_3.png",
  "assets/ai_challenge/ai_title_compact.png",
  "assets/ai_challenge/ai_title_oneline_trimmed.png",
  "assets/ai_challenge/ai_challenge_title.png"
] as const;

const cases: CaseSpec[] = [
  {
    variant: "ai",
    fileName: "G-Science AI 타자왕.exe",
    title: "G-Science AI 타자왕",
    mode: "game",
    role: "player",
    deviceId: "PC01",
    sessionKind: "official",
    uiSelector: ".entry-panel",
    imageSelector: ".brand-header img"
  },
  {
    variant: "ai-leaderboard",
    fileName: "G-Science AI 타자왕_리더보드.exe",
    title: "G-Science AI 타자왕 리더보드",
    mode: "leaderboard",
    role: "leaderboard",
    deviceId: "LEADERBOARD01",
    sessionKind: "official",
    uiSelector: ".leaderboard-app",
    imageSelector: ".geumcheon-header-title"
  },
  {
    variant: "practice",
    fileName: "G-Science AI 타자왕_연습모드.exe",
    title: "G-Science AI 타자왕 연습모드",
    mode: "game",
    role: "player",
    deviceId: "PC01",
    sessionKind: "practice",
    uiSelector: ".entry-panel",
    imageSelector: ".brand-header img"
  },
  {
    variant: "practice-leaderboard",
    fileName: "G-Science AI 타자왕_연습모드_리더보드.exe",
    title: "G-Science AI 타자왕 연습모드 리더보드",
    mode: "leaderboard",
    role: "leaderboard",
    deviceId: "LEADERBOARD01",
    sessionKind: "practice",
    uiSelector: ".leaderboard-app",
    imageSelector: ".geumcheon-header-title"
  }
];

function cleanDir(dir: string): void {
  const resolved = path.resolve(dir);
  assert.equal(
    resolved.startsWith(`${path.resolve(root, "test_artifacts")}${path.sep}`),
    true,
    "Refusing to clean outside test_artifacts"
  );
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertStagedPublicResources(executableDirectory: string): void {
  for (const relative of requiredPublicResources) {
    const target = path.join(executableDirectory, ...relative.split("/"));
    assert.ok(fs.existsSync(target), `Staged public sidecar missing: ${relative}`);
    assert.ok(fs.statSync(target).size > 0, `Staged public sidecar is empty: ${relative}`);
  }
}

function stagePublicResources(executableDirectory: string): void {
  for (const relative of requiredPublicResources) {
    const source = path.join(releaseRoot, ...relative.split("/"));
    assert.ok(fs.existsSync(source), `Final public sidecar missing: ${relative}`);
    assert.ok(fs.statSync(source).size > 0, `Final public sidecar is empty: ${relative}`);
    const target = path.join(executableDirectory, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(target);
    return entry.isFile() ? [target] : [];
  });
}

function productInputFiles(): string[] {
  const sourceRoots = ["apps", "electron", "shared", path.join("events", eventProfileId)];
  const files = sourceRoots.flatMap((relative) => listFiles(path.join(root, relative)));
  for (const relative of [
    "index.html",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.node.json",
    "vite.config.ts",
    "electron-builder.geumcheon-ai.yml",
    "electron-builder.geumcheon-ai-leaderboard.yml",
    "electron-builder.geumcheon-practice.yml",
    "electron-builder.geumcheon-practice-leaderboard.yml"
  ]) {
    const target = path.join(root, relative);
    if (fs.existsSync(target)) files.push(target);
  }
  return files;
}

function newestMtime(files: string[]): number {
  assert.ok(files.length > 0, "No product inputs found");
  return Math.max(...files.map((file) => fs.statSync(file).mtimeMs));
}

function assertFreshFinalBuild(): Map<GeumcheonVariant, { path: string; hash: string; bytes: number }> {
  assert.equal(process.platform, "win32", "Packaged smoke test requires Windows");
  assert.ok(fs.existsSync(releaseRoot), "Missing release-geumcheon; build and assemble the final client release first");
  assert.ok(
    fs.existsSync(path.join(releaseRoot, ".typingking-geumcheon-client-release.json")),
    "release-geumcheon is missing its generated-output sentinel"
  );
  for (const forbidden of ["device-profile.json", "bootstrap-credentials.json"]) {
    assert.equal(fs.existsSync(path.join(releaseRoot, forbidden)), false, `Final handoff contains private file: ${forbidden}`);
  }

  const sourceMtime = newestMtime(productInputFiles());
  const compiledFiles = [
    path.join(root, "dist-electron", "electron", "main.js"),
    path.join(root, "dist-renderer", "index.html")
  ];
  for (const compiled of compiledFiles) {
    assert.ok(fs.existsSync(compiled), `Missing compiled output: ${path.relative(root, compiled)}`);
    assert.ok(
      fs.statSync(compiled).mtimeMs + 2_000 >= sourceMtime,
      `Compiled output is older than a product input: ${path.relative(root, compiled)}. Run npm run build first.`
    );
  }
  const compiledMtime = newestMtime(compiledFiles);

  const result = new Map<GeumcheonVariant, { path: string; hash: string; bytes: number }>();
  for (const testCase of cases) {
    const finalPath = path.join(releaseRoot, testCase.fileName);
    const builderPath = path.join(root, "release-build", "geumcheon", testCase.variant, testCase.fileName);
    assert.ok(fs.existsSync(finalPath), `Final EXE missing: ${testCase.fileName}`);
    assert.ok(fs.existsSync(builderPath), `Builder EXE missing: ${testCase.variant}/${testCase.fileName}`);
    const finalHash = sha256(finalPath);
    assert.equal(finalHash, sha256(builderPath), `Final EXE differs from builder output: ${testCase.fileName}`);
    assert.ok(
      fs.statSync(finalPath).mtimeMs + 2_000 >= Math.max(sourceMtime, compiledMtime),
      `Final EXE is older than the current product build: ${testCase.fileName}. Rebuild and reassemble release-geumcheon.`
    );
    result.set(testCase.variant, {
      path: finalPath,
      hash: finalHash,
      bytes: fs.statSync(finalPath).size
    });
  }
  return result;
}

function createLocalHttpsCertificate(certRoot: string): {
  pfxPath: string;
  caPemPath: string;
  passphrase: string;
} {
  fs.mkdirSync(certRoot, { recursive: true });
  const pfxPath = path.join(certRoot, "localhost.pfx");
  const caPemPath = path.join(certRoot, "ca.pem");
  const passphrase = `typingking-packaged-smoke-${process.pid}`;
  const script = String.raw`
$ErrorActionPreference = "Stop"
$pfxPath = [Environment]::GetEnvironmentVariable("TK_SMOKE_PFX_PATH")
$caPemPath = [Environment]::GetEnvironmentVariable("TK_SMOKE_CA_PEM_PATH")
$password = [Environment]::GetEnvironmentVariable("TK_SMOKE_PFX_PASSWORD")
$notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
$notAfter = [DateTimeOffset]::UtcNow.AddDays(1)

$caKey = [Security.Cryptography.RSA]::Create(2048)
$caRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
  "CN=TypingKing Packaged Smoke Root",
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
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: buildPackagedSmokeChildEnvironment({
      TK_SMOKE_PFX_PATH: pfxPath,
      TK_SMOKE_CA_PEM_PATH: caPemPath,
      TK_SMOKE_PFX_PASSWORD: passphrase
    })
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !fs.existsSync(pfxPath) || !fs.existsSync(caPemPath)) {
    throw new Error(`Local HTTPS certificate generation failed: ${result.stderr || result.stdout || result.status}`);
  }
  return { pfxPath, caPemPath, passphrase };
}

function sessionFromQuery(url: URL): Session | undefined {
  const kind = url.searchParams.get("session_kind");
  const sessionId = url.searchParams.get("session_id");
  if (kind === "official" && sessionId === officialSessionId) {
    if (url.searchParams.get("day_no") !== "1" || url.searchParams.get("round_no") !== "1") return undefined;
    return { kind, session_id: sessionId, day_no: 1, round_no: 1 };
  }
  if (kind === "practice" && sessionId === practiceSessionId) {
    if (url.searchParams.has("day_no") || url.searchParams.has("round_no")) return undefined;
    return { kind, session_id: sessionId };
  }
  return undefined;
}

async function startLocalHttpsServer(
  temporaryRoot: string,
  tokens: Record<"PC01" | "LEADERBOARD01", string>
): Promise<{
  server: https.Server;
  baseUrl: string;
  caPemPath: string;
  observations: RequestObservation[];
}> {
  const certificate = createLocalHttpsCertificate(path.join(temporaryRoot, "certificates"));
  const observations: RequestObservation[] = [];
  const server = https.createServer(
    {
      pfx: fs.readFileSync(certificate.pfxPath),
      passphrase: certificate.passphrase,
      minVersion: "TLSv1.2"
    },
    (request, response) => {
      const requestUrl = new URL(request.url || "/", "https://localhost");
      if (request.method === "GET" && requestUrl.pathname === "/api/v1/ready") {
        const rawDeviceId = request.headers["x-device-id"];
        const deviceId = rawDeviceId === "PC01" || rawDeviceId === "LEADERBOARD01"
          ? rawDeviceId
          : undefined;
        const session = sessionFromQuery(requestUrl);
        const authenticated = Boolean(deviceId)
          && request.headers.authorization === `Bearer ${tokens[deviceId!]}`;
        observations.push({
          route: "ready",
          method: "GET",
          deviceId,
          sessionKind: session?.kind,
          authenticated,
          queryMatched: Boolean(session)
        });
        if (!deviceId) {
          response.writeHead(403).end();
          return;
        }
        if (!authenticated) {
          response.writeHead(401).end();
          return;
        }
        if (!session) {
          response.writeHead(400).end();
          return;
        }
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        response.end(JSON.stringify({
          schema_version: 1,
          status: "ready",
          event_id: eventId,
          device_id: deviceId,
          role: deviceId === "PC01" ? "writer" : "operator",
          session
        }));
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/health") {
        observations.push({
          route: "health",
          method: "GET",
          authenticated: false,
          queryMatched: requestUrl.search === ""
        });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/v1/records") {
        const rawDeviceId = request.headers["x-device-id"];
        const deviceId = rawDeviceId === "PC01" || rawDeviceId === "LEADERBOARD01" ? rawDeviceId : undefined;
        const session = sessionFromQuery(requestUrl);
        const authenticated = Boolean(deviceId) && request.headers.authorization === `Bearer ${tokens[deviceId!]}`;
        observations.push({
          route: "records",
          method: "GET",
          deviceId,
          sessionKind: session?.kind,
          authenticated,
          queryMatched: Boolean(session)
        });
        if (!deviceId) {
          response.writeHead(403).end();
          return;
        }
        if (!authenticated) {
          response.writeHead(401).end();
          return;
        }
        if (!session) {
          response.writeHead(400).end();
          return;
        }
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

      observations.push({
        route: "unexpected",
        method: request.method || "",
        authenticated: false,
        queryMatched: false
      });
      response.writeHead(404).end();
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
    throw new Error("Local HTTPS server did not expose a TCP port");
  }
  return {
    server,
    baseUrl: `https://127.0.0.1:${address.port}`,
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

export function buildPackagedSmokeRuntimeConfig(adminPassword = crypto.randomBytes(24).toString("base64url")): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    adminPassword
  };
}

function writeRuntimeConfig(targetRoot: string, adminPassword: string): void {
  const configDir = path.join(targetRoot, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    `${JSON.stringify(buildPackagedSmokeRuntimeConfig(adminPassword), null, 2)}\n`,
    "utf8"
  );
}
function writeSyntheticProfile(
  caseRoot: string,
  testCase: CaseSpec,
  baseUrl: string,
  token: string
): { bootstrapPath: string; runtimeRoot: string } {
  const executableDirectory = path.join(caseRoot, "executable");
  const localAppData = path.join(caseRoot, "LocalAppData");
  const appData = path.join(caseRoot, "RoamingAppData");
  const runtimeRoot = path.join(localAppData, "ThePMD", "TypingKing2026", eventProfileId, testCase.deviceId);
  const syntheticAdminPassword = crypto.randomBytes(24).toString("base64url");
  fs.mkdirSync(executableDirectory, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(
    path.join(executableDirectory, "device-profile.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      eventProfileId,
      eventId,
      deviceId: testCase.deviceId,
      role: testCase.role,
      apiBaseUrl: baseUrl,
      sessions: {
        official: { sessionId: officialSessionId, dayNo: 1, roundNo: 1 },
        practice: { sessionId: practiceSessionId }
      },
      requestTimeoutMs: 5_000,
      retry: { initialDelayMs: 1_000, maxDelayMs: 2_000 }
    }, null, 2)}\n`,
    "utf8"
  );
  const bootstrapPath = path.join(executableDirectory, "bootstrap-credentials.json");
  fs.writeFileSync(
    bootstrapPath,
    `${JSON.stringify({ schemaVersion: 1, eventId, deviceId: testCase.deviceId, apiBaseUrl: baseUrl, token }, null, 2)}\n`,
    "utf8"
  );
  writeRuntimeConfig(executableDirectory, syntheticAdminPassword);
  writeRuntimeConfig(runtimeRoot, syntheticAdminPassword);
  return {
    bootstrapPath,
    runtimeRoot
  };
}

function sanitizedLaunchEnv(
  caseRoot: string,
  caPemPath: string,
  executablePath: string
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(buildPackagedSmokeChildEnvironment({})).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
  for (const key of [
    "APP_VARIANT",
    "EVENT_PROFILE",
    "TYPINGKING_RUNTIME_ROOT",
    "VITE_DEV_SERVER_URL",
    "ELECTRON_RUN_AS_NODE"
  ]) {
    delete env[key];
  }
  env.PORTABLE_EXECUTABLE_DIR = path.dirname(executablePath);
  env.PORTABLE_EXECUTABLE_FILE = executablePath;
  env.LOCALAPPDATA = path.join(caseRoot, "LocalAppData");
  env.APPDATA = path.join(caseRoot, "RoamingAppData");
  env.NODE_EXTRA_CA_CERTS = caPemPath;
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = "1";
  env.NO_PROXY = "127.0.0.1,localhost";
  return env;
}

async function takeFreeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "Could not reserve a local CDP port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function readCdpVersion(port: number): Promise<CdpVersion | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: CdpVersion | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get({
      host: "127.0.0.1",
      port,
      path: "/json/version",
      timeout: 750
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(undefined);
        return;
      }
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 64 * 1024) request.destroy();
      });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(body) as CdpVersion;
          finish(parsed.webSocketDebuggerUrl?.startsWith("ws://") ? parsed : undefined);
        } catch {
          finish(undefined);
        }
      });
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => finish(undefined));
  });
}

async function waitForCdpVersion(port: number, child: ChildProcess, timeoutMs = 90_000): Promise<CdpVersion> {
  const timeoutAt = Date.now() + timeoutMs;
  while (Date.now() < timeoutAt) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Portable wrapper exited before CDP became ready (exit=${child.exitCode}, signal=${child.signalCode})`
      );
    }
    const version = await readCdpVersion(port);
    if (version?.webSocketDebuggerUrl) return version;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timed out waiting for portable CDP endpoint on local port ${port}`);
}

async function waitForPackagedRenderer(browser: Browser): Promise<Page> {
  let renderer: Page | undefined;
  await waitUntil("packaged file renderer target", () => {
    renderer = browser.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("file:"));
    return Boolean(renderer);
  }, 45_000);
  assert.ok(renderer, "CDP connected without a packaged renderer page");
  return renderer;
}

function probeNativeWindowTitles(rootProcessId: number): NativeTitleProbe {
  const script = String.raw`
$ErrorActionPreference = "Stop"
$rootProcessId = [int][Environment]::GetEnvironmentVariable("TK_SMOKE_ROOT_PROCESS_ID")
$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
$tree = [Collections.Generic.HashSet[int]]::new()
[void]$tree.Add($rootProcessId)
do {
  $added = $false
  foreach ($candidate in $processes) {
    $candidateId = [int]$candidate.ProcessId
    $parentId = [int]$candidate.ParentProcessId
    if ($tree.Contains($parentId) -and $tree.Add($candidateId)) {
      $added = $true
    }
  }
} while ($added)
$titles = @()
foreach ($candidateId in $tree) {
  try {
    $candidateProcess = Get-Process -Id $candidateId -ErrorAction Stop
    if (-not [string]::IsNullOrWhiteSpace($candidateProcess.MainWindowTitle)) {
      $titles += [string]$candidateProcess.MainWindowTitle
    }
  } catch {}
}
ConvertTo-Json -InputObject @($titles) -Compress
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    env: buildPackagedSmokeChildEnvironment({
      TK_SMOKE_ROOT_PROCESS_ID: String(rootProcessId)
    })
  });
  if (result.error || result.status !== 0) {
    return {
      available: false,
      titles: [],
      error: result.error?.message || `Win32 title probe exited ${result.status}`
    };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim() || "[]") as unknown;
    const titles = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    return { available: true, titles: [...new Set(titles)] };
  } catch (error) {
    return {
      available: false,
      titles: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function waitUntil(description: string, predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
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

function forceKillProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || !pid || pid < 1) return;
  const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
}

function childIsRunning(child: ChildProcess | undefined): child is ChildProcess {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

async function cleanupPackagedProcess(
  browser: Browser | undefined,
  page: Page | undefined,
  child: ChildProcess | undefined
): Promise<{ exited: boolean; forced: boolean }> {
  if (page && !page.isClosed()) {
    await Promise.race([
      page.close({ runBeforeUnload: true }).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 6_000))
    ]);
  }
  if (childIsRunning(child)) {
    await waitUntil(
      "portable wrapper exit after renderer close",
      () => !childIsRunning(child),
      3_000
    ).catch(() => undefined);
  }
  if (browser?.isConnected()) {
    await Promise.race([
      browser.close().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000))
    ]);
  }
  if (childIsRunning(child)) {
    await waitUntil(
      "portable wrapper exit after CDP browser close",
      () => !childIsRunning(child),
      2_000
    ).catch(() => undefined);
  }
  let forced = false;
  if (childIsRunning(child)) {
    forceKillProcessTree(child);
    forced = true;
    await waitUntil(
      "explicit portable PID tree cleanup",
      () => !childIsRunning(child),
      10_000
    ).catch(() => undefined);
  }
  return { exited: !childIsRunning(child), forced };
}

function addCheck(checks: Check[], name: string, actual: unknown, expected: unknown, passed: boolean): void {
  checks.push({ name, expected, actual, passed });
}

function sanitizeError(error: unknown, temporaryRoot: string, secrets: string[] = []): string {
  const raw = error instanceof Error ? error.stack || error.message : String(error);
  return secrets.reduce((value, secret) => value.replaceAll(secret, "[secret]"), raw)
    .replaceAll(temporaryRoot, "[temporary-runtime]")
    .replaceAll(root, "[workspace]")
    .replace(/https:\/\/127\.0\.0\.1:\d+/g, "[local-https-server]");
}

export function formatPackagedSmokeFallbackError(primaryError: string, fallbackError: unknown): string {
  const fallbackMessage = fallbackError instanceof Error
    ? fallbackError.stack || fallbackError.message
    : String(fallbackError);
  return `Primary CDP failure: ${primaryError}\nNative fallback failure: ${fallbackMessage}`;
}

async function writeFailureScreenshot(page: Page | undefined, variant: GeumcheonVariant): Promise<void> {
  if (!page) return;
  const target = path.join(artifactRoot, "screenshots", `${variant}-failure.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target, fullPage: false }).catch(() => undefined);
}

async function runCase(options: {
  testCase: CaseSpec;
  finalExePath: string;
  originalHash: string;
  temporaryRoot: string;
  serverBaseUrl: string;
  caPemPath: string;
  token: string;
  observations: RequestObservation[];
}): Promise<CaseResult> {
  const { testCase } = options;
  const caseRoot = path.join(options.temporaryRoot, testCase.variant);
  const executableDirectory = path.join(caseRoot, "executable");
  const stagedExePath = path.join(executableDirectory, testCase.fileName);
  const checks: Check[] = [];
  const profile = writeSyntheticProfile(caseRoot, testCase, options.serverBaseUrl, options.token);
  fs.copyFileSync(options.finalExePath, stagedExePath);
  stagePublicResources(executableDirectory);
  assertStagedPublicResources(executableDirectory);
  addCheck(
    checks,
    "required public sidecars staged",
    requiredPublicResources.length,
    requiredPublicResources.length,
    true
  );

  let browser: Browser | undefined;
  let child: ChildProcess | undefined;
  let page: Page | undefined;
  let error: string | undefined;
  let screenshotRelative: string | undefined;
  let screenshotLimitation: string | undefined;
  let nativeTitleEvidence: CaseResult["nativeTitleEvidence"];
  let nativeTitleLimitation: string | undefined;
  const observationStart = options.observations.length;
  try {
    const debugPort = await takeFreeLoopbackPort();
    child = spawn(stagedExePath, [`--remote-debugging-port=${debugPort}`], {
      cwd: executableDirectory,
      env: sanitizedLaunchEnv(caseRoot, options.caPemPath, stagedExePath),
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", () => undefined);
    assert.ok(child.pid, "Portable wrapper did not expose a root PID");
    const cdpVersion = await waitForCdpVersion(debugPort, child);
    addCheck(
      checks,
      "portable CDP endpoint ready",
      Boolean(cdpVersion.webSocketDebuggerUrl),
      true,
      Boolean(cdpVersion.webSocketDebuggerUrl)
    );
    browser = await chromium.connectOverCDP(cdpVersion.webSocketDebuggerUrl!, { timeout: 60_000 });
    page = await waitForPackagedRenderer(browser);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean((window as any).typingKing), undefined, { timeout: 20_000 });
    await page.locator(testCase.uiSelector).waitFor({ state: "visible", timeout: 30_000 });

    const bootstrapResult = await page.evaluate(async () => (window as any).typingKing.getBootstrap());
    assert.equal(bootstrapResult.ok, true, "Renderer bootstrap failed");
    const bootstrap = bootstrapResult.data;
    addCheck(checks, "variant from packaged metadata", bootstrap.variant, testCase.variant, bootstrap.variant === testCase.variant);
    addCheck(checks, "application mode", bootstrap.mode, testCase.mode, bootstrap.mode === testCase.mode);
    addCheck(checks, "event profile", bootstrap.eventProfile?.profileId, eventProfileId, bootstrap.eventProfile?.profileId === eventProfileId);
    addCheck(checks, "variant role", bootstrap.variantPolicy?.role, testCase.role, bootstrap.variantPolicy?.role === testCase.role);
    addCheck(checks, "device role", bootstrap.deviceProfile?.role, testCase.role, bootstrap.deviceProfile?.role === testCase.role);
    addCheck(checks, "device ID", bootstrap.deviceProfile?.deviceId, testCase.deviceId, bootstrap.deviceProfile?.deviceId === testCase.deviceId);
    addCheck(checks, "session kind", bootstrap.variantPolicy?.sessionKind, testCase.sessionKind, bootstrap.variantPolicy?.sessionKind === testCase.sessionKind);
    addCheck(
      checks,
      "AI-only game mode",
      bootstrap.variantPolicy?.gameModes,
      ["ai_challenge"],
      JSON.stringify(bootstrap.variantPolicy?.gameModes) === JSON.stringify(["ai_challenge"])
    );

    const pageTitle = await page.title();
    addCheck(checks, "document title", pageTitle, testCase.title, pageTitle === testCase.title);
    let nativeTitleProbe = probeNativeWindowTitles(child.pid!);
    const nativeTitleDeadline = Date.now() + 8_000;
    while (!nativeTitleProbe.titles.includes(testCase.title) && Date.now() < nativeTitleDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      nativeTitleProbe = probeNativeWindowTitles(child.pid!);
    }
    if (nativeTitleProbe.titles.includes(testCase.title)) {
      nativeTitleEvidence = "win32";
      addCheck(checks, "native window title", testCase.title, testCase.title, true);
    } else {
      nativeTitleEvidence = "document-fallback";
      nativeTitleLimitation = "Win32 child-window title was unavailable or unstable; document title and packaged bootstrap assertions were used.";
      addCheck(
        checks,
        "window title via documented CDP fallback",
        pageTitle,
        testCase.title,
        pageTitle === testCase.title
      );
    }
    const rendererState = await page.evaluate(() => ({
      readyState: document.readyState,
      eventProfile: document.documentElement.dataset.eventProfile,
      hasFallback: Boolean(document.querySelector(".app-fallback")),
      protocol: location.protocol
    }));
    addCheck(checks, "renderer ready state", rendererState.readyState, "complete", rendererState.readyState === "complete");
    addCheck(checks, "renderer profile marker", rendererState.eventProfile, eventProfileId, rendererState.eventProfile === eventProfileId);
    addCheck(checks, "renderer fallback absent", rendererState.hasFallback, false, rendererState.hasFallback === false);
    addCheck(checks, "packaged renderer protocol", rendererState.protocol, "file:", rendererState.protocol === "file:");

    const image = page.locator(testCase.imageSelector).first();
    await image.waitFor({ state: "visible", timeout: 20_000 });
    const imageLoaded = await image.evaluate((element) => {
      const img = element as HTMLImageElement;
      return img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
    });
    addCheck(checks, "Geumcheon title image loaded", imageLoaded, true, imageLoaded === true);

    const readiness = await page.evaluate(async () => (window as any).typingKing.checkGameStartReadiness("ai_challenge"));
    addCheck(checks, "local HTTPS readiness", readiness, { ok: true, data: { ready: true } }, readiness?.ok === true && readiness?.data?.ready === true);
    if (testCase.role === "leaderboard") {
      const records = await page.evaluate(async () => (window as any).typingKing.listRecords());
      addCheck(checks, "authenticated HTTPS records read", records?.ok, true, records?.ok === true && Array.isArray(records?.data));
    }

    if (testCase.role === "leaderboard") {
      await waitUntil("matching HTTPS records request", () => {
        return options.observations.slice(observationStart).some((observation) =>
          observation.route === "records" &&
          observation.deviceId === testCase.deviceId &&
          observation.sessionKind === testCase.sessionKind &&
          observation.authenticated &&
          observation.queryMatched
        );
      }, 10_000);
    }
    const caseObservations = options.observations.slice(observationStart);
    const matchingReady = caseObservations.some((observation) =>
      observation.route === "ready" &&
      observation.method === "GET" &&
      observation.deviceId === testCase.deviceId &&
      observation.sessionKind === testCase.sessionKind &&
      observation.authenticated &&
      observation.queryMatched
    );
    const matchingRecords = caseObservations.some((observation) =>
      observation.route === "records" &&
      observation.deviceId === testCase.deviceId &&
      observation.sessionKind === testCase.sessionKind &&
      observation.authenticated &&
      observation.queryMatched
    );
    addCheck(checks, "authenticated HTTPS ready request observed", matchingReady, true, matchingReady);
    if (testCase.role === "leaderboard") {
      addCheck(checks, "role/session-specific HTTPS request observed", matchingRecords, true, matchingRecords);
    } else {
      addCheck(checks, "player made no HTTPS records request", matchingRecords, false, matchingRecords === false);
    }

    addCheck(checks, "plaintext bootstrap credential removed", fs.existsSync(profile.bootstrapPath), false, !fs.existsSync(profile.bootstrapPath));
    const encryptedTokenPath = path.join(profile.runtimeRoot, "nas", "device-token.bin");
    const encryptedToken = fs.existsSync(encryptedTokenPath) ? fs.readFileSync(encryptedTokenPath) : undefined;
    addCheck(checks, "encrypted runtime credential exists", Boolean(encryptedToken?.length), true, Boolean(encryptedToken?.length));
    addCheck(
      checks,
      "runtime credential hides plaintext token",
      encryptedToken?.includes(Buffer.from(options.token, "utf8")) ?? null,
      false,
      Boolean(encryptedToken) && encryptedToken!.includes(Buffer.from(options.token, "utf8")) === false
    );

    screenshotLimitation = "Hidden packaged renderer capture is covered by the separate approved-UI screen QA evidence.";
  } catch (caught) {
    const cdpError = sanitizeError(caught, options.temporaryRoot, [options.token]);
    const canUseNativeFallback = Boolean(child?.pid)
      && (cdpError.includes("connectOverCDP") || cdpError.includes("CDP endpoint"));
    if (canUseNativeFallback) {
      try {
        let titleProbe = probeNativeWindowTitles(child!.pid!);
        const titleDeadline = Date.now() + 8_000;
        while (!titleProbe.titles.includes(testCase.title) && Date.now() < titleDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          titleProbe = probeNativeWindowTitles(child!.pid!);
        }
        assert.ok(titleProbe.titles.includes(testCase.title), `Native window title not found: ${testCase.title}`);
        nativeTitleEvidence = "win32";
        nativeTitleLimitation = "Packaged DevTools are intentionally disabled; native window, encrypted credential, and authenticated HTTPS evidence were used.";
        addCheck(checks, "native window title", testCase.title, testCase.title, true);
        addCheck(
          checks,
          "packaged process remains running",
          child!.exitCode === null && child!.signalCode === null,
          true,
          child!.exitCode === null && child!.signalCode === null
        );

        await waitUntil("plaintext bootstrap credential removal", () => !fs.existsSync(profile.bootstrapPath), 10_000);
        addCheck(checks, "plaintext bootstrap credential removed", fs.existsSync(profile.bootstrapPath), false, true);
        const encryptedTokenPath = path.join(profile.runtimeRoot, "nas", "device-token.bin");
        await waitUntil("encrypted runtime credential", () => fs.existsSync(encryptedTokenPath), 10_000);
        const encryptedToken = fs.readFileSync(encryptedTokenPath);
        addCheck(checks, "encrypted runtime credential exists", encryptedToken.length > 0, true, encryptedToken.length > 0);
        addCheck(
          checks,
          "encrypted credential hides token plaintext",
          encryptedToken.includes(Buffer.from(options.token, "utf8")),
          false,
          !encryptedToken.includes(Buffer.from(options.token, "utf8"))
        );

        await waitUntil("authenticated HTTPS ready request", () =>
          options.observations.slice(observationStart).some((observation) =>
            observation.route === "ready"
            && observation.deviceId === testCase.deviceId
            && observation.sessionKind === testCase.sessionKind
            && observation.authenticated
            && observation.queryMatched
          ), 10_000);
        addCheck(checks, "authenticated HTTPS ready request observed", true, true, true);

        if (testCase.role === "leaderboard") {
          await waitUntil("role/session-specific HTTPS records request", () =>
            options.observations.slice(observationStart).some((observation) =>
              observation.route === "records"
              && observation.deviceId === testCase.deviceId
              && observation.sessionKind === testCase.sessionKind
              && observation.authenticated
              && observation.queryMatched
            ), 10_000);
          addCheck(checks, "role/session-specific HTTPS request observed", true, true, true);
        }
      } catch (fallbackError) {
        error = sanitizeError(
          formatPackagedSmokeFallbackError(cdpError, fallbackError),
          options.temporaryRoot,
          [options.token]
        );
      }
    } else {
      error = cdpError;
    }
    if (error) {
      addCheck(checks, "scenario completed without harness error", error, "no error", false);
      await writeFailureScreenshot(page, testCase.variant);
    }
  } finally {
    try {
      const cleanup = await cleanupPackagedProcess(browser, page, child);
      addCheck(
        checks,
        "portable root PID tree cleaned",
        cleanup,
        { exited: true },
        cleanup.exited
      );
    } catch (caught) {
      const cleanupError = sanitizeError(caught, options.temporaryRoot, [options.token]);
      if (!error) error = cleanupError;
      addCheck(checks, "portable root PID tree cleaned", cleanupError, { exited: true }, false);
    }
    const finalHash = sha256(options.finalExePath);
    addCheck(
      checks,
      "final EXE unchanged by smoke run",
      finalHash,
      options.originalHash,
      finalHash === options.originalHash
    );
  }

  return {
    variant: testCase.variant,
    fileName: testCase.fileName,
    verdict: !error && checks.every((check) => check.passed) ? "PASS" : "FAIL",
    checks,
    screenshot: screenshotRelative,
    screenshotLimitation,
    error,
    nativeTitleEvidence,
    nativeTitleLimitation
  };
}

function markdownCell(value: unknown): string {
  return JSON.stringify(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "\\n");
}

function writeReports(
  results: CaseResult[],
  builds: Map<GeumcheonVariant, { hash: string; bytes: number }>
): void {
  const nativeTitleWin32Count = results.filter((result) => result.nativeTitleEvidence === "win32").length;
  const nativeTitleFallbackCount = results.filter((result) => result.nativeTitleEvidence === "document-fallback").length;
  const separateScreenshotCount = results.filter((result) => result.screenshotLimitation).length;
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    eventProfileId,
    externalServicesUsed: false,
    syntheticLocalHttps: true,
    plaintextSecretsOrPiiInArtifacts: false,
    expected: cases.length,
    executed: results.length,
    passed: results.filter((result) => result.verdict === "PASS").length,
    failed: results.filter((result) => result.verdict === "FAIL").length + (cases.length - results.length),
    nativeWindowTitleEvidence: {
      win32: nativeTitleWin32Count,
      documentFallback: nativeTitleFallbackCount,
      limitation: nativeTitleFallbackCount > 0
        ? "Win32 child-window title was unavailable or unstable for one or more cases; document title and packaged bootstrap assertions were used."
        : null
    },
    builds: cases.map((testCase) => ({
      variant: testCase.variant,
      fileName: testCase.fileName,
      bytes: builds.get(testCase.variant)!.bytes,
      sha256: builds.get(testCase.variant)!.hash
    })),
    results
  };
  fs.writeFileSync(path.join(artifactRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  for (const result of results) {
    const target = path.join(artifactRoot, "observed", `${result.variant}.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  const lines = [
    "# Geumcheon packaged EXE smoke report",
    "",
    `- Generated: ${summary.generatedAt}`,
    `- Result: ${summary.failed === 0 ? "PASS" : "RED / FAIL"}`,
    `- Executables: expected ${summary.expected}, executed ${summary.executed}, passed ${summary.passed}, failed or unexecuted ${summary.failed}`,
    "- Network: synthetic local HTTPS only; no Synology NAS or external network used.",
    "- Privacy: artifacts contain no token, API URL, participant name, phone number, or raw runtime data.",
    `- Native window title evidence: Win32 ${nativeTitleWin32Count}; documented CDP fallback ${nativeTitleFallbackCount}.`,
    `- Hidden packaged screenshots: ${separateScreenshotCount} delegated to the separate approved-UI screen QA evidence.`,
    ...(nativeTitleFallbackCount > 0
      ? ["- Limitation: Win32 child-window title was unavailable or unstable for one or more cases; document title and packaged bootstrap assertions were used."]
      : []),
    "",
    "| Variant | Check | Expected | Actual | Result |",
    "| --- | --- | --- | --- | --- |"
  ];
  for (const result of results) {
    for (const check of result.checks) {
      lines.push(
        `| ${markdownCell(result.variant)} | ${markdownCell(check.name)} | ${markdownCell(check.expected)} | ${markdownCell(check.actual)} | ${check.passed ? "PASS" : "FAIL"} |`
      );
    }
  }
  lines.push("", "## Artifact convention", "");
  lines.push("- `summary.json`: machine-readable result plus final EXE hashes and sizes.");
  lines.push("- `report.md`: human-readable check table.");
  lines.push("- `observed/<variant>.json`: per-variant non-secret assertions.");
  lines.push("- Packaged renderer screenshots are intentionally covered by the separate approved-UI screen QA evidence because these EXEs run hidden/off-screen.");
  lines.push("- Synthetic profiles, credentials, certificates, and AppData are deleted with the OS temporary run directory.");
  fs.writeFileSync(path.join(artifactRoot, "report.md"), `${lines.join("\n")}\n`, "utf8");
}

async function main(): Promise<void> {
  const builds = assertFreshFinalBuild();
  cleanDir(artifactRoot);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-geumcheon-packaged-smoke-"));
  const tokens = {
    PC01: crypto.randomBytes(32).toString("base64url"),
    LEADERBOARD01: crypto.randomBytes(32).toString("base64url")
  } as const;
  let server: Awaited<ReturnType<typeof startLocalHttpsServer>> | undefined;
  const results: CaseResult[] = [];
  try {
    server = await startLocalHttpsServer(temporaryRoot, tokens);
    for (const testCase of cases) {
      const build = builds.get(testCase.variant)!;
      results.push(await runCase({
        testCase,
        finalExePath: build.path,
        originalHash: build.hash,
        temporaryRoot,
        serverBaseUrl: server.baseUrl,
        caPemPath: server.caPemPath,
        token: tokens[testCase.deviceId],
        observations: server.observations
      }));
    }
  } finally {
    writeReports(results, builds);
    await stopHttpsServer(server?.server).catch(() => undefined);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const failed = results.filter((result) => result.verdict === "FAIL");
  console.log(JSON.stringify({ artifactRoot: "test_artifacts/geumcheon_packaged_smoke", total: results.length, pass: results.length - failed.length, fail: failed.length }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(sanitizeError(error, os.tmpdir()));
    process.exitCode = 1;
  });
}
