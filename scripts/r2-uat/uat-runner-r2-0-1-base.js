"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");

const EVENT_PROFILE_ID = "geumcheon-2026";
const EVENT_ID = "geumcheon-science-festival-2026";
const OFFICIAL_SESSION_ID = "r2-uat-official";
const PRACTICE_SESSION_ID = "r2-uat-practice";

function syntheticUuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function createSyntheticRecord(index, gameMode) {
  const suffix = String(index).padStart(2, "0");
  const completedAt = `2026-08-29T00:${String(index % 60).padStart(2, "0")}:00.000Z`;
  const aiMode = gameMode === "ai_challenge";
  const participantCpm = 240 + index * 7;
  const aiCpm = 300;
  const participantWin = aiMode && index % 3 === 0;
  return {
    record_id: `gsc26-pc${String(((index - 1) % 10) + 1).padStart(2, "0")}-${syntheticUuid(index)}`,
    created_at: completedAt,
    completed_at: completedAt,
    participant_name: `합성참가자${suffix}`,
    phone_part1: "",
    phone_part2: "",
    phone_part3: "",
    phone_full: "",
    phone_masked: `010-****-${String(1000 + index).slice(-4)}`,
    birth_year: "",
    birth_month: "",
    birth_day: "",
    birthdate: "",
    birthdate_masked: "****-**-**",
    privacy_agreed: "true",
    privacy_agreed_at: completedAt,
    stage1_text: "과학은 질문에서 시작됩니다",
    stage2_text: "인공지능은 데이터를 바탕으로 학습합니다",
    stage3_text: "새로운 발견은 세상을 더 넓게 보여 줍니다",
    stage_text_catalog_version: "geumcheon-draft-20260825-v1",
    stage1_text_id: "gsc26-ai-s1-001",
    stage2_text_id: "gsc26-ai-s2-001",
    stage3_text_id: "gsc26-ai-s3-001",
    stage1_char_count: "14",
    stage2_char_count: "20",
    stage3_char_count: "23",
    total_char_count: "57",
    stage1_time_ms: "3600",
    stage2_time_ms: "5200",
    stage3_time_ms: "6200",
    stage1_cumulative_ms: "3600",
    stage2_cumulative_ms: "8800",
    total_time_ms: "15000",
    display_stage1_sec: "3.6",
    display_stage2_sec: "5.2",
    display_stage3_sec: "6.2",
    display_total_sec: "15.0",
    final_cpm: String(participantCpm),
    final_accuracy: "100",
    app_version: "R2.0.1-UAT",
    is_test: "false",
    is_debug: "false",
    debug_mode_type: "",
    memo: `합성 UAT 기록 ${suffix}`,
    game_mode: gameMode,
    ai_enabled: aiMode ? "true" : "false",
    ai_challenge_status: aiMode ? (participantWin ? "SUCCESS" : "FAILED") : "",
    ai_failed_stage: aiMode && !participantWin ? "3" : "",
    ai_stage1_cpm: aiMode ? String(aiCpm - 20) : "",
    ai_stage2_cpm: aiMode ? String(aiCpm) : "",
    ai_stage3_cpm: aiMode ? String(aiCpm + 20) : "",
    ai_stage1_time_ms: aiMode ? "4000" : "",
    ai_stage2_time_ms: aiMode ? "5000" : "",
    ai_stage3_time_ms: aiMode ? "6000" : "",
    ai_total_time_ms: aiMode ? "15000" : "",
    stage1_vs_ai_result: aiMode ? "USER_WIN" : "",
    stage2_vs_ai_result: aiMode ? "USER_WIN" : "",
    stage3_vs_ai_result: aiMode ? (participantWin ? "USER_WIN" : "AI_WIN") : "",
    final_vs_ai_result: aiMode ? (participantWin ? "USER_WIN" : "AI_WIN") : "",
    stage1_time_diff_ms: aiMode ? "400" : "",
    stage2_time_diff_ms: aiMode ? "-200" : "",
    stage3_time_diff_ms: aiMode ? (participantWin ? "-300" : "300") : "",
    final_time_diff_ms: aiMode ? (participantWin ? "-300" : "300") : "",
    participant_result_time_ms: aiMode ? "15000" : "",
    ai_result_time_ms: aiMode ? "15300" : "",
    participant_avg_cpm: aiMode ? String(participantCpm) : "",
    ai_avg_cpm: aiMode ? String(aiCpm) : "",
    challenge_result_label: aiMode ? (participantWin ? "참여자 승리" : "참여자 패배") : "",
    participant_progress_percent: aiMode ? "100" : "",
    ai_progress_percent: aiMode ? (participantWin ? "98" : "100") : "",
    duel_time_ms: aiMode ? "15300" : "",
    result_stage: aiMode ? "3" : "",
    original_record_id: "",
    is_admin_edited: "false",
    attemptNumber: 1
  };
}

function createSyntheticRecords() {
  const rows = [];
  for (let index = 1; index <= 12; index += 1) {
    rows.push(createSyntheticRecord(index, "ai_challenge"));
  }
  for (let index = 13; index <= 24; index += 1) {
    rows.push(createSyntheticRecord(index, "normal"));
  }
  return rows;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertLoopbackHttps(baseUrl) {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.pathname !== "/") {
    throw new Error("UAT_API_MUST_BE_HTTPS_LOOPBACK");
  }
}

function writeSyntheticProfile({ caseRoot, executableDirectory, app, baseUrl, token, runtimeConfig }) {
  assertLoopbackHttps(baseUrl);
  if (!/^(?:[0-9a-f]{64}|[A-Za-z0-9_-]{43})$/.test(token)) {
    throw new Error("SYNTHETIC_TOKEN_INVALID");
  }
  const localAppData = path.join(caseRoot, "LocalAppData");
  const appData = path.join(caseRoot, "RoamingAppData");
  const temp = path.join(caseRoot, "Temp");
  const runtimeRoot = path.join(localAppData, "ThePMD", "TypingKing2026", EVENT_PROFILE_ID, app.deviceId);
  const userDataPath = path.join(runtimeRoot, "electron-user-data");
  for (const directory of [executableDirectory, localAppData, appData, temp, userDataPath]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const deviceProfile = {
    schemaVersion: 1,
    eventProfileId: EVENT_PROFILE_ID,
    eventId: EVENT_ID,
    deviceId: app.deviceId,
    role: app.role,
    apiBaseUrl: baseUrl,
    sessions: {
      official: { sessionId: OFFICIAL_SESSION_ID, dayNo: 1, roundNo: 1 },
      practice: { sessionId: PRACTICE_SESSION_ID }
    },
    requestTimeoutMs: 5000,
    retry: { initialDelayMs: 1000, maxDelayMs: 2000 }
  };
  const bootstrap = {
    schemaVersion: 1,
    eventId: EVENT_ID,
    deviceId: app.deviceId,
    apiBaseUrl: baseUrl,
    token
  };
  const generatedConfig = {
    ...runtimeConfig,
    adminPassword: crypto.randomBytes(24).toString("base64url")
  };

  writeJson(path.join(executableDirectory, "device-profile.json"), deviceProfile);
  const bootstrapPath = path.join(executableDirectory, "bootstrap-credentials.json");
  writeJson(bootstrapPath, bootstrap);
  writeJson(path.join(executableDirectory, "config", "config.json"), generatedConfig);
  writeJson(path.join(runtimeRoot, "config", "config.json"), generatedConfig);
  return { bootstrapPath, runtimeRoot, userDataPath };
}

const SAFE_INHERITED_ENVIRONMENT_NAMES = new Set([
  "COMSPEC",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "WINDIR"
]);

function buildSafeSystemEnvironment(inherited, overrides = {}) {
  const environment = {};
  for (const [name, value] of Object.entries(inherited || {})) {
    if (value == null || !SAFE_INHERITED_ENVIRONMENT_NAMES.has(name.toUpperCase())) continue;
    environment[name] = String(value);
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value != null) environment[name] = String(value);
  }
  return environment;
}

function buildIsolatedChildEnvironment({ inherited, caseRoot, executablePath, caPemPath }) {
  const localAppData = path.join(caseRoot, "LocalAppData");
  const appData = path.join(caseRoot, "RoamingAppData");
  const temp = path.join(caseRoot, "Temp");
  const environment = buildSafeSystemEnvironment(inherited);
  environment.PORTABLE_EXECUTABLE_DIR = path.dirname(executablePath);
  environment.PORTABLE_EXECUTABLE_FILE = executablePath;
  environment.LOCALAPPDATA = localAppData;
  environment.APPDATA = appData;
  environment.TEMP = temp;
  environment.TMP = temp;
  environment.NODE_EXTRA_CA_CERTS = caPemPath;
  environment.NO_PROXY = "127.0.0.1,localhost";
  environment.TYPINGKING_E2E_PROFILE = "packaged-smoke";
  delete environment.NODE_TLS_REJECT_UNAUTHORIZED;
  for (const directory of [localAppData, appData, temp]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return environment;
}

function createTemporaryCertificate(certificateRoot) {
  fs.mkdirSync(certificateRoot, { recursive: true });
  const pfxPath = path.join(certificateRoot, "localhost.pfx");
  const caPemPath = path.join(certificateRoot, "ca.pem");
  const passphrase = crypto.randomBytes(24).toString("base64url");
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const script = String.raw`
$ErrorActionPreference = "Stop"
$pfxPath = [Environment]::GetEnvironmentVariable("R2_UAT_PFX_PATH")
$caPemPath = [Environment]::GetEnvironmentVariable("R2_UAT_CA_PEM_PATH")
$password = [Environment]::GetEnvironmentVariable("R2_UAT_PFX_PASSWORD")
$notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
$notAfter = [DateTimeOffset]::UtcNow.AddDays(1)

$caKey = [Security.Cryptography.RSA]::Create(2048)
$caRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
  "CN=TypingKing R2 UAT Temporary Root",
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
$eku = [Security.Cryptography.OidCollection]::new()
$null = $eku.Add([Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1"))
$serverRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $true)
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
$serial[0] = $serial[0] -band 0x7f
$serial[15] = $serial[15] -bor 1
$issued = $serverRequest.Create($caCertificate, $notBefore, $notAfter, $serial)
$serverCertificate = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($issued, $serverKey)
[IO.File]::WriteAllBytes(
  $pfxPath,
  $serverCertificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password)
)
$base64 = [Convert]::ToBase64String($caCertificate.RawData, [Base64FormattingOptions]::InsertLineBreaks)
$pem = "-----BEGIN CERTIFICATE-----" + [Environment]::NewLine + $base64 + [Environment]::NewLine + "-----END CERTIFICATE-----" + [Environment]::NewLine
[IO.File]::WriteAllText($caPemPath, $pem, [Text.Encoding]::ASCII)

$serverCertificate.Dispose()
$issued.Dispose()
$serverKey.Dispose()
$caCertificate.Dispose()
$caKey.Dispose()
$rng.Dispose()
`;
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: buildSafeSystemEnvironment(process.env, {
      TEMP: certificateRoot,
      TMP: certificateRoot,
      R2_UAT_PFX_PATH: pfxPath,
      R2_UAT_CA_PEM_PATH: caPemPath,
      R2_UAT_PFX_PASSWORD: passphrase
    }),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !fs.existsSync(pfxPath) || !fs.existsSync(caPemPath)) {
    throw new Error(`TEMPORARY_CERTIFICATE_FAILED:${result.status}`);
  }
  return { pfxPath, caPemPath, passphrase };
}

function sessionFromUrl(url) {
  const kind = url.searchParams.get("session_kind");
  const sessionId = url.searchParams.get("session_id");
  if (kind === "official" && sessionId === OFFICIAL_SESSION_ID) {
    if (url.searchParams.get("day_no") !== "1" || url.searchParams.get("round_no") !== "1") return undefined;
    return { kind, session_id: sessionId, day_no: 1, round_no: 1 };
  }
  if (kind === "practice" && sessionId === PRACTICE_SESSION_ID) {
    if (url.searchParams.has("day_no") || url.searchParams.has("round_no")) return undefined;
    return { kind, session_id: sessionId };
  }
  return undefined;
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    connection: "close"
  });
  response.end(JSON.stringify(value));
}

async function startMockNas({ temporaryRoot, tokens, records }) {
  const certificate = createTemporaryCertificate(path.join(temporaryRoot, "certificates"));
  const observations = [];
  const server = https.createServer({
    pfx: fs.readFileSync(certificate.pfxPath),
    passphrase: certificate.passphrase,
    minVersion: "TLSv1.2"
  }, (request, response) => {
    const requestUrl = new URL(request.url || "/", "https://127.0.0.1");
    const deviceId = typeof request.headers["x-device-id"] === "string"
      ? request.headers["x-device-id"]
      : "";
    const expectedToken = deviceId === "PC01" || deviceId === "LEADERBOARD01"
      ? tokens[deviceId]
      : undefined;
    const authenticated = Boolean(expectedToken)
      && request.headers.authorization === `Bearer ${expectedToken}`;
    const session = sessionFromUrl(requestUrl);

    if (request.method === "GET" && requestUrl.pathname === "/health" && requestUrl.search === "") {
      observations.push({ method: "GET", route: "health", statusCode: 200 });
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/v1/ready") {
      if (!expectedToken) {
        observations.push({ method: "GET", route: "ready", statusCode: 403 });
        sendJson(response, 403, { error: "forbidden" });
        return;
      }
      if (!authenticated) {
        observations.push({ method: "GET", route: "ready", statusCode: 401 });
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (!session) {
        observations.push({ method: "GET", route: "ready", statusCode: 400 });
        sendJson(response, 400, { error: "session_invalid" });
        return;
      }
      observations.push({ method: "GET", route: "ready", statusCode: 200, deviceId, sessionKind: session.kind });
      sendJson(response, 200, {
        schema_version: 1,
        status: "ready",
        event_id: EVENT_ID,
        device_id: deviceId,
        role: deviceId === "PC01" ? "writer" : "operator",
        session
      });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/v1/records") {
      if (deviceId !== "LEADERBOARD01") {
        observations.push({ method: "GET", route: "records", statusCode: 403 });
        sendJson(response, 403, { error: "forbidden" });
        return;
      }
      if (!authenticated) {
        observations.push({ method: "GET", route: "records", statusCode: 401 });
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (!session) {
        observations.push({ method: "GET", route: "records", statusCode: 400 });
        sendJson(response, 400, { error: "session_invalid" });
        return;
      }
      observations.push({ method: "GET", route: "records", statusCode: 200, deviceId, sessionKind: session.kind });
      sendJson(response, 200, {
        schema_version: 1,
        event_id: EVENT_ID,
        session,
        generated_at: new Date().toISOString(),
        rows: records
      });
      return;
    }
    observations.push({ method: request.method || "", route: "unexpected", statusCode: 404 });
    sendJson(response, 404, { error: "not_found" });
  });
  server.on("tlsClientError", () => undefined);
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    server.close();
    throw new Error("MOCK_NAS_NOT_BOUND_TO_IPV4_LOOPBACK");
  }
  return {
    server,
    address: address.address,
    baseUrl: `https://127.0.0.1:${address.port}`,
    caPemPath: certificate.caPemPath,
    observations
  };
}

async function stopMockNas(mock) {
  if (!mock || !mock.server) return;
  await new Promise((resolve) => {
    mock.server.close(() => resolve());
    if (typeof mock.server.closeAllConnections === "function") mock.server.closeAllConnections();
  });
}

function requestJson({ url, caPemPath, headers = {} }) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url);
    if (requestUrl.protocol !== "https:" || requestUrl.hostname !== "127.0.0.1") {
      reject(new Error("SELF_TEST_REQUEST_MUST_USE_HTTPS_LOOPBACK"));
      return;
    }
    const request = https.request({
      protocol: "https:",
      hostname: "127.0.0.1",
      port: requestUrl.port,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      method: "GET",
      ca: fs.readFileSync(caPemPath),
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      agent: false,
      headers: { accept: "application/json", connection: "close", ...headers }
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve({
            statusCode: response.statusCode || 0,
            body: body ? JSON.parse(body) : null,
            tlsProtocol: response.socket.getProtocol()
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error("SELF_TEST_HTTPS_TIMEOUT")));
    request.once("error", reject);
    request.end();
  });
}


function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function terminatePidTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error("REFUSING_INVALID_CHILD_PID");
  }
  if (!isPidAlive(pid)) return;
  if (process.platform !== "win32") {
    process.kill(pid, "SIGTERM");
  } else {
    const taskkill = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "taskkill.exe"
    );
    const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      env: buildSafeSystemEnvironment(process.env),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && isPidAlive(pid)) {
      throw new Error(`PID_TREE_CLEANUP_FAILED:${pid}`);
    }
  }
  const deadline = Date.now() + 5000;
  while (isPidAlive(pid) && Date.now() < deadline) {
    await delay(50);
  }
  if (isPidAlive(pid)) throw new Error(`PID_TREE_STILL_ALIVE:${pid}`);
}


function resolveInside(root, relativePath) {
  if (typeof relativePath !== "string"
    || !relativePath.trim()
    || relativePath.includes("\0")
    || relativePath.includes(":")
    || path.isAbsolute(relativePath)) {
    throw new Error("PACKAGE_RELATIVE_PATH_INVALID");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("PACKAGE_PATH_ESCAPE_REJECTED");
  }
  return resolved;
}

function assertNoReparsePoints(boundaryRoot, targetPath) {
  const resolvedBoundary = path.resolve(boundaryRoot);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBoundary, resolvedTarget);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("PACKAGE_PATH_ESCAPE_REJECTED");
  }
  const boundaryRealPath = fs.realpathSync(resolvedBoundary);
  let current = resolvedBoundary;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) return;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`PACKAGE_REPARSE_POINT_REJECTED:${current}`);
    }
    const realPath = fs.realpathSync(current);
    if (realPath !== boundaryRealPath && !realPath.startsWith(`${boundaryRealPath}${path.sep}`)) {
      throw new Error(`PACKAGE_REALPATH_ESCAPE_REJECTED:${current}`);
    }
  }
}

function assertNonEmptyFile(boundaryRoot, filePath) {
  assertNoReparsePoints(boundaryRoot, filePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile() || fs.statSync(filePath).size <= 0) {
    throw new Error(`PACKAGE_FILE_MISSING:${filePath}`);
  }
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("STAGE_TEXTS_CSV_UNCLOSED_QUOTE");
  values.push(value);
  return values;
}

function validateStageTexts(stageCsvPath) {
  const text = fs.readFileSync(stageCsvPath, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 4) throw new Error("STAGE_TEXTS_CSV_TOO_SHORT");
  const header = parseCsvLine(lines[0]);
  const expectedHeader = [
    "id",
    "catalog_version",
    "game_mode",
    "stage_number",
    "text",
    "is_active",
    "created_at",
    "updated_at"
  ];
  if (JSON.stringify(header) !== JSON.stringify(expectedHeader)) {
    throw new Error("STAGE_TEXTS_CSV_HEADER_INVALID");
  }
  const activeAiRows = lines.slice(1).map(parseCsvLine).filter((row) =>
    row.length === expectedHeader.length
    && row[0].trim() !== ""
    && row[1].trim() !== ""
    && row[2] === "ai_challenge"
    && /^[123]$/.test(row[3])
    && row[4].trim() !== ""
    && row[5].toLowerCase() === "true"
  );
  const stages = new Set(activeAiRows.map((row) => row[3]));
  if (!["1", "2", "3"].every((stage) => stages.has(stage))) {
    throw new Error("STAGE_TEXTS_CSV_STAGE_COVERAGE_INVALID");
  }
  return activeAiRows.length;
}

function validatePackageLayout(packageRoot, config) {
  if (!config || config.schemaVersion !== undefined && config.schemaVersion !== 1) {
    throw new Error("UAT_CONFIG_SCHEMA_INVALID");
  }
  const expectedKeys = ["ai", "ai-leaderboard", "practice", "practice-leaderboard"];
  if (!Array.isArray(config.apps)
    || config.apps.length !== 4
    || JSON.stringify(config.apps.map((app) => app.key).sort()) !== JSON.stringify([...expectedKeys].sort())) {
    throw new Error("UAT_CONFIG_APPS_INVALID");
  }
  if (!Array.isArray(config.requiredResources) || config.requiredResources.length === 0) {
    throw new Error("UAT_CONFIG_RESOURCES_INVALID");
  }
  const nodePath = resolveInside(packageRoot, config.runtimeNode);
  const releaseRoot = resolveInside(packageRoot, config.releaseDirectory);
  assertNonEmptyFile(packageRoot, nodePath);
  assertNoReparsePoints(packageRoot, releaseRoot);
  if (!fs.existsSync(releaseRoot) || !fs.statSync(releaseRoot).isDirectory()) {
    throw new Error(`PACKAGE_DIRECTORY_MISSING:${releaseRoot}`);
  }
  const appPaths = new Map();
  for (const app of config.apps) {
    const appPath = resolveInside(releaseRoot, app.fileName);
    assertNonEmptyFile(packageRoot, appPath);
    appPaths.set(app.key, appPath);
  }
  const resourcePaths = config.requiredResources.map((relativePath) => {
    const resourcePath = resolveInside(releaseRoot, relativePath);
    assertNonEmptyFile(packageRoot, resourcePath);
    return { relativePath, resourcePath };
  });
  const stageResource = resourcePaths.find(({ relativePath }) =>
    relativePath.replace(/\\/g, "/") === "events/geumcheon-2026/stage_texts.csv"
  );
  if (!stageResource) throw new Error("STAGE_TEXTS_CSV_NOT_REQUIRED");
  const stageRows = validateStageTexts(stageResource.resourcePath);
  return { packageRoot: path.resolve(packageRoot), nodePath, releaseRoot, appPaths, resourcePaths, stageRows };
}


function stageAppForRun(layout, app, caseRoot) {
  const executableDirectory = path.join(caseRoot, "executable");
  fs.mkdirSync(executableDirectory, { recursive: true });
  const sourceExecutable = layout.appPaths.get(app.key);
  if (!sourceExecutable) throw new Error(`UAT_APP_NOT_VALIDATED:${app.key}`);
  const executablePath = resolveInside(executableDirectory, app.fileName);
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.copyFileSync(sourceExecutable, executablePath);
  for (const resource of layout.resourcePaths) {
    const destination = resolveInside(executableDirectory, resource.relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(resource.resourcePath, destination);
  }
  return { executableDirectory, executablePath };
}


function loadDefaultConfig(packageRoot) {
  const configPath = resolveInside(packageRoot, "runtime/uat-default-config.json");
  assertNonEmptyFile(packageRoot, configPath);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return { config, configPath };
}

function syntheticTokens() {
  return {
    PC01: crypto.randomBytes(32).toString("base64url"),
    LEADERBOARD01: crypto.randomBytes(32).toString("base64url")
  };
}

function queryForSession(sessionKind) {
  return sessionKind === "official"
    ? "session_kind=official&session_id=r2-uat-official&day_no=1&round_no=1"
    : "session_kind=practice&session_id=r2-uat-practice";
}

function safeRemoveTemporaryRoot(temporaryRoot) {
  if (!temporaryRoot || !fs.existsSync(temporaryRoot)) return;
  const resolved = path.resolve(temporaryRoot);
  const tempBase = path.resolve(os.tmpdir());
  if (!resolved.startsWith(`${tempBase}${path.sep}typingking-r2-uat-`)) {
    throw new Error("REFUSING_TEMP_ROOT_OUTSIDE_UAT_PREFIX");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  if (fs.existsSync(resolved)) throw new Error("UAT_TEMP_ROOT_STILL_EXISTS");
}

async function runSelfTest(packageRoot, config) {
  const layout = validatePackageLayout(packageRoot, config);
  const nodeVersion = spawnSync(layout.nodePath, ["--version"], {
    env: buildSafeSystemEnvironment(process.env),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  if (nodeVersion.error) throw nodeVersion.error;
  if (nodeVersion.status !== 0 || !/^v\d+\./.test((nodeVersion.stdout || "").trim())) {
    throw new Error("STANDALONE_NODE_EXECUTION_FAILED");
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-selftest-"));
  const tokens = syntheticTokens();
  let mock;
  let cleanupProbe;
  try {
    mock = await startMockNas({
      temporaryRoot,
      tokens,
      records: createSyntheticRecords()
    });
    const query = queryForSession("official");
    const headers = {
      authorization: `Bearer ${tokens.LEADERBOARD01}`,
      "x-device-id": "LEADERBOARD01"
    };
    const ready = await requestJson({
      url: `${mock.baseUrl}/api/v1/ready?${query}`,
      caPemPath: mock.caPemPath,
      headers
    });
    const snapshot = await requestJson({
      url: `${mock.baseUrl}/api/v1/records?${query}`,
      caPemPath: mock.caPemPath,
      headers
    });
    if (ready.statusCode !== 200 || ready.body?.status !== "ready") {
      throw new Error("SELF_TEST_READY_FAILED");
    }
    if (!/^TLSv1\.[23]$/.test(ready.tlsProtocol || "")) {
      throw new Error("SELF_TEST_TLS_VERSION_FAILED");
    }
    if (snapshot.statusCode !== 200 || !Array.isArray(snapshot.body?.rows) || snapshot.body.rows.length < 10) {
      throw new Error("SELF_TEST_RECORDS_FAILED");
    }

    cleanupProbe = spawn(layout.nodePath, ["-e", "setInterval(() => {}, 1000)"], {
      env: buildSafeSystemEnvironment(process.env),
      stdio: "ignore",
      windowsHide: true
    });
    if (!cleanupProbe.pid) throw new Error("SELF_TEST_CLEANUP_PROBE_PID_MISSING");
    await delay(150);
    if (!isPidAlive(cleanupProbe.pid)) throw new Error("SELF_TEST_CLEANUP_PROBE_NOT_RUNNING");
    await terminatePidTree(cleanupProbe.pid);
    if (isPidAlive(cleanupProbe.pid)) throw new Error("SELF_TEST_CLEANUP_PROBE_STILL_RUNNING");
  } finally {
    if (cleanupProbe?.pid && isPidAlive(cleanupProbe.pid)) {
      await terminatePidTree(cleanupProbe.pid);
    }
    await stopMockNas(mock);
    safeRemoveTemporaryRoot(temporaryRoot);
  }
  if (fs.existsSync(temporaryRoot)) throw new Error("SELF_TEST_TEMP_CLEANUP_FAILED");

  console.log("R2_UAT_SELF_TEST=PASS");
  console.log(`Standalone Node: ${(nodeVersion.stdout || "").trim()}`);
  console.log(`EXE files checked: ${layout.appPaths.size}`);
  console.log(`Resources checked: ${layout.resourcePaths.length}`);
  console.log(`Active AI stage rows checked: ${layout.stageRows}`);
  console.log("HTTPS Mock NAS: TLS 1.2+, 127.0.0.1 only, generated CA validated");
  console.log("Synthetic records: 24; exact cleanup probe PID tree removed");
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function runOneApp({ layout, config, app, mock, tokens, caseRoot, lifecycle }) {
  if (lifecycle.interrupted || lifecycle.cleanupStarted) throw new Error("UAT_INTERRUPTED");
  const staged = stageAppForRun(layout, app, caseRoot);
  const runtimeConfig = {
    ...config.runtimeConfig,
    pcRole: app.role,
    pcId: app.deviceId,
    isPracticeSession: app.sessionKind === "practice",
    sessionName: app.sessionKind === "practice" ? "R2 초안 UAT 연습" : "R2 초안 UAT 공식"
  };
  writeSyntheticProfile({
    caseRoot,
    executableDirectory: staged.executableDirectory,
    app,
    baseUrl: mock.baseUrl,
    token: tokens[app.deviceId],
    runtimeConfig
  });
  const environment = buildIsolatedChildEnvironment({
    inherited: process.env,
    caseRoot,
    executablePath: staged.executablePath,
    caPemPath: mock.caPemPath
  });
  if (Object.prototype.hasOwnProperty.call(environment, "NODE_TLS_REJECT_UNAUTHORIZED")) {
    throw new Error("TLS_VERIFICATION_OVERRIDE_REJECTED");
  }
  if (lifecycle.interrupted || lifecycle.cleanupStarted) throw new Error("UAT_INTERRUPTED");

  console.log("");
  console.log(`[UAT] Starting: ${app.displayName}`);
  console.log("[UAT] Use synthetic participant data only. Close the app window to continue.");
  const child = spawn(staged.executablePath, [], {
    cwd: staged.executableDirectory,
    env: environment,
    stdio: "ignore",
    windowsHide: false
  });
  if (!child.pid) throw new Error(`APP_PID_MISSING:${app.key}`);
  lifecycle.childPids.add(child.pid);
  if (lifecycle.interrupted || lifecycle.cleanupStarted) {
    try {
      if (isPidAlive(child.pid)) await terminatePidTree(child.pid);
    } finally {
      if (!isPidAlive(child.pid)) lifecycle.childPids.delete(child.pid);
    }
    throw new Error("UAT_INTERRUPTED");
  }
  try {
    const result = await waitForChild(child);
    if (lifecycle.interrupted) throw new Error("UAT_INTERRUPTED");
    if (result.code !== 0) {
      throw new Error(`APP_EXIT_FAILED:${app.key}:${result.code ?? result.signal ?? "unknown"}`);
    }
    console.log(`[UAT] Closed: ${app.displayName}`);
  } finally {
    if (isPidAlive(child.pid)) await terminatePidTree(child.pid);
    lifecycle.childPids.delete(child.pid);
  }
}

function chooseFromArguments(args, config) {
  if (args.length === 0) return undefined;
  if (args.length === 1 && args[0] === "--all") return [...config.apps];
  if (args.length === 1 && args[0].startsWith("--app=")) {
    const key = args[0].slice("--app=".length);
    const app = config.apps.find((candidate) => candidate.key === key);
    if (!app) throw new Error(`UAT_APP_UNKNOWN:${key || "(empty)"}`);
    return [app];
  }
  if (args.length === 1 && /^[1-4]$/.test(args[0])) {
    return [config.apps.find((app) => app.menu === args[0])];
  }
  throw new Error("UAT_ARGUMENTS_INVALID");
}

async function chooseFromMenu(config) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("UAT_MENU_REQUIRES_INTERACTIVE_TERMINAL");
  }
  console.log("");
  console.log("============================================================");
  console.log("금천과학축제 AI 타자왕 R2.0.1 - 독립형 초안 UAT");
  console.log("============================================================");
  console.log("합성 Credential과 127.0.0.1 HTTPS Mock NAS만 사용합니다.");
  console.log("실제 NAS·운영 Credential·실제 개인정보를 사용하지 마십시오.");
  console.log("");
  for (const app of config.apps) console.log(`${app.menu}. ${app.displayName}`);
  console.log("5. 4개 EXE 순차 실행");
  console.log("0. 종료");
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question("선택 (0-5): ")).trim();
    if (answer === "0") return [];
    if (answer === "5") return [...config.apps];
    const app = config.apps.find((candidate) => candidate.menu === answer);
    if (!app) throw new Error("UAT_MENU_SELECTION_INVALID");
    return [app];
  } finally {
    terminal.close();
  }
}

function createLifecycle() {
  return {
    childPids: new Set(),
    mock: undefined,
    temporaryRoot: undefined,
    cleanupPromise: undefined,
    cleanupStarted: false,
    cleanupComplete: false,
    interrupted: false
  };
}

async function cleanupLifecycle(lifecycle, overrides = {}) {
  if (lifecycle.cleanupPromise) return lifecycle.cleanupPromise;
  const operations = {
    isPidAlive,
    terminatePidTree,
    stopMockNas,
    safeRemoveTemporaryRoot,
    ...overrides
  };
  lifecycle.cleanupStarted = true;
  lifecycle.cleanupPromise = (async () => {
    const errors = [];
    for (const pid of [...lifecycle.childPids].reverse()) {
      try {
        if (operations.isPidAlive(pid)) await operations.terminatePidTree(pid);
      } catch (error) {
        errors.push(error);
      }
      if (operations.isPidAlive(pid)) {
        if (!errors.some((error) => String(error?.message || error).includes(String(pid)))) {
          errors.push(new Error(`PID_TREE_STILL_ALIVE:${pid}`));
        }
      } else {
        lifecycle.childPids.delete(pid);
      }
    }
    try {
      await operations.stopMockNas(lifecycle.mock);
      lifecycle.mock = undefined;
    } catch (error) {
      errors.push(error);
    }
    if (lifecycle.childPids.size === 0 && lifecycle.temporaryRoot) {
      try {
        operations.safeRemoveTemporaryRoot(lifecycle.temporaryRoot);
        lifecycle.temporaryRoot = undefined;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0 || lifecycle.childPids.size > 0) {
      throw new AggregateError(errors, "UAT_CLEANUP_FAILED");
    }
    lifecycle.cleanupComplete = true;
  })();
  try {
    return await lifecycle.cleanupPromise;
  } finally {
    lifecycle.cleanupPromise = undefined;
  }
}

function installSignalCleanup(lifecycle) {
  const onSignal = (signal) => {
    if (lifecycle.interrupted) return;
    lifecycle.interrupted = true;
    console.error(`\n[UAT] ${signal} received. Cleaning the exact child PID tree and temporary runtime...`);
    void cleanupLifecycle(lifecycle).catch((error) => {
      console.error(`[UAT] Cleanup error: ${error.message}`);
    });
  };
  process.once("SIGINT", () => onSignal("Ctrl+C"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  if (process.platform === "win32") process.once("SIGBREAK", () => onSignal("Ctrl+Break"));
}

async function runInteractiveUat(packageRoot, config, args) {
  const layout = validatePackageLayout(packageRoot, config);
  const selected = chooseFromArguments(args, config) ?? await chooseFromMenu(config);
  if (selected.length === 0) return;
  const lifecycle = createLifecycle();
  installSignalCleanup(lifecycle);
  lifecycle.temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-run-"));
  const tokens = syntheticTokens();
  try {
    lifecycle.mock = await startMockNas({
      temporaryRoot: lifecycle.temporaryRoot,
      tokens,
      records: createSyntheticRecords()
    });
    console.log(`[UAT] Local HTTPS Mock NAS: ${lifecycle.mock.baseUrl}`);
    console.log("[UAT] TLS verification remains enabled with a one-day temporary CA.");
    for (let index = 0; index < selected.length; index += 1) {
      if (lifecycle.interrupted) throw new Error("UAT_INTERRUPTED");
      await runOneApp({
        layout,
        config,
        app: selected[index],
        mock: lifecycle.mock,
        tokens,
        caseRoot: path.join(lifecycle.temporaryRoot, `case-${index + 1}-${selected[index].key}`),
        lifecycle
      });
    }
  } finally {
    await cleanupLifecycle(lifecycle);
  }
  if (lifecycle.interrupted) throw new Error("UAT_INTERRUPTED");
  if (!lifecycle.cleanupComplete) throw new Error("UAT_CLEANUP_INCOMPLETE");
  console.log("");
  console.log("R2_UAT_SESSION_CLEANUP=PASS");
}

function printUsage() {
  console.log("Run_R2_UAT.cmd");
  console.log("Run_R2_UAT.cmd --self-test");
  console.log("Run_R2_UAT.cmd --all");
  console.log("Run_R2_UAT.cmd --app=ai|ai-leaderboard|practice|practice-leaderboard");
}

async function main() {
  const packageRoot = path.resolve(__dirname, "..");
  const { config } = loadDefaultConfig(packageRoot);
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    printUsage();
    return;
  }
  if (args.length === 1 && args[0] === "--self-test") {
    await runSelfTest(packageRoot, config);
    return;
  }
  await runInteractiveUat(packageRoot, config, args);
}

module.exports = {
  buildIsolatedChildEnvironment,
  cleanupLifecycle,
  createLifecycle,
  createSyntheticRecords,
  isPidAlive,
  requestJson,
  resolveInside,
  runOneApp,
  startMockNas,
  stageAppForRun,
  stopMockNas,
  terminatePidTree,
  validatePackageLayout,
  writeSyntheticProfile
};








if (require.main === module) {
  main().catch((error) => {
    const selfTest = process.argv.slice(2).includes("--self-test");
    console.error(selfTest ? "R2_UAT_SELF_TEST=FAIL" : "R2_UAT_RUN=FAIL");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.message === "UAT_INTERRUPTED" ? 130 : 1;
  });
}
