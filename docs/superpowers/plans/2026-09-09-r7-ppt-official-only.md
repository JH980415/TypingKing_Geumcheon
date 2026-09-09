# R7 PPT and official-only execution plan

## Authority and global constraints

Canonical spec: preserved `TypingKing_R7_Work_Package_20260909/01_INSTRUCTIONS/TypingKing_R7_Instructions_20260909.md`, its user clarifications and original PPT notes. Baseline `260103b367a39ff0cd30f8a4cd4a6c73f265d348`. Current branch `codex/geumcheon-2026-r7-ppt-official-only`. Do not merge main or push origin.

- Preserve approved ranking, stage texts 2/2/1, integer AI CPM ranges 100-125/125-150/150-200 and one draw per stage, countdown/retry/interruption persistence, privacy/consent/masking, auth/TLS/ACL, reset raw-data preservation, review/production isolation, other events and past practice data.
- UI-07 removes separate Stage labels in all three win AND loss popups; keep badge art, accessible stage descriptions, internal data and leaderboard termination values.
- UI-10/11/12 full layout redesign applies only to final participant victory.
- Official review game+leaderboard 2 EXEs, NAS game+leaderboard 2 EXEs, five official-only device profiles. No practice EXEs in delivery, no fabricated practice sessions required. Shared practice code and explicit configured practice functionality survive.
- Only Stage1 black background may be edited, to a separate RGBA derivative; original four images remain byte-identical.
- NAS environment is unresolved: use synthetic loopback HTTPS only for tests. No actual NAS/configuration/credentials/provisioning. Container Manager deployment is a separate unresolved follow-up. PRODUCTION_RELEASE=HOLD.
- Real EXE screenshots and actual saved/query results must support claims. Automated input is not human IME; same-host testing is not offline VM or physical 5-PC proof. Preserve failed runs. Original PPT potentially contains participant data and must not enter public Git or executable ZIPs.

## Tasks

### Task 1: Baseline and evidence harness
Owner: isolated runtime worker; files `scripts/r7-*` runtime harness only (coordinate names with root). Use immutable R6 executable as before baseline, capture 1280x720 and 1920x1080 main, gameplay, three win/loss popups, final victory and leaderboard. Record window and viewport geometry; measure existing main left-group gaps before modification. Evidence lives `Codex/Evidence/R7/before`. Only one GUI driver at a time. If broader capture is slow, prioritize main geometry and all distinct screens, state gaps accurately.

### Task 2: Official-only event and NAS schema
Owner: official worker; `shared/events/{types,eventProfile}.ts`, `shared/nas/protocol.ts`, `electron/nas/runtime.ts`, `events/geumcheon-2026/event.config.json` variants only, `services/nas-record-api/src/{config,app,recordSchema}.ts`, five deployment profiles and server config/token templates; relevant existing/new tests. RED tests for official-only acceptance and missing practice rejection, malformed/unknown keys and other-event preservation; then minimal implementation. Do not touch scripts/package.json/builders/UI. Existing mandatory production settings/security remain mandatory. Runtime mappings consume optional practice safely.

### Task 3: Game UI
Owner: game worker; `apps/typing-game/src/{TypingGameApp,AIChallengeGame}.tsx`, new narrowly scoped `apps/typing-game/src/r7-geumcheon.css` imported by owned game component, relevant UI tests. Implement UI-01/02/03/04/05/07/08/09/10/11/12, scoped to Geumcheon. Do not edit shared styles.css, assets/config, leaderboard. Measure before layout from Task1 before settling UI02. Add RED behavioral tests, then implement and verify exact text layout and per-stage actual values. Root coordinates image active mapping.

### Task 4: Leaderboard UI
Owner: leaderboard worker; `apps/leaderboard/src/LeaderboardApp.tsx`, new scoped `apps/leaderboard/src/r7-geumcheon.css` imported there, relevant tests and only required local display preference module if existing config rules cannot support it. UI-13/14/15/16: current participation count, admin day/round default false with restart persistence, one approved upper-left logo preserving aspect, row toggle and outside click clear without destroying admin edits or focus. RED behavior tests then minimal implementation. No shared styles.css or game files.

### Task 5: Asset and packaging
Owner: root (image), packaging worker after Task2 interfaces settle; R7-specific generator/check/ZIP scripts, package.json aggregate official builds, builder metadata, tests. Preserve original Stage1, built-in image editing to create alpha derivative, inspect foreground and halos on light/dark/modal. No other asset edits. Official-only runtime distribution allowlists prevent stale practice EXEs. Separate four exact named ZIPs plus optional full screenshots; no secrets or actual participant data.

### Task 6: Integrated proof and delivery
Owner: root with runtime and independent reviewers. Run focused RED/GREEN checks; full existing logic/client/server tests, type check, builds and packaging checks. Review each task's scoped diff for spec and code quality, then whole branch review. Launch all four final EXEs; two resolutions; all three win/loss popups, full victory, preserved loss/interruption, search/selection/scroll/masking/day-round restart. Review game/LB concurrent storage, synthetic HTTPS NAS/profile auth/TLS fail-closed checks. Fresh no-argument review launch separately from instrumentation. Re-extract final ZIPs, verify CRC/duplicate/path bounds/exact allowlists/hash. Reports 00-09 and final manifest match spec. Serial scoped commits by root to avoid shared index conflicts; push geumcheon R7 branch only, verify remote SHA; copy approved OneDrive backup with hash check, cloud sync unverified unless independently proved.

## Recovery and completion

Preserve R6 and main. No destructive cleanup of evidence. Ledger and task reports are under `.superpowers/sdd/2026-09-09-r7-ppt-official-only/`; retain evidence/report deliverables per user even if generic skill suggests deleting scratch. Root coordinates commits rather than concurrent worker commits. Completion claims use PASS/FAIL/PARTIAL/HOLD/NOT_RUN, never inferred from old reports.
