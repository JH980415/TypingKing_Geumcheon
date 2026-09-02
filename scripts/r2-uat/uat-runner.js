"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const APPS = new Set(["ai", "ai-leaderboard", "practice", "practice-leaderboard"]);
const REQUIRED = ["00_먼저읽어주세요.txt", "01_AI타자왕_테스트실행.cmd", "02_AI타자왕_리더보드_테스트실행.cmd", "03_AI타자왕_연습모드_테스트실행.cmd", "04_연습모드_리더보드_테스트실행.cmd", "05_전체_순차테스트.cmd", "06_공식모드_플레이어+리더보드_동시테스트.cmd", "07_연습모드_플레이어+리더보드_동시테스트.cmd", "08_샘플데이터_리더보드_화면검수.cmd", "09_UAT기록_초기화.cmd", "Run_R2_UAT.cmd", "G-Science AI 타자왕.exe", "G-Science AI 타자왕 리더보드.exe", "G-Science AI 타자왕 연습모드.exe", "G-Science AI 타자왕 연습모드 리더보드.exe"];
const EVENT_ID = "geumcheon-science-festival-2026";
const OFFICIAL_SESSION_ID = "r2-uat-official";
const PRACTICE_SESSION_ID = "r2-uat-practice";

function packageRoot() { return path.resolve(__dirname, ".."); }

function resolveInside(root, relative) {
  if (typeof relative !== "string" || !relative.trim() || path.isAbsolute(relative) || relative.includes(":")) throw new Error("PACKAGE_RELATIVE_PATH_INVALID");
  const boundary = path.resolve(root);
  const resolved = path.resolve(boundary, relative);
  if (resolved === boundary || !resolved.startsWith(`${boundary}${path.sep}`)) throw new Error("PACKAGE_PATH_ESCAPE_REJECTED");
  return resolved;
}

function rejectReparse(root, target) {
  const boundary = path.resolve(root);
  const relative = path.relative(boundary, path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("PACKAGE_PATH_ESCAPE_REJECTED");
  const boundaryReal = fs.realpathSync(boundary).toLowerCase();
  let cursor = boundary;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) return;
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("PACKAGE_REPARSE_POINT_REJECTED");
    const real = fs.realpathSync(cursor).toLowerCase();
    if (real !== boundaryReal && !real.startsWith(`${boundaryReal}${path.sep.toLowerCase()}`)) throw new Error("PACKAGE_REALPATH_ESCAPE_REJECTED");
  }
}

function ensureCorePackage(root) {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot) || fs.lstatSync(resolvedRoot).isSymbolicLink()) throw new Error("PACKAGE_REPARSE_POINT_REJECTED");
  const realRoot = fs.realpathSync(resolvedRoot).toLowerCase();
  if (realRoot !== resolvedRoot.toLowerCase()) throw new Error("PACKAGE_REPARSE_POINT_REJECTED");
  if (resolvedRoot.toLowerCase().includes(`.zip${path.sep}`)) throw new Error("압축파일 안에서는 실행할 수 없습니다. ZIP을 먼저 완전히 압축 해제한 뒤 01~09 테스트 실행파일을 사용해 주세요.");
  for (const name of [...REQUIRED, "runtime/node.exe", "runtime/uat-runner.js", "runtime/uat-runner-r2-0-1-base.js", "runtime/uat-default-config.json"]) {
    const target = resolveInside(resolvedRoot, name);
    rejectReparse(resolvedRoot, target);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile() || fs.statSync(target).size === 0) throw new Error("UAT 필수 파일이 누락되었습니다. 패키지를 다시 압축 해제해 주세요.");
  }
}

function loadConfig(root) {
  const configPath = resolveInside(root, "runtime/uat-default-config.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function loadBaseRunner() { return require("./uat-runner-r2-0-1-base.js"); }

function runnablePackageError(error) {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`UAT 실행 파일 또는 리소스가 누락되었습니다. R2_UAT_RELEASE_v2.zip을 완전히 압축 해제한 뒤 다시 실행해 주세요. (${detail})`);
}

function validateRunnablePackage(root) {
  ensureCorePackage(root);
  try {
    const config = loadConfig(root);
    const layout = loadBaseRunner().validatePackageLayout(root, config);
    return { config, layout };
  } catch (error) {
    throw runnablePackageError(error);
  }
}

function packageStore(root) {
  const store = resolveInside(root, "records");
  rejectReparse(root, store);
  fs.mkdirSync(store, { recursive: true });
  if (fs.lstatSync(store).isSymbolicLink()) throw new Error("UAT_STORE_REPARSE_POINT_REJECTED");
  return store;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

function recordFile(root, kind) {
  if (kind !== "official" && kind !== "practice") throw new Error("UAT_RECORD_KIND_INVALID");
  const file = resolveInside(packageStore(root), `normal/${kind}.json`);
  rejectReparse(root, file);
  return file;
}

function readNormalRows(root, kind) {
  const file = recordFile(root, kind);
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || value.namespace !== `normal-${kind}` || !Array.isArray(value.records)) throw new Error("UAT_RECORD_STORE_INVALID");
  return value.records;
}

function writeNormalRows(root, kind, rows) {
  atomicJson(recordFile(root, kind), { schemaVersion: 1, namespace: `normal-${kind}`, records: rows });
}

function sampleRows() {
  return Array.from({ length: 12 }, (_, index) => ({
    record_id: `gsc26-pc01-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    participant_name: `샘플참가자${String(index + 1).padStart(2, "0")}`,
    phone_masked: `010-****-${1001 + index}`,
    game_mode: "ai_challenge"
  }));
}

function writeSample(root) {
  const file = resolveInside(packageStore(root), "sample/leaderboard.json");
  rejectReparse(root, file);
  atomicJson(file, { schemaVersion: 1, namespace: "sample-only", records: sampleRows() });
}

function readSampleRows(root) {
  const file = resolveInside(packageStore(root), "sample/leaderboard.json");
  if (!fs.existsSync(file)) writeSample(root);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || value.namespace !== "sample-only" || !Array.isArray(value.records) || value.records.length !== 12) throw new Error("UAT_SAMPLE_STORE_INVALID");
  return value.records;
}

function resetNormal(root) {
  ensureCorePackage(root);
  const normal = resolveInside(packageStore(root), "normal");
  if (fs.existsSync(normal)) {
    if (fs.lstatSync(normal).isSymbolicLink()) throw new Error("UAT_STORE_REPARSE_POINT_REJECTED");
    fs.rmSync(normal, { recursive: true, force: true });
  }
}

function safeEnvironment(additions) {
  const allowed = ["COMSPEC", "NUMBER_OF_PROCESSORS", "OS", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "SYSTEMDRIVE", "SYSTEMROOT", "WINDIR"];
  const env = {};
  for (const name of allowed) if (process.env[name]) env[name] = process.env[name];
  return { ...env, ...additions };
}

function writeSyntheticProfile({ caseRoot, executableDirectory, app, baseUrl, token, operatorToken }) {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/") throw new Error("UAT_API_MUST_BE_HTTPS_LOOPBACK");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("SYNTHETIC_TOKEN_INVALID");
  if (app.role === "leaderboard" && !/^[A-Za-z0-9_-]{43}$/.test(operatorToken || "")) throw new Error("SYNTHETIC_OPERATOR_TOKEN_INVALID");
  const localAppData = path.join(caseRoot, "LocalAppData");
  const appData = path.join(caseRoot, "RoamingAppData");
  const temp = path.join(caseRoot, "Temp");
  const runtimeRoot = path.join(localAppData, "ThePMD", "TypingKing2026", "geumcheon-2026", app.deviceId);
  const userDataPath = path.join(runtimeRoot, "electron-user-data");
  for (const directory of [executableDirectory, localAppData, appData, temp, userDataPath]) fs.mkdirSync(directory, { recursive: true });
  atomicJson(path.join(executableDirectory, "device-profile.json"), { schemaVersion: 1, eventProfileId: "geumcheon-2026", eventId: EVENT_ID, deviceId: app.deviceId, role: app.role, apiBaseUrl: baseUrl, sessions: { official: { sessionId: OFFICIAL_SESSION_ID, dayNo: 1, roundNo: 1 }, practice: { sessionId: PRACTICE_SESSION_ID } }, requestTimeoutMs: 5000, retry: { initialDelayMs: 1000, maxDelayMs: 2000 } });
  atomicJson(path.join(executableDirectory, "bootstrap-credentials.json"), { schemaVersion: 1, eventId: EVENT_ID, deviceId: app.deviceId, apiBaseUrl: baseUrl, token });
  if (app.role === "leaderboard") {
    atomicJson(path.join(executableDirectory, "bootstrap-operator-credentials.json"), { schemaVersion: 1, eventId: EVENT_ID, deviceId: app.deviceId, apiBaseUrl: baseUrl, token: operatorToken });
  }
  return { runtimeRoot, userDataPath };
}

function buildIsolatedChildEnvironment({ inherited, caseRoot, executablePath, caPemPath }) {
  const localAppData = path.join(caseRoot, "LocalAppData");
  const appData = path.join(caseRoot, "RoamingAppData");
  const temp = path.join(caseRoot, "Temp");
  for (const directory of [localAppData, appData, temp]) fs.mkdirSync(directory, { recursive: true });
  const environment = safeEnvironment({});
  for (const name of ["COMSPEC", "NUMBER_OF_PROCESSORS", "OS", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "SYSTEMDRIVE", "SYSTEMROOT", "WINDIR"]) if (inherited[name]) environment[name] = inherited[name];
  return { ...environment, PORTABLE_EXECUTABLE_DIR: path.dirname(executablePath), PORTABLE_EXECUTABLE_FILE: executablePath, LOCALAPPDATA: localAppData, APPDATA: appData, TEMP: temp, TMP: temp, NODE_EXTRA_CA_CERTS: caPemPath, NO_PROXY: "127.0.0.1,localhost", TYPINGKING_E2E_PROFILE: "functional-flow" };
}

function createCertificate(tempRoot) {
  const certificateRoot = path.join(tempRoot, "certificates");
  fs.mkdirSync(certificateRoot, { recursive: true });
  const pfx = path.join(certificateRoot, "localhost.pfx");
  const ca = path.join(certificateRoot, "ca.pem");
  const password = crypto.randomBytes(24).toString("base64url");
  const script = String.raw`$ErrorActionPreference='Stop';$p=$env:R2P;$c=$env:R2C;$w=$env:R2W;$now=[DateTimeOffset]::UtcNow;$caKey=[Security.Cryptography.RSA]::Create(2048);$caReq=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=TypingKing R2 UAT Test CA',$caKey,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1);$caReq.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true));$caUsage=[Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign;$caReq.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($caUsage,$true));$caReq.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($caReq.PublicKey,$false));$caCert=$caReq.CreateSelfSigned($now.AddMinutes(-10),$now.AddDays(2));$leafKey=[Security.Cryptography.RSA]::Create(2048);$leafReq=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost',$leafKey,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1);$san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new();$san.AddDnsName('localhost');$san.AddIpAddress([Net.IPAddress]::Parse('127.0.0.1'));$leafReq.CertificateExtensions.Add($san.Build());$leafReq.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true));$leafUsage=[Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment;$leafReq.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($leafUsage,$true));$eku=[Security.Cryptography.OidCollection]::new();[void]$eku.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'));$leafReq.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku,$false));$serial=New-Object byte[] 16;$rng=[Security.Cryptography.RandomNumberGenerator]::Create();$rng.GetBytes($serial);$leafPublic=$leafReq.Create($caCert,$now.AddMinutes(-5),$now.AddDays(1),$serial);$leaf=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($leafPublic,$leafKey);$caPublic=[Security.Cryptography.X509Certificates.X509Certificate2]::new($caCert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert));$bundle=[Security.Cryptography.X509Certificates.X509Certificate2Collection]::new();[void]$bundle.Add($leaf);[void]$bundle.Add($caPublic);[IO.File]::WriteAllBytes($p,$bundle.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pkcs12,$w));$b=[Convert]::ToBase64String($caPublic.RawData,[Base64FormattingOptions]::InsertLineBreaks);$nl=[Environment]::NewLine;[IO.File]::WriteAllText($c,"-----BEGIN CERTIFICATE-----"+$nl+$b+$nl+"-----END CERTIFICATE-----"+$nl,[Text.Encoding]::ASCII);$rng.Dispose();$leaf.Dispose();$leafPublic.Dispose();$caPublic.Dispose();$caCert.Dispose();$leafKey.Dispose();$caKey.Dispose()`;
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { env: safeEnvironment({ R2P: pfx, R2C: ca, R2W: password, TEMP: certificateRoot, TMP: certificateRoot }), windowsHide: true });
  if (result.error || result.status !== 0 || !fs.existsSync(pfx) || !fs.existsSync(ca)) throw new Error("TEMPORARY_CERTIFICATE_FAILED");
  return { pfx, ca, password };
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CANONICAL_NUMBER_MUST_BE_FINITE");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") throw new Error("CANONICAL_VALUE_INVALID");
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
  return output;
}

function canonicalStringify(value) { return JSON.stringify(canonicalize(value)); }
function sha256(value) { return crypto.createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex"); }

function hasExactKeys(value, expected) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function sessionFromUrl(url) {
  const kind = url.searchParams.get("session_kind");
  const sessionId = url.searchParams.get("session_id");
  const keys = [...url.searchParams.keys()].sort();
  if (kind === "official"
    && JSON.stringify(keys) === JSON.stringify(["day_no", "round_no", "session_id", "session_kind"])
    && sessionId === OFFICIAL_SESSION_ID
    && url.searchParams.get("day_no") === "1"
    && url.searchParams.get("round_no") === "1") {
    return { kind, session_id: sessionId, day_no: 1, round_no: 1 };
  }
  if (kind === "practice"
    && JSON.stringify(keys) === JSON.stringify(["session_id", "session_kind"])
    && sessionId === PRACTICE_SESSION_ID) {
    return { kind, session_id: sessionId };
  }
  return undefined;
}

function sessionFromEnvelope(value) {
  if (hasExactKeys(value, ["kind", "session_id", "day_no", "round_no"])
    && value.kind === "official"
    && value.session_id === OFFICIAL_SESSION_ID
    && value.day_no === 1
    && value.round_no === 1) {
    return { kind: "official", session_id: OFFICIAL_SESSION_ID, day_no: 1, round_no: 1 };
  }
  if (hasExactKeys(value, ["kind", "session_id"])
    && value.kind === "practice"
    && value.session_id === PRACTICE_SESSION_ID) {
    return { kind: "practice", session_id: PRACTICE_SESSION_ID };
  }
  return undefined;
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", connection: "close" });
  response.end(JSON.stringify(body));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) request.destroy(new Error("REQUEST_BODY_TOO_LARGE"));
    });
    request.once("error", reject);
    request.on("end", () => resolve(body));
  });
}

function rowsForNamespace(root, namespace, session) {
  if (namespace === "sample") return readSampleRows(root);
  return readNormalRows(root, session.kind);
}

function storeEnvelope(root, session, envelope) {
  if (!hasExactKeys(envelope, ["schema_version", "event_id", "session", "row"])
    || envelope.schema_version !== 1
    || envelope.event_id !== EVENT_ID
    || !envelope.row
    || typeof envelope.row !== "object"
    || Array.isArray(envelope.row)
    || typeof envelope.row.record_id !== "string") {
    throw new Error("NAS_RECORD_ENVELOPE_INVALID");
  }
  const normalizedSession = sessionFromEnvelope(envelope.session);
  if (!normalizedSession) throw new Error("NAS_RECORD_SESSION_INVALID");
  if (canonicalStringify(envelope.session) !== canonicalStringify(session)) throw new Error("NAS_RECORD_SESSION_MISMATCH");
  if (!/^gsc26-pc(?:0[1-9]|10)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(envelope.row.record_id)) throw new Error("NAS_RECORD_ID_INVALID");
  const rows = readNormalRows(root, session.kind);
  const payloadHash = sha256(envelope);
  const storedHash = sha256(envelope.row);
  const existing = rows.find(row => row.record_id === envelope.row.record_id);
  if (existing) {
    if (sha256(existing) !== storedHash) return { status: 409, body: { schema_version: 1, code: "IDEMPOTENCY_CONFLICT", message: "같은 기록 ID에 다른 내용이 전송되었습니다." } };
    return { status: 200, body: { schema_version: 1, disposition: "duplicate", record_id: envelope.row.record_id, payload_sha256: payloadHash, stored_sha256: storedHash, received_at: new Date().toISOString() } };
  }
  writeNormalRows(root, session.kind, [...rows, envelope.row]);
  return { status: 201, body: { schema_version: 1, disposition: "stored", record_id: envelope.row.record_id, payload_sha256: payloadHash, stored_sha256: storedHash, received_at: new Date().toISOString() } };
}

function startPersistentMock({ temporaryRoot, packageRoot: root, tokens, namespace = "normal", records = [] }) {
  const certificate = createCertificate(temporaryRoot);
  const server = https.createServer({ pfx: fs.readFileSync(certificate.pfx), passphrase: certificate.password, minVersion: "TLSv1.2" }, async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "https://127.0.0.1");
      const device = String(request.headers["x-device-id"] || "");
      const writerExpected = tokens[device];
      const leaderboardExpected = tokens.LEADERBOARD01;
      const operatorExpected = tokens.LEADERBOARD01_OPERATOR;
      const presented = request.headers.authorization;
      const session = sessionFromUrl(requestUrl);
      if (request.method === "GET" && requestUrl.pathname === "/api/v1/ready") {
        if (!session) return sendJson(response, 400, { error: "session_invalid" });
        const role = device === "LEADERBOARD01" && Boolean(leaderboardExpected) && presented === `Bearer ${leaderboardExpected}`
          ? "leaderboard"
          : device === "LEADERBOARD01" && Boolean(operatorExpected) && presented === `Bearer ${operatorExpected}`
            ? "operator"
            : /^PC(?:0[1-9]|10)$/.test(device) && Boolean(writerExpected) && presented === `Bearer ${writerExpected}`
              ? "writer"
              : undefined;
        if (!role) return sendJson(response, 401, { error: "unauthorized" });
        return sendJson(response, 200, { schema_version: 1, status: "ready", event_id: EVENT_ID, device_id: device, role, session });
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/v1/records") {
        if (device !== "LEADERBOARD01") return sendJson(response, 403, { error: "forbidden" });
        if (!leaderboardExpected || presented !== `Bearer ${leaderboardExpected}`) return sendJson(response, 403, { error: "forbidden" });
        if (!session) return sendJson(response, 400, { error: "session_invalid" });
        const rows = namespace === "self-test" ? records : rowsForNamespace(root, namespace, session);
        return sendJson(response, 200, { schema_version: 1, event_id: EVENT_ID, session, generated_at: new Date().toISOString(), rows });
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/v1/records") {
        if (namespace !== "normal") return sendJson(response, 403, { error: "sample_read_only" });
        if (!/^PC(?:0[1-9]|10)$/.test(device)) return sendJson(response, 403, { error: "forbidden" });
        if (!writerExpected || presented !== `Bearer ${writerExpected}`) return sendJson(response, 401, { error: "unauthorized" });
        const body = await readRequestBody(request);
        const envelope = JSON.parse(body || "{}");
        const sessionForPost = sessionFromEnvelope(envelope.session);
        if (!sessionForPost) return sendJson(response, 422, { schema_version: 1, code: "RECORD_VALIDATION_FAILED", message: "UAT 합성 기록의 세션 형식이 올바르지 않습니다." });
        if (typeof envelope?.row?.record_id !== "string" || !envelope.row.record_id.startsWith(`gsc26-${device.toLowerCase()}-`)) {
          return sendJson(response, 422, { schema_version: 1, code: "DEVICE_MISMATCH", message: "장치와 기록 ID가 일치하지 않습니다." });
        }
        const idempotencyKey = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : "";
        if (idempotencyKey !== envelope?.row?.record_id) return sendJson(response, 422, { schema_version: 1, code: "IDEMPOTENCY_KEY_MISMATCH", message: "기록 ID와 멱등성 키가 일치하지 않습니다." });
        const result = storeEnvelope(root, sessionForPost, envelope);
        return sendJson(response, result.status, result.body);
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/v1/admin/actions") {
        if (device !== "LEADERBOARD01" || !operatorExpected || presented !== `Bearer ${operatorExpected}`) {
          return sendJson(response, 403, { error: "forbidden" });
        }
        await readRequestBody(request);
        return sendJson(response, 200, { ok: true });
      }
      return sendJson(response, 404, { error: "not_found" });
    } catch {
      return sendJson(response, 422, { schema_version: 1, code: "RECORD_VALIDATION_FAILED", message: "UAT 합성 기록 형식이 올바르지 않습니다." });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string" || address.address !== "127.0.0.1") return reject(new Error("MOCK_NAS_NOT_LOOPBACK"));
      resolve({ server, baseUrl: `https://127.0.0.1:${address.port}`, caPemPath: certificate.ca, tokens });
    });
  });
}

async function closeMock(mock) {
  if (!mock || !mock.server) return;
  if (!mock.server.listening) {
    if (typeof mock.server.closeAllConnections === "function") mock.server.closeAllConnections();
    return;
  }
  await new Promise((resolve, reject) => {
    mock.server.close(error => error ? reject(error) : resolve());
    if (typeof mock.server.closeAllConnections === "function") mock.server.closeAllConnections();
  });
}

function requestJson(url, ca, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.hostname !== "127.0.0.1") return reject(new Error("SELF_TEST_REQUEST_MUST_USE_HTTPS_LOOPBACK"));
    const data = body == null ? undefined : canonicalStringify(body);
    const request = https.request({ hostname: "127.0.0.1", port: target.port, path: `${target.pathname}${target.search}`, method: data ? "POST" : "GET", ca: fs.readFileSync(ca), rejectUnauthorized: true, minVersion: "TLSv1.2", headers: { ...headers, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } }, response => {
      const protocol = response.socket && response.socket.getProtocol();
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => text += chunk);
      response.on("end", () => resolve({ status: response.statusCode, protocol, body: text ? JSON.parse(text) : null }));
    });
    request.once("error", reject);
    if (data) request.write(data);
    request.end();
  });
}

function removeTemporary(root) {
  const resolved = path.resolve(root);
  const temp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(`${temp}${path.sep}typingking-r2-uat-`)) throw new Error("REFUSING_TEMP_ROOT_OUTSIDE_UAT_PREFIX");
  fs.rmSync(resolved, { recursive: true, force: true });
}

class MockApiLease {
  constructor(root, starter = startPersistentMock) { this.root = root; this.starter = starter; this.count = 0; this.mock = undefined; this.temp = undefined; }
  async acquire() {
    if (!this.mock) {
      this.temp = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-lease-"));
      try {
        this.mock = await this.starter({ temporaryRoot: this.temp, packageRoot: this.root, tokens: syntheticTokens() });
      } catch (error) {
        removeTemporary(this.temp);
        this.temp = undefined;
        throw error;
      }
    }
    this.count += 1;
    return { baseUrl: this.mock.baseUrl, caPemPath: this.mock.caPemPath };
  }
  activeCount() { return this.count; }
  async release() {
    if (this.count <= 0) throw new Error("UAT_MOCK_LEASE_UNDERFLOW");
    this.count -= 1;
    if (!this.count) {
      await closeMock(this.mock);
      this.mock = undefined;
      removeTemporary(this.temp);
      this.temp = undefined;
    }
  }
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--self-test") result.selfTest = true;
    else if (arg === "--all") result.all = true;
    else if (arg === "--sample-leaderboard") result.sample = true;
    else if (arg === "--reset-records") result.reset = true;
    else if (arg === "--app") result.app = argv[++i];
    else if (arg && arg.startsWith("--app=")) result.app = arg.slice(6);
    else if (arg === "--pair") result.pair = argv[++i];
    else if (arg && arg.startsWith("--pair=")) result.pair = arg.slice(7);
    else throw new Error("UAT_ARGUMENTS_INVALID");
  }
  if (result.app && !APPS.has(result.app)) throw new Error("UAT_APP_INVALID");
  if (result.pair && !["official", "practice"].includes(result.pair)) throw new Error("UAT_PAIR_INVALID");
  if ([result.app, result.all, result.sample, result.reset, result.pair].filter(Boolean).length > 1) throw new Error("UAT_MODE_CONFLICT");
  return result;
}

function syntheticTokens() {
  const tokens = { LEADERBOARD01: crypto.randomBytes(32).toString("base64url") };
  tokens.LEADERBOARD01_OPERATOR = crypto.randomBytes(32).toString("base64url");
  for (let index = 1; index <= 10; index += 1) {
    tokens[`PC${String(index).padStart(2, "0")}`] = crypto.randomBytes(32).toString("base64url");
  }
  return tokens;
}
function queryFor(kind) { return kind === "practice" ? `session_kind=practice&session_id=${PRACTICE_SESSION_ID}` : `session_kind=official&session_id=${OFFICIAL_SESSION_ID}&day_no=1&round_no=1`; }
function appKeys(options, config) {
  if (options.sample) return ["ai-leaderboard"];
  if (options.app) return [options.app];
  if (options.pair === "official") return ["ai", "ai-leaderboard"];
  if (options.pair === "practice") return ["practice", "practice-leaderboard"];
  if (options.all) return config.apps.map(app => app.key);
  return [];
}

async function runValidatedApps(root, options) {
  const { config, layout } = validateRunnablePackage(root);
  const base = loadBaseRunner();
  const selected = appKeys(options, config).map(key => config.apps.find(app => app.key === key));
  if (selected.some(app => !app)) throw new Error("UAT_APP_INVALID");
  if (options.sample) writeSample(root);
  const lifecycle = base.createLifecycle();
  lifecycle.temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-run-"));
  const tokens = syntheticTokens();
  try {
    lifecycle.mock = await startPersistentMock({ temporaryRoot: lifecycle.temporaryRoot, packageRoot: root, tokens, namespace: options.sample ? "sample" : "normal" });
    const launch = app => base.runOneApp({ layout, config, app, mock: lifecycle.mock, tokens, caseRoot: path.join(lifecycle.temporaryRoot, `case-${app.key}`), lifecycle });
    if (options.pair) await Promise.all(selected.map(launch));
    else for (const app of selected) await launch(app);
  } finally {
    await base.cleanupLifecycle(lifecycle);
  }
  if (!lifecycle.cleanupComplete) throw new Error("UAT_CLEANUP_INCOMPLETE");
  console.log("R2_UAT_SESSION_CLEANUP=PASS");
}

async function selfTest(root) {
  const { layout } = validateRunnablePackage(root);
  const nodeVersion = spawnSync(layout.nodePath, ["--version"], { env: safeEnvironment({}), encoding: "utf8", windowsHide: true });
  if (nodeVersion.error || nodeVersion.status !== 0 || !/^v\d+\./.test((nodeVersion.stdout || "").trim())) throw new Error("STANDALONE_NODE_EXECUTION_FAILED");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-selftest-"));
  const tokens = syntheticTokens();
  let mock;
  try {
    mock = await startPersistentMock({ temporaryRoot, packageRoot: root, tokens, namespace: "self-test", records: sampleRows() });
    const headers = { authorization: `Bearer ${tokens.LEADERBOARD01}`, "x-device-id": "LEADERBOARD01" };
    const ready = await requestJson(`${mock.baseUrl}/api/v1/ready?${queryFor("official")}`, mock.caPemPath, headers);
    const snapshot = await requestJson(`${mock.baseUrl}/api/v1/records?${queryFor("official")}`, mock.caPemPath, headers);
    if (ready.status !== 200 || ready.body.status !== "ready" || !/^TLSv1\.[23]$/.test(ready.protocol || "")) throw new Error("R2_UAT_TLS_SELF_TEST_FAILED");
    if (snapshot.status !== 200 || !Array.isArray(snapshot.body.rows) || snapshot.body.rows.length !== 12) throw new Error("R2_UAT_RECORD_SELF_TEST_FAILED");
  } finally {
    await closeMock(mock);
    removeTemporary(temporaryRoot);
  }
  console.log("R2_UAT_SELF_TEST=PASS");
  console.log("TLS verification remains enabled with a temporary CA.");
  console.log(`EXE files checked: ${layout.appPaths.size}`);
  console.log(`Resources checked: ${layout.resourcePaths.length}`);
}

async function main(argv) {
  const root = packageRoot();
  const options = parseArgs(argv);
  if (options.reset) {
    resetNormal(root);
  } else if (options.selfTest) {
    await selfTest(root);
  } else if (options.sample || options.app || options.all || options.pair) {
    await runValidatedApps(root, options);
  } else {
    throw new Error("UAT_ARGUMENTS_INVALID");
  }
  console.log(JSON.stringify({ ok: true }));
}

module.exports = { MockApiLease, buildIsolatedChildEnvironment, closeMock, ensureCorePackage, parseArgs, requestJson, resolveInside, sampleRows, startPersistentMock, validateRunnablePackage, writeSample, writeSyntheticProfile };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
