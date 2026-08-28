# Geumcheon Deployment, Synology Packaging, and Verification Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Produce a secure PC01-PC10 plus LEADERBOARD01 USB deployment, a hardened Synology installation bundle, a verified rental-PC cleanup workflow, and a nontechnical development-verification report for the Geumcheon AI Typing King release.

**Architecture:** Treat release-geumcheon as a credential-free intermediate runtime. Generate device secrets once into the ignored deployment-private root, then create the ignored USB master by allowlisted copying so each device receives only its own profile and credentials. Keep Synology configuration examples tracked but actual domain, volume, token hashes, and environment settings private. Build every completion claim from machine-readable verification evidence, and keep live NAS and venue results separate from local/package results.

**Tech Stack:** Node.js 24 LTS for the NAS container, Node.js ESM deployment scripts, TypeScript 5.9 tests through tsx and node:test, Electron 43 packaging and PDF rendering, PowerShell 5.1-compatible rental-PC cleanup, Docker Compose for Synology Container Manager.

**Spec:** docs/superpowers/specs/2026-08-25-geumcheon-typingking-design.md

## Global Constraints

- Work only on local branch geumcheon-2026 and do not push it until the user separately approves a GitHub upload.
- Preserve the SkillUp main branch, default profile behavior, existing release folder, and existing six SkillUp executables.
- Consume the credential-free shared runtime from release-geumcheon; never add credentials or actual NAS settings to that root.
- Generated roots are exactly release-geumcheon/, deployment-private/geumcheon-2026/, and deployment-output/geumcheon-2026/; all must remain ignored and untracked.
- The Geumcheon USB contains exactly ten player folders PC01-PC10 and one LEADERBOARD01 folder.
- Player folders contain only G-Science AI 타자왕.exe and G-Science AI 타자왕_연습모드.exe plus the shared runtime and that device's files.
- LEADERBOARD01 contains only G-Science AI 타자왕_리더보드.exe and G-Science AI 타자왕_연습모드_리더보드.exe plus the shared runtime and its read/operator files.
- Device profiles are nonsecret. Bootstrap credentials, local admin PIN 0208, raw API tokens, token hashes, actual NAS domain, volume paths, records, queues, logs, receipts, and final USB output are never committed.
- Production generation must fail unless an approved privacy-notice version and retention expiry are present in private configuration.
- Client bootstrap credentials are imported with Electron safeStorage on the copied rental PC and the copied plaintext file is removed only after verified encrypted persistence. The protected USB master is not modified.
- The external NAS surface is HTTPS 443 with a valid public certificate and TLS 1.2 or later. SMB 139/445, DSM 5000/5001, WebDAV, and the container port remain private.
- The runtime path is %LOCALAPPDATA%\ThePMD\TypingKing2026\geumcheon-2026\<deviceId>.
- Cleanup must refuse while any official/practice outbox, recovery, or conflict file remains and must never remove another event/device or a broad parent directory.
- A 16 GB or larger USB is required. Generation must stop before exceeding a conservative 14 GiB usable-capacity gate.
- Actual NAS, router, certificate, external-network, ten-rental-PC, and venue checks must be reported as not run until evidence from those environments exists.
- The final report uses only the statuses 통과, 부분 확인, 미실행, and 실패; it must never infer NAS deployment or venue readiness from source/unit/package tests.
- Execute this plan only after both the client-foundation and NAS-sync plans. Treat their shared types, Electron integration, `release-geumcheon/`, NAS commands, ignore rules, and PII scanner as completed inputs; deployment changes are additive and must not remove or rename those contracts.
- Within this plan, Task 1 owns generated-root additions to `.gitignore` and provisioning commands, Task 5 only extends the existing PII scanner and verifies the final ignore/Git boundary, and Task 7 owns the final additive root command aggregation. No tasks edit these shared files concurrently.

## File Structure

- Modify .gitignore: protect the three generated roots, private environment files, cleanup receipts, and final reports.
- Modify package.json and package-lock.json: expose focused provisioning, deployment, cleanup, Synology, security, E2E, PDF, and report commands.
- Create deploy/geumcheon/client-config.example.json: tracked, nonfunctional example for private client settings.
- Create scripts/provision-device-tokens.mjs: cryptographic token generation, hashing, private bundle writes, and revocation.
- Create scripts/prepare-geumcheon-deployment.mjs: allowlisted PC01-PC10 and LEADERBOARD01 USB generation.
- Create scripts/verify-geumcheon-deployment.mjs: structural, hash, credential-scope, PII, and Git-tracking gates.
- Create scripts/render-geumcheon-pdfs.mjs: render the installation checklist and final report HTML to PDF with Electron.
- Create scripts/e2e-geumcheon-deployment-check.ts: run packaged-device and local-NAS integration checks.
- Create deploy/windows/cleanup-geumcheon-device.ps1 and deploy/windows/반납전_정리.cmd: offline rental-PC cleanup from the protected USB.
- Create deploy/synology/compose.example.yaml, .env.example, event.example.json, tokens.example.json, and README.md: tracked safe deployment templates and manual.
- Create docs/operations/geumcheon-2026-install-checklist.html: printable pre-run and cleanup checklist.
- Create docs/operations/geumcheon-2026-operator-manual.md: nontechnical USB, startup, outage, cleanup, and escalation instructions.
- Create scripts/generate-geumcheon-report.mjs and docs/reports/geumcheon-report-template.html: evidence-to-report conversion.
- Create tests/deployment/tokenProvisioning.test.ts, usbDeployment.test.ts, cleanupWorkflow.test.ts, synologyTemplates.test.ts, deploymentVerification.test.ts, and reportGeneration.test.ts.
- Generate ignored test_artifacts/geumcheon-final/ and deployment-output/geumcheon-2026/reports/ during verification.

---

### Task 1: Protect Generated Roots and Provision Device Tokens

**Files:**

- Create: deploy/geumcheon/client-config.example.json
- Create: scripts/provision-device-tokens.mjs
- Create: tests/deployment/tokenProvisioning.test.ts
- Modify: .gitignore
- Modify: package.json
- Modify: package-lock.json

**Interfaces:**

- Consumes the event ID geumcheon-science-festival-2026 and a private client-config.json copied from the tracked example.
- Produces buildProvisioningBundle(options), writeProvisioningBundle(options), and revokeTokenManifest(manifest, deviceIds, revokedAt).
- Produces deployment-private/geumcheon-2026/devices/<deviceId>.bootstrap-credentials.json, nas/tokens.json, recovery-tokens.json, and provisioning-summary.json.
- The NAS service consumes nas/tokens.json; Task 2 consumes the per-device bootstrap files; Task 5 uses recovery-tokens.json only to prove secret scope.

- [ ] **Step 1: Write failing token and ignore-boundary tests**

~~~ts
test("creates ten writers and two separated leaderboard credentials", () => {
  const bundle = buildProvisioningBundle({
    eventId: "geumcheon-science-festival-2026",
    localAdminPin: "0208",
    expiresAt: "2026-09-21T17:00:00+09:00",
    now: "2026-08-25T12:00:00+09:00",
    randomBytes: deterministicRandomBytes
  });

  assert.equal(bundle.serverManifest.tokens.length, 12);
  assert.equal(bundle.deviceBootstraps.PC01.tokens.write.length > 40, true);
  assert.equal(bundle.deviceBootstraps.PC01.tokens.leaderboardRead, undefined);
  assert.equal(bundle.deviceBootstraps.LEADERBOARD01.tokens.write, undefined);
  assert.equal(typeof bundle.deviceBootstraps.LEADERBOARD01.tokens.leaderboardRead, "string");
  assert.equal(typeof bundle.deviceBootstraps.LEADERBOARD01.tokens.operator, "string");
});

test("server manifest contains hashes but no raw token", () => {
  const bundle = makeBundle();
  const serialized = JSON.stringify(bundle.serverManifest);
  for (const token of allRawTokens(bundle)) {
    assert.equal(serialized.includes(token), false);
  }
});
~~~

Also test 32-byte base64url entropy, twelve unique values, lowercase 64-character SHA-256 hashes, exact roles writer/leaderboard/operator, official/practice scope, expiry, null revoked_at, and refusal to overwrite an existing private bundle.

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: npx tsx --test tests/deployment/tokenProvisioning.test.ts

Expected: FAIL because scripts/provision-device-tokens.mjs does not exist.

- [ ] **Step 3: Add generated-root and secret ignores**

Add exact root rules for release-geumcheon/, deployment-private/, and deployment-output/. Add .env and .env.* while explicitly allowing tracked .env.example files. Keep test_artifacts ignored. Do not add a broad JSON ignore that could hide event profiles or safe examples.

- [ ] **Step 4: Define the private client configuration contract**

deploy/geumcheon/client-config.example.json must use a deliberately nonproduction .invalid API URL and explicit rejected sentinel values:

~~~json
{
  "schemaVersion": 1,
  "eventProfileId": "geumcheon-2026",
  "eventId": "geumcheon-science-festival-2026",
  "apiBaseUrl": "https://records.example.invalid",
  "localAdminPin": "approval-not-provided",
  "privacyNoticeVersion": "approval-not-provided",
  "retentionExpiresAt": "approval-not-provided",
  "credentialExpiresAt": "2026-09-21T17:00:00+09:00",
  "sessions": {
    "official": { "sessionId": "gsc26-official-day1-round1", "dayNo": 1, "roundNo": 1 },
    "practice": { "sessionId": "gsc26-practice" }
  },
  "requestTimeoutMs": 10000,
  "retry": { "initialDelayMs": 2000, "maxDelayMs": 60000 }
}
~~~

The production CLI must reject .invalid, approval-not-provided, non-HTTPS URLs, a PIN other than the private configured value, invalid ISO dates, credential expiry not later than generation time, and retention expiry not later than the event.

- [ ] **Step 5: Implement deterministic core generation and cryptographic production generation**

Use crypto.randomBytes(32).toString("base64url") for production tokens and SHA-256 over the exact UTF-8 token. Inject randomBytes and now only through exported functions for tests; do not expose a deterministic CLI flag.

The server manifest entry is:

~~~ts
type ServerTokenEntry = {
  token_hash: string;
  event_id: "geumcheon-science-festival-2026";
  device_id: DeviceId;
  role: "writer" | "leaderboard" | "operator";
  allowed_sessions: Array<"official" | "practice">;
  expires_at: string;
  revoked_at: string | null;
};
~~~

The client bootstrap entry is:

~~~ts
type BootstrapCredentials = {
  schemaVersion: 1;
  eventId: "geumcheon-science-festival-2026";
  deviceId: DeviceId;
  tokens: {
    write?: string;
    leaderboardRead?: string;
    operator?: string;
  };
  localAdminPin: string;
};
~~~

Create ten writer entries PC01-PC10 and two LEADERBOARD01 entries. Write files through a sibling temporary directory, flush, and rename only after every file succeeds. Set mode 0600 where supported. Never print raw tokens or the PIN.

- [ ] **Step 6: Implement private recovery and revocation without secret disclosure**

recovery-tokens.json contains the complete raw-token inventory only under deployment-private. provisioning-summary.json contains generation time, event ID, device/role counts, expiry, and file hashes but no token or PIN. revokeTokenManifest must copy the manifest, set revoked_at only for the requested device IDs, reject unknown IDs, and write the replacement atomically.

- [ ] **Step 7: Add package commands and run focused verification**

Add:

~~~json
{
  "provision:geumcheon": "node scripts/provision-device-tokens.mjs",
  "test:geumcheon:provisioning": "tsx --test tests/deployment/tokenProvisioning.test.ts"
}
~~~

Run: npm run test:geumcheon:provisioning

Expected: PASS for uniqueness, roles, hashes, expiry, safe output, overwrite refusal, and revocation.

Run: git check-ignore release-geumcheon deployment-private deployment-output

Expected: all three roots reported as ignored.

Run: git ls-files release-geumcheon deployment-private deployment-output

Expected: no output.

- [ ] **Step 8: Commit**

~~~text
feat: add secure Geumcheon device provisioning
~~~

---

### Task 2: Generate the Eleven-Folder USB Master and Installation PDF

**Files:**

- Create: scripts/prepare-geumcheon-deployment.mjs
- Create: scripts/render-geumcheon-pdfs.mjs
- Create: docs/operations/geumcheon-2026-install-checklist.html
- Create: tests/deployment/usbDeployment.test.ts
- Modify: package.json

**Interfaces:**

- Consumes release-geumcheon/ from the client-foundation plan, EventProfile/DeviceProfile validation from shared/events, and Task 1 private files.
- Produces buildDeviceProfile(config, deviceId), computeSha256Manifest(root), renderPdf(htmlPath, pdfPath), and prepareGeumcheonDeployment(options).
- Produces deployment-output/geumcheon-2026/usb-master with a generated-output sentinel used for safe replacement.
- Task 3 adds the cleanup tool to this master; Task 5 verifies its structure and secret scope.

- [ ] **Step 1: Write failing USB topology and per-device-scope tests**

~~~ts
test("creates ten players and one leaderboard with role-specific executables", async () => {
  const result = await prepareFixtureDeployment();
  assert.deepEqual(result.deviceIds, [
    "PC01", "PC02", "PC03", "PC04", "PC05",
    "PC06", "PC07", "PC08", "PC09", "PC10",
    "LEADERBOARD01"
  ]);
  assert.deepEqual(exeNames(result.root, "PC01"), [
    "G-Science AI 타자왕.exe",
    "G-Science AI 타자왕_연습모드.exe"
  ]);
  assert.deepEqual(exeNames(result.root, "LEADERBOARD01"), [
    "G-Science AI 타자왕_리더보드.exe",
    "G-Science AI 타자왕_연습모드_리더보드.exe"
  ]);
});

test("copies only the intended device secret", async () => {
  const result = await prepareFixtureDeployment();
  const pc01 = readBootstrap(result.root, "PC01");
  assert.equal(pc01.deviceId, "PC01");
  assert.equal(JSON.stringify(pc01).includes(rawTokenFor("PC02")), false);
  assert.equal(existsBelow(result.root, "nas/tokens.json"), false);
  assert.equal(existsBelow(result.root, "recovery-tokens.json"), false);
});
~~~

Also test PC10, LEADERBOARD01, profile role, exact sessions, checksum ordering, source immutability, nonempty-output refusal, unsafe --replace refusal, privacy/retention gate, and 14 GiB capacity gate.

- [ ] **Step 2: Run the focused test and verify the missing-generator failure**

Run: npx tsx --test tests/deployment/usbDeployment.test.ts

Expected: FAIL because scripts/prepare-geumcheon-deployment.mjs does not exist.

- [ ] **Step 3: Implement strict input validation**

Require all four exact Geumcheon executable names and the common Electron runtime. Reject unexpected records.csv, admin_audit.csv, local_queue, outbox, recovery, conflicts, logs, .env, bootstrap credentials, actual device profiles, or private settings in release-geumcheon.

Validate the private client config and every Task 1 bootstrap. Require matching event ID/device ID, ten distinct writer tokens, separated leaderboard/operator tokens, valid HTTPS API URL, approved privacy version, and retention date.

- [ ] **Step 4: Implement nonsecret device-profile generation**

Generate executable-adjacent device-profile.json:

~~~ts
type DeviceProfile = {
  schemaVersion: 1;
  eventProfileId: "geumcheon-2026";
  eventId: "geumcheon-science-festival-2026";
  deviceId: DeviceId;
  role: "player" | "leaderboard";
  apiBaseUrl: string;
  sessions: {
    official: { sessionId: string; dayNo: number; roundNo: number };
    practice: { sessionId: string };
  };
  requestTimeoutMs: number;
  retry: { initialDelayMs: number; maxDelayMs: number };
};
~~~

Do not put tokens, token hashes, local PIN, NAS filesystem paths, or participant data in this file.

- [ ] **Step 5: Implement allowlisted runtime copying and safe replacement**

Build each device in a temporary sibling of usb-master. Copy the common runtime, remove non-role executable names, then add only that device's profile and bootstrap. Do not recursively copy deployment-private.

Refuse an existing output unless --replace is supplied. With --replace, resolve the absolute target, require it to be exactly below deployment-output/geumcheon-2026, require the generated sentinel to contain eventProfileId geumcheon-2026, and replace by staging a complete new tree before removing the old generated tree. Never accept a drive root, workspace root, home directory, unresolved variable, wildcard, or reparse point as a replacement target.

- [ ] **Step 6: Create the printable installation checklist**

The HTML must be self-contained and contain checkboxes for:

- USB SHA-256 verification before copying.
- PC01-PC10 and LEADERBOARD01 assignment.
- Copy to Desktop instead of executing from USB.
- Captive-portal login.
- Device ID and role confirmation.
- HTTPS health check.
- Official and practice synthetic test records.
- Leaderboard visibility.
- Pending count zero.
- Time/date/timezone check.
- Cleanup receipt at return.

render-geumcheon-pdfs.mjs must launch Electron headlessly, load the local HTML with network disabled, print A4 with backgrounds, close the app on success/failure, and write 설치확인표.pdf. The test gate requires a %PDF header and a file larger than 10 KiB; visual review remains a separate evidence item.

- [ ] **Step 7: Generate sorted checksums and enforce USB capacity**

Hash every regular file below usb-master except SHA256SUMS.txt, use normalized forward-slash relative paths, sort by ordinal path, and write lowercase SHA-256 followed by two spaces and the path. Reject symlinks/junctions and total bytes above 14 GiB.

The final topology is:

~~~text
usb-master/
  PC01/
  PC02/
  PC03/
  PC04/
  PC05/
  PC06/
  PC07/
  PC08/
  PC09/
  PC10/
  LEADERBOARD01/
  운영도구/
  설치확인표.pdf
  SHA256SUMS.txt
~~~

- [ ] **Step 8: Run focused tests and a fixture PDF build**

Add:

~~~json
{
  "prepare:geumcheon-deployment": "node scripts/prepare-geumcheon-deployment.mjs",
  "render:geumcheon-pdfs": "electron scripts/render-geumcheon-pdfs.mjs",
  "test:geumcheon:deployment": "tsx --test tests/deployment/usbDeployment.test.ts"
}
~~~

Run: npm run test:geumcheon:deployment

Expected: PASS for eleven folders, exact executables, isolated credentials, source immutability, safe replacement, production gates, checksum determinism, PDF signature, and capacity limit.

- [ ] **Step 9: Commit**

~~~text
feat: generate isolated Geumcheon USB deployment
~~~

---

### Task 3: Add the Offline Rental-PC Cleanup Workflow

**Files:**

- Create: deploy/windows/cleanup-geumcheon-device.ps1
- Create: deploy/windows/반납전_정리.cmd
- Create: tests/deployment/cleanupWorkflow.test.ts
- Modify: scripts/prepare-geumcheon-deployment.mjs
- Modify: docs/operations/geumcheon-2026-install-checklist.html
- Modify: package.json

**Interfaces:**

- Consumes the runtime path and device-profile.json contract from the client-foundation plan.
- Produces Resolve-ValidatedTarget, Get-PendingQueueCount, Write-CleanupReceipt, and Invoke-GeumcheonCleanup inside the PowerShell script.
- The launcher passes DeviceId, InstallRoot, and ReceiptRoot; it performs no deletion itself.
- Produces a non-PII receipt under the protected USB 운영도구/정리영수증 directory.

- [ ] **Step 1: Write failing cleanup-boundary tests**

~~~ts
test("refuses cleanup while an official outbox file remains", async () => {
  const fixture = await createCleanupFixture("PC01");
  writeEncryptedFixture(path.join(fixture.runtimeRoot, "outbox", "official", "pending.enc"));
  const result = await runCleanup(fixture);
  assert.equal(result.exitCode, 2);
  assert.equal(fs.existsSync(fixture.runtimeRoot), true);
  assert.equal(fs.existsSync(fixture.installRoot), true);
  assert.equal(readLatestReceipt(fixture).status, "FAILED_PENDING_RECORDS");
});

test("deletes only the selected Geumcheon device", async () => {
  const fixture = await createCleanupFixture("PC01");
  const sibling = await createCleanupFixture("PC02", fixture.localAppData);
  const skillup = createSkillupSibling(fixture.localAppData);
  const result = await runCleanup(fixture);
  assert.equal(result.exitCode, 0);
  assert.equal(fs.existsSync(fixture.runtimeRoot), false);
  assert.equal(fs.existsSync(fixture.installRoot), false);
  assert.equal(fs.existsSync(sibling.runtimeRoot), true);
  assert.equal(fs.existsSync(skillup), true);
});
~~~

Also test practice outbox, recovery, conflicts, mismatched event/device profile, missing profile, running executable, reparse point, broad parent path, locked-file failure, missing receipt root, and no PII/token in receipts.

- [ ] **Step 2: Run the focused tests and verify the missing-script failure**

Run: npx tsx --test tests/deployment/cleanupWorkflow.test.ts

Expected: FAIL because deploy/windows/cleanup-geumcheon-device.ps1 does not exist.

- [ ] **Step 3: Implement exact path and identity validation**

The PowerShell script must be compatible with Windows PowerShell 5.1. Resolve absolute paths with LiteralPath. Read InstallRoot/device-profile.json and require schemaVersion 1, eventProfileId geumcheon-2026, eventId geumcheon-science-festival-2026, and exact DeviceId.

Derive runtimeRoot only as:

~~~powershell
$runtimeRoot = Join-Path $env:LOCALAPPDATA (
  "ThePMD\TypingKing2026\geumcheon-2026\" + $DeviceId
)
~~~

Require InstallRoot to resolve below the current user's Desktop and end in the same DeviceId. Reject roots, user profile, Desktop itself, workspace root, missing targets, wildcards, unresolved variables, and reparse points.

- [ ] **Step 4: Implement readiness and running-process checks**

Count every file below outbox/official, outbox/practice, recovery, and conflicts. Do not rely on extensions. Refuse if the count is nonzero.

Use Get-CimInstance Win32_Process to reject any running process whose ExecutablePath is below InstallRoot. If process inspection is denied, refuse rather than assume the app is closed.

- [ ] **Step 5: Implement cleanup and receipts**

Write an initial receipt state before mutation. Remove only the validated runtimeRoot and InstallRoot with PowerShell Remove-Item -LiteralPath. After each removal, recheck absence. On any exception, write FAILED_DELETE with the device ID, timestamp, pre-clean file counts, and only the error category; do not include paths containing usernames, file contents, token values, phone numbers, names, or birthdates.

On success write:

~~~json
{
  "schemaVersion": 1,
  "eventId": "geumcheon-science-festival-2026",
  "deviceId": "PC01",
  "completedAt": "2026-09-19T18:00:00+09:00",
  "status": "SUCCESS",
  "pendingBefore": 0,
  "runtimeRemoved": true,
  "installRemoved": true
}
~~~

- [ ] **Step 6: Implement the USB launcher**

반납전_정리.cmd may prompt for PC01-PC10 or LEADERBOARD01 and launch PowerShell with -NoProfile -NonInteractive -ExecutionPolicy Bypass. It must not enumerate, build, delete, or move filesystem paths in cmd. The PowerShell script alone derives and validates all deletion targets. The launcher must keep the console open and display the receipt filename and success/failure in Korean.

- [ ] **Step 7: Package the tool and update the checklist**

Copy the two tracked files to usb-master/운영도구 and create an empty 정리영수증 directory. Add checklist steps: verify pending count zero in both official/practice apps, close all four apps, connect protected USB, run cleanup, retain receipt, then revoke all event tokens after all devices are returned.

- [ ] **Step 8: Run focused cleanup tests**

Add:

~~~json
{
  "test:geumcheon:cleanup": "tsx --test tests/deployment/cleanupWorkflow.test.ts"
}
~~~

Run: npm run test:geumcheon:cleanup

Expected: PASS for pending-data refusal, narrow deletion, sibling preservation, running-app refusal, failure receipt, and success receipt.

- [ ] **Step 9: Commit**

~~~text
feat: add verified Geumcheon rental PC cleanup
~~~

---

### Task 4: Add Hardened Synology Templates and a Nontechnical Deployment Manual

**Files:**

- Create: deploy/synology/compose.example.yaml
- Create: deploy/synology/.env.example
- Create: deploy/synology/event.example.json
- Create: deploy/synology/tokens.example.json
- Create: deploy/synology/README.md
- Create: tests/deployment/synologyTemplates.test.ts
- Modify: package.json
- Modify: package-lock.json

**Interfaces:**

- Consumes the sibling NAS API service at services/nas-record-api, its /health endpoint, and Task 1 server token manifest schema.
- Produces a Compose service named typingking-record-api with read-only config under /run/config and writable records under /data.
- The operator copies examples into deployment-private/geumcheon-2026/nas and replaces only values documented in README.md.
- The DSM reverse proxy targets 127.0.0.1:18080 and is the sole bridge to public HTTPS 443.

- [ ] **Step 1: Write failing parsed-template security tests**

~~~ts
test("binds the API only to host loopback and drops privileges", () => {
  const compose = readComposeExample();
  const api = compose.services["typingking-record-api"];
  assert.deepEqual(api.ports, ["127.0.0.1:18080:8080"]);
  assert.equal(api.read_only, true);
  assert.deepEqual(api.cap_drop, ["ALL"]);
  assert.ok(api.security_opt.includes("no-new-privileges:true"));
  assert.equal(api.restart, "unless-stopped");
});

test("mounts secrets read-only and data separately", () => {
  const api = readComposeExample().services["typingking-record-api"];
  assert.ok(api.volumes.some((value: string) => value.endsWith("/run/config/event.json:ro")));
  assert.ok(api.volumes.some((value: string) => value.endsWith("/run/config/tokens.json:ro")));
  assert.ok(api.volumes.some((value: string) => value.endsWith("/data:rw")));
});
~~~

Also reject privileged mode, host networking, Docker socket mounts, 0.0.0.0, external 8080/18080, mutable config mounts, missing healthcheck, missing tmpfs, and raw token-shaped values in tracked examples.

- [ ] **Step 2: Run the focused test and verify missing-template failure**

Run: npx tsx --test tests/deployment/synologyTemplates.test.ts

Expected: FAIL because deploy/synology/compose.example.yaml does not exist.

- [ ] **Step 3: Add explicit YAML parsing for tests**

Add yaml as a direct development dependency and update package-lock.json. Do not rely on a transitive electron-builder dependency. Parsing validates document structure; Docker Compose validation remains a separate runtime gate.

- [ ] **Step 4: Create the hardened Compose example**

The service must:

- Build or use the Node.js 24 LTS NAS API image.
- Run as the explicit service UID:GID supplied through the private environment file.
- Bind 127.0.0.1:18080 to container port 8080.
- Mount event.json and tokens.json read-only at /run/config.
- Mount the approved NAS data root at /data read-write.
- Use read_only: true, cap_drop: ALL, no-new-privileges:true, a noexec/nosuid /tmp tmpfs, init:true, unless-stopped, and an internal /health healthcheck.
- Set a finite stop_grace_period and log rotation without logging request bodies.
- Avoid privileged, host network, Docker socket, device mounts, DSM credentials, and public ports.

- [ ] **Step 5: Create safe examples**

event.example.json uses the real event ID and server policy shape but no domain, volume path, personal data, or approved retention value. tokens.example.json contains syntactically valid SHA-256 example hashes that do not correspond to any generated raw token. .env.example uses clearly nonfunctional example NAS paths and numeric service IDs.

The API and production preparation commands must reject these example values; they exist only to show field names.

- [ ] **Step 6: Write the Synology deployment manual**

README.md must use numbered Korean steps and cover:

1. Record NAS model, DSM version, CPU architecture, Container Manager support, public-IP/CGNAT status, domain/DDNS, certificate, volume, UID/GID, firewall, and current 443 use.
2. Create separate config and data directories and grant only the API service account.
3. Copy actual files from deployment-private; never copy raw-token recovery files to NAS.
4. Validate Compose configuration, build the native-architecture image, start it, and confirm healthy status.
5. Configure DSM Reverse Proxy from public HTTPS 443 to 127.0.0.1:18080 with the public certificate and TLS 1.2 or later.
6. Forward only router TCP 443 and confirm 139, 445, 5000, 5001, and 18080 are not reachable externally.
7. Test /health and one synthetic POST from a mobile tethered external network without printing the bearer token.
8. Restart the NAS and confirm the container returns automatically.
9. Back up the encrypted data share and record retention/destruction ownership.
10. Revoke device tokens after the event, replace tokens.json atomically, restart the API, and verify the old token returns 401.

Every step must state the evidence filename or screenshot to retain under the ignored deployment-private evidence folder.

- [ ] **Step 7: Run template tests and optional Compose validation**

Add:

~~~json
{
  "test:geumcheon:synology": "tsx --test tests/deployment/synologyTemplates.test.ts"
}
~~~

Run: npm run test:geumcheon:synology

Expected: PASS for parsed structure, loopback binding, least privilege, read-only secrets, and safe examples.

When Docker is available, run: docker compose --env-file deployment-private/geumcheon-2026/nas/.env -f deployment-private/geumcheon-2026/nas/compose.yaml config

Expected: exit 0 with no raw token printed. If Docker is absent, record 미실행 in Task 7 rather than marking this runtime check passed.

- [ ] **Step 8: Commit**

~~~text
docs: add hardened Synology deployment bundle
~~~

---

### Task 5: Verify Structure, Checksums, PII, Secrets, and Git Boundaries

**Files:**

- Create: scripts/verify-geumcheon-deployment.mjs
- Create: tests/deployment/deploymentVerification.test.ts
- Modify: scripts/scan-pii.mjs
- Modify: scripts/prepare-geumcheon-deployment.mjs
- Modify: package.json

**Interfaces:**

- Consumes Task 1 recovery inventory, Task 2 SHA256SUMS.txt/device trees, Task 3 operation tools, and Git's tracked-file list.
- Produces verifyGeumcheonDeployment(options) and ignored test_artifacts/geumcheon-final/deployment-verification.json.
- Task 6 appends packaged runtime evidence; Task 7 consumes the JSON without reading private credentials.

- [ ] **Step 1: Write failing security-scope tests**

~~~ts
test("raw tokens occur only in intended device bootstrap copies and private recovery", async () => {
  const result = await verifyFixtureDeployment();
  assert.equal(result.secretScope.unexpectedOccurrences, 0);
  assert.equal(result.secretScope.pc01WriteTokenOccurrences, 3);
  assert.deepEqual(result.secretScope.pc01WriteTokenLocations.sort(), [
    "deployment-private/devices/PC01.bootstrap-credentials.json",
    "deployment-private/recovery-tokens.json",
    "deployment-output/geumcheon-2026/usb-master/PC01/bootstrap-credentials.json"
  ]);
});

test("fails on participant data copied into a player folder", async () => {
  const fixture = await makeVerifiedFixture();
  writeJson(path.join(fixture.usbRoot, "PC04", "data", "record.json"), {
    participant_name: "실제참가자",
    phone_full: "010-1234-5678"
  });
  await assert.rejects(() => verifyGeumcheonDeployment(fixture.options), /PII/);
});
~~~

Also test wrong executable, missing PDF, extra folder, checksum mismatch, NAS manifest on USB, raw token in release/Git, actual NAS domain in tracked files, .env/log/queue/receipt leakage, phone and birthdate patterns, and redacted failure output.

- [ ] **Step 2: Run the focused test and verify missing-verifier failure**

Run: npx tsx --test tests/deployment/deploymentVerification.test.ts

Expected: FAIL because scripts/verify-geumcheon-deployment.mjs does not exist.

- [ ] **Step 3: Extend PII scanning without disclosing findings**

Keep current SkillUp defaults. Add repeated --target arguments so Geumcheon verification scans release-geumcheon and usb-master. Scan text and binary chunks for exact values supplied through TYPINGKING_PII_NEEDLES, phone patterns, birthdate patterns, private-key markers, GitHub/AWS-style tokens, and nonexample bearer values.

Do not print the matching value. Report only category, relative file, and count. The synthetic phone 010-0000-0000 is the sole allowed test phone. Do not allow a real phone merely because it appears in documentation.

- [ ] **Step 4: Implement exact topology and artifact validation**

Require the eleven device folders, 운영도구, 설치확인표.pdf, and SHA256SUMS.txt. Reject any additional top-level item except the generated sentinel. Validate exact executables per role, parse every profile/bootstrap with unknown-key rejection, recompute all hashes, ensure no symlink/junction, and compare total size with 14 GiB.

- [ ] **Step 5: Implement credential-scope verification**

Read raw tokens only from deployment-private. For each raw value, stream-scan:

- Git-tracked files: zero occurrences.
- release-geumcheon: zero occurrences.
- NAS hashed manifest: zero occurrences.
- USB: exactly one occurrence in the matching device bootstrap.
- recovery-tokens.json: exactly one occurrence.

Apply the same scope rule to localAdminPin: zero in tracked/release/NAS files, allowed only in the private client config, each private per-device bootstrap source, and each device's intended USB bootstrap. Never include the value in results.

- [ ] **Step 6: Verify Git boundaries and production approvals**

Run git ls-files for release-geumcheon, deployment-private, and deployment-output and fail if any path is returned. Fail if client config contains .invalid, approval-not-provided, an unapproved privacy version, expired credentials, or a retention date not later than the event.

- [ ] **Step 7: Write a redacted machine-readable result**

deployment-verification.json includes generatedAt, commit SHA, branch, source dirty-state summary, release/USB byte counts, folder/executable counts, checksum count, tests, and PASS/FAIL per gate. It contains no usernames, absolute paths, domain, volume path, IP, tokens, token hashes, PIN, names, phones, birthdates, record bodies, or queue contents.

- [ ] **Step 8: Run security verification**

Add:

~~~json
{
  "verify:geumcheon-deployment": "node scripts/verify-geumcheon-deployment.mjs",
  "test:geumcheon:security": "tsx --test tests/deployment/deploymentVerification.test.ts",
  "scan:geumcheon": "node scripts/scan-pii.mjs --target release-geumcheon --target deployment-output/geumcheon-2026/usb-master"
}
~~~

Run: npm run test:geumcheon:security

Expected: PASS for clean fixture and intentional FAIL cases for PII, secret leakage, topology, Git, and checksum corruption.

Run: npm run verify:geumcheon-deployment

Expected: PASS only after a production-configured USB master exists.

Run: npm run scan:geumcheon

Expected: no PII or unexpected secret findings.

- [ ] **Step 9: Commit**

~~~text
test: enforce Geumcheon deployment privacy gates
~~~

---

### Task 6: Run Packaged Device, Offline Recovery, and Ten-PC Integration E2E

**Files:**

- Create: scripts/e2e-geumcheon-deployment-check.ts
- Modify: package.json

**Interfaces:**

- Consumes the packaged USB master, client safeStorage/outbox/leaderboard interfaces, and the NAS service test server.
- Uses isolated LOCALAPPDATA and APPDATA roots under ignored test_artifacts.
- Produces test_artifacts/geumcheon-final/e2e-summary.json, redacted request evidence, and screenshot sets.
- Task 7 merges its evidence with Task 5 results.

- [ ] **Step 1: Add an E2E preflight that fails before launching**

Check all four packaged executables, PC01/PC10/LEADERBOARD01 folders, exact profiles, bootstrap files, local NAS test-server command, and writable ignored artifact root. Snapshot every source USB file hash before execution.

Run: npx tsx scripts/e2e-geumcheon-deployment-check.ts

Expected: FAIL before implementation with an explicit missing-script or missing-artifact error and no partial PASS report.

- [ ] **Step 2: Implement isolated copied-PC fixtures**

Copy PC01, PC10, and LEADERBOARD01 from usb-master into separate test-artifact Desktop folders. Never launch the USB master directly. Set unique LOCALAPPDATA/APPDATA for each and use the local test server's HTTPS development certificate through the test-only trusted path defined by the NAS/client plans.

Use only synthetic participant data:

~~~ts
const syntheticParticipant = {
  participant_name: "테스트참가자",
  phone_part1: "010",
  phone_part2: "0000",
  phone_part3: "0000",
  birth_year: "2000",
  birth_month: "1",
  birth_day: "1"
};
~~~

- [ ] **Step 3: Verify first-run secret ingestion and isolation**

Launch each copied executable and wait for bootstrap readiness. Assert:

- credentials/credentials.safe exists under the exact device runtime.
- copied bootstrap-credentials.json is gone only after safeStorage read-back succeeds.
- USB-master bootstrap still exists and retains its original hash.
- renderer bootstrap and page text contain no raw token, PIN, phone, or birthdate.
- PC01, PC10, and LEADERBOARD01 runtime roots never overlap.

- [ ] **Step 4: Verify offline-first storage and recovery**

Stop the test API, complete one synthetic official record and one practice record, and assert encrypted files exist in their separate outboxes. Stream-scan the encrypted files and operation log to prove synthetic name, phone, birthdate, and raw tokens are absent.

Restart the API. Wait for background retry, assert server-confirmed ID/hash, assert both outboxes reach zero only after confirmation, and assert exactly one official and one practice JSON exists server-side. Repeat the same record ID and require HTTP 200 duplicate with one file. Repeat with changed content and require 409 while preserving the original.

- [ ] **Step 5: Verify leaderboard outage behavior**

Load official and practice leaderboards, retain their ETag-backed snapshots, stop the API, and assert the last valid rankings remain visible with disconnected state and last-success time. Restart the API, add a record, and assert both the snapshot and UI catch up without exposing full phone or birthdate.

- [ ] **Step 6: Verify ten-device concurrency without ten full Electron processes**

Use the real client HTTP/outbox adapter with ten isolated PC01-PC10 contexts and distinct writer credentials. Submit one record per PC concurrently, then retry all ten. Require ten unique server files, ten 201 responses on first submission, ten 200 duplicates on replay, no 409, no lost record, and correct authenticated device IDs.

Keep the packaged-process gate at PC01, PC10, and LEADERBOARD01; the ten-client adapter gate validates concurrency without exhausting the workstation with ten Electron runtimes.

- [ ] **Step 7: Capture package and display evidence**

For the four application variants, capture 1366×768 and 1920×1080 at Windows scale factors 100%, 125%, and 150%. Record title/key-visual natural dimensions, overflow, scroll reachability, input focus, Korean IME entry, leaderboard scrolling, offline banner, pending count, and last-refresh display.

Automated checks may prove dimensions and DOM visibility. Mark visual quality as 부분 확인 until a human reviews the screenshot contact sheet; do not call screenshot creation itself a visual PASS.

- [ ] **Step 8: Preserve source hashes and write the redacted summary**

Recompute every USB-master hash and require no change. e2e-summary.json contains counts, HTTP status distribution, queue transitions, server file counts, variant/resolution/scale matrix, and artifact-relative evidence paths. It excludes actual domain, absolute user paths, raw requests, PII, tokens, hashes used for authentication, and PIN.

- [ ] **Step 9: Add and run the E2E command**

Add:

~~~json
{
  "test:e2e:geumcheon-deployment": "tsx scripts/e2e-geumcheon-deployment-check.ts"
}
~~~

Run: npm run test:e2e:geumcheon-deployment

Expected: PASS for packaged PC01/PC10/LEADERBOARD01 isolation, first-run secret handling, offline recovery, leaderboard cache, ten-client idempotency, and USB source immutability. Visual quality remains 부분 확인 until reviewed.

- [ ] **Step 10: Commit**

~~~text
test: verify packaged Geumcheon deployment flow
~~~

---

### Task 7: Generate the Nontechnical Development-Verification Report and Final Gate

**Files:**

- Create: scripts/generate-geumcheon-report.mjs
- Create: docs/reports/geumcheon-report-template.html
- Create: tests/deployment/reportGeneration.test.ts
- Create: docs/operations/geumcheon-2026-operator-manual.md
- Generate: docs/reports/2026-08-25-geumcheon-typingking-development-verification-report.md
- Generate ignored: deployment-output/geumcheon-2026/reports/제8회_금천과학축제_G-Science_AI_타자왕_개발검증보고서.pdf
- Modify: scripts/render-geumcheon-pdfs.mjs
- Modify: package.json

**Interfaces:**

- Consumes Task 5 deployment-verification.json, Task 6 e2e-summary.json, client/NAS unit-test summaries, audit output, package inventory, screenshot review result, and optional private live-NAS/venue evidence.
- Produces normalizeEvidence(input), deriveStatus(check), buildReport(input), renderMarkdown(report), and renderHtml(report).
- The generated Markdown is the reviewable source; the PDF is the nontechnical submission artifact.

- [ ] **Step 1: Write failing evidence and claim-boundary tests**

~~~ts
test("does not claim NAS deployment from local tests", () => {
  const report = buildReport(localOnlyEvidence());
  assert.equal(report.sections.nasLive.status, "미실행");
  assert.equal(report.overallLabel.includes("NAS 배포 완료"), false);
  assert.equal(report.overallLabel.includes("현장 운영 준비 완료"), false);
});

test("a PASS row requires command, exit code, timestamp, and evidence path", () => {
  assert.throws(
    () => normalizeEvidence({ status: "통과", command: "npm test" }),
    /evidence/
  );
});

test("redacts private infrastructure and participant data", () => {
  const rendered = renderMarkdown(reportWithSensitiveFixture());
  assert.equal(rendered.includes("010-1234-5678"), false);
  assert.equal(rendered.includes("https://actual-nas.example"), false);
  assert.equal(rendered.includes("Bearer "), false);
});
~~~

Also test four allowed status labels, failed-command precedence, partial visual status, unrun field checks, package hash inventory, unsigned-executable disclosure, open approval items, and no absolute username path.

- [ ] **Step 2: Run the focused test and verify missing-generator failure**

Run: npx tsx --test tests/deployment/reportGeneration.test.ts

Expected: FAIL because scripts/generate-geumcheon-report.mjs does not exist.

- [ ] **Step 3: Define the evidence contract**

Each verification row must contain:

~~~ts
type VerificationEvidence = {
  id: string;
  category: "source" | "unit" | "package" | "security" | "nas-live" | "venue";
  status: "통과" | "부분 확인" | "미실행" | "실패";
  checkedAt: string | null;
  command: string | null;
  exitCode: number | null;
  expected: string;
  actual: string;
  evidencePath: string | null;
  limitation: string | null;
};
~~~

통과 requires checkedAt, command or documented manual procedure, successful result, and an existing relative evidence path. 실패 overrides every summary. 부분 확인 must name the missing proof. 미실행 must not contain language implying success.

- [ ] **Step 4: Implement the nontechnical report**

The Korean report must lead with what the user can run and contain:

1. 한눈에 보는 결과.
2. Four executables and PC01-PC10/LEADERBOARD01 folder explanation.
3. NAS upload/offline-retry flow in plain language.
4. Ranking/content/design summary sourced from the client report.
5. 개인정보·토큰·Git exclusion results.
6. Automated logic/build/package/E2E results with evidence.
7. USB size, file count, SHA-256 count, and executable inventory.
8. NAS live, router, external network, reboot, ten-rental-PC, and venue results.
9. Rental-PC cleanup test/receipt results.
10. Unsigned Windows executable/SmartScreen disclosure.
11. Remaining approvals: final privacy notice, retention, NAS environment values, and rehearsal evidence.
12. Exact operator next actions.

Do not include participant rows, raw JSON, full phone, birthdate, token/hash, PIN, NAS domain/IP/path, username path, or private screenshot.

- [ ] **Step 5: Write the operator manual**

docs/operations/geumcheon-2026-operator-manual.md must cover USB verification/copy, captive portal, first launch, official/practice startup, server-status meanings, pending-count handling, outage behavior, 401/403 stop-and-call rule, 429/5xx automatic retry, leaderboard cache, no-USB-direct-run rule, cleanup, receipt collection, token revocation, and escalation contact role without inventing a person's name or schedule.

If pending count cannot reach zero or cleanup fails, the manual must say not to return or reassign the rental PC. Isolate it, preserve the failure receipt, restore NAS/network service, retransmit from the same DPAPI-bound PC, then retry cleanup. If physical return is unavoidable, revoke that device token immediately and escalate the encrypted queue without claiming it is recoverable on another PC.

- [ ] **Step 6: Render Markdown, HTML, and PDF**

generate-geumcheon-report.mjs reads only sanitized evidence JSON and writes the tracked Markdown plus ignored report HTML. render-geumcheon-pdfs.mjs prints the HTML to the exact Korean PDF filename under deployment-output/geumcheon-2026/reports. Require %PDF signature, size over 20 KiB, page count greater than zero, no remote URL loads, and no private token/PII bytes.

- [ ] **Step 7: Add report commands**

Add:

~~~json
{
  "test:geumcheon:report": "tsx --test tests/deployment/reportGeneration.test.ts",
  "report:geumcheon": "node scripts/generate-geumcheon-report.mjs",
  "verify:geumcheon:local": "npm run test:logic && npm run test:geumcheon:client && npm run test:nas-client && npm run test:nas-api && npm run test:geumcheon:provisioning && npm run test:geumcheon:deployment && npm run test:geumcheon:cleanup && npm run test:geumcheon:synology && npm run test:geumcheon:security && npm run build && npm run build:nas-api && npm run test:e2e:geumcheon-deployment"
}
~~~

- [ ] **Step 8: Run the full local/package gate**

Run in this order:

~~~text
npm ci
npm run test:logic
npm run test:geumcheon:client
npm run test:nas-client
npm run test:nas-api
npm run test:geumcheon:provisioning
npm run test:geumcheon:deployment
npm run test:geumcheon:cleanup
npm run test:geumcheon:synology
npm run test:geumcheon:security
npm run test:geumcheon:report
npm run build
npm run build:nas-api
npm run dist:geumcheon
npm run prepare:geumcheon-deployment
npm run verify:geumcheon-deployment
npm run scan:geumcheon
npm run test:e2e:geumcheon-deployment
npm audit --audit-level=high
npm --prefix services/nas-record-api audit --audit-level=high
git ls-files release-geumcheon deployment-private deployment-output
~~~

Expected: every applicable local/package command exits 0, both audits have zero high/critical findings, and the final Git command prints nothing. A missing private production config prevents final USB generation and is reported as 미실행/blocked input, not bypassed with example values.

- [ ] **Step 9: Run evidence-backed live gates when the environment exists**

Follow deploy/synology/README.md and retain sanitized evidence for Compose validation, container health, DSM reverse proxy, public certificate, external HTTPS, closed ports, NAS reboot recovery, one synthetic record, ten rental PCs, leaderboard PC, Wi-Fi captive portal, 1366×768/1920×1080 displays, 100/125/150% scaling, and cleanup receipts.

If any item is not executed, leave it 미실행. If it is partly observed without required evidence, use 부분 확인. Never modify the report JSON manually to force 통과.

- [ ] **Step 10: Generate and inspect the final artifacts**

Run: npm run report:geumcheon

Run: npm run render:geumcheon-pdfs

Expected:

~~~text
docs/reports/2026-08-25-geumcheon-typingking-development-verification-report.md
deployment-output/geumcheon-2026/reports/제8회_금천과학축제_G-Science_AI_타자왕_개발검증보고서.pdf
deployment-output/geumcheon-2026/usb-master/설치확인표.pdf
test_artifacts/geumcheon-final/verification-summary.json
~~~

Inspect both PDFs visually for Korean font rendering, clipping, page breaks, table width, status colors, and checkbox visibility. Record the review result as its own evidence item.

- [ ] **Step 11: Inspect Git scope and commit the report**

Run: git status --short

Expected: only intended source, tests, examples, manuals, and the sanitized Markdown report are candidates for commit. Generated releases, private settings, evidence, PDFs, USB folders, records, queues, logs, and receipts remain ignored.

Run: git diff --check

Expected: no whitespace errors.

Commit:

~~~text
docs: submit Geumcheon development verification report
~~~

Do not push.

---

## Execution Handoff

Plan complete in docs/superpowers/plans/2026-08-25-geumcheon-deployment-report.md.

Recommended execution is superpowers:subagent-driven-development with one fresh worker per task and two-stage review. The executor must also read the client-foundation and NAS-sync plans before Tasks 2, 4, 5, and 6 so shared interfaces remain identical. If execution stays in one session, use superpowers:executing-plans and stop at each task's test and commit boundary.
