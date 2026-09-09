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

## Approved additions after NAS boundary reproduction (2026-09-09)

- User explicitly approved narrow client/server record-contract corrections, not formula changes. Reproduce missing detailed evidence, independent rounding and Korean typing-unit mismatch first. Compare original result, transmitted row, server validation/storage, retrieval and public display independently.
- Preserve participant CPM/accuracy, AI difficulty, outcome and existing public order. Never promote canonical raw CPM into the existing public ranking: the literal `1234`/`12x`/5000ms counterexample is public24, protected canonical36, accuracy50. Keep these different meanings explicit.
- Proposed compatible contract: new versioned nested `recordEvidence` holds trusted canonical and actual StageBattle primitive snapshots; legacy public fields remain unchanged. Validate every new raw/canonical/fairness/legacy boundary, persist evidence securely, omit only this evidence from public projection. Existing incomplete rows remain rejected; no reconstruction, migration, guessed defaults or widened tolerances.
- Client owner: record-contract agent, shared types/helper/persistence and AIChallengeGame record creation only. Server owner: build-diagnosis agent, server schema/store/routes/tests. Root owns Electron F11 and public IPC projection. UI edits are already present and must survive. Runtime agent exclusively owns GUI/harness.
- User UI additions: no simulated caret in target or lower overlay, native lower textarea caret retained; larger original-ratio leaderboard logo; F11 toggle both apps; win/loss exact two-line left-aligned captions below fully reserved Stage badge; separate transparent Stage1 derivative while originals remain unchanged.
- RED F11 handler-missing reproduced in `source-checks/f11-red.log`. Root fresh added-UI suite34/34 passes in `additional-ui-green.log` (source/harness checks, not native EXE/IME proof).
- Final affected four EXEs and compatible server must be rebuilt after source freeze. Verify real synthetic win/loss/stages/save/query/different-speed rank/idempotency and independently calculated literals. No actual NAS operation is authorized. PRODUCTION_RELEASE=HOLD until actual NAS storage and user approval.
- User explicitly approved local non-AI background removal. Stage1 derivative now exists, all decoded RGB pixels unchanged, original hash intact; root inspected three 280px composites and selected it in active config. Four final EXEs and ZIP assets still require fresh proof. External Git destination approval remains separate and pending.

## Latest NAS storage decision (2026-09-09)

- Use existing Korean shared folder `임시` / child `typingking` for record data; do not create a new NAS share or bind the entire `임시` share. The user will supply the exact NAS absolute path from folder properties. Never infer a volume or fix `/volume1/typingking`.
- Server config and Container Manager bind template must retain an explicit unresolved host-data path. Runtime package and secrets use separately confirmed, non-overlapping locations; only record data is writable, runtime/secret mounts read-only. Existing share/other-folder ACLs stay unchanged.
- A host-network/loopback compose candidate is REVIEW_ONLY, not an approved final network topology or deployment. DSM support, reverse proxy/TLS, image digest and UID/GID remain confirmation gates. No actual NAS access, configuration, network or record operation is authorized by this storage update.
- Test Korean/space path YAML substitution and local actual server storage in `임시/typingking`, with sibling bytes/hash unchanged. These prove local path handling, not Synology/Container Manager execution.

Preserve R6 and main. No destructive cleanup of evidence. Ledger and task reports are under `.superpowers/sdd/2026-09-09-r7-ppt-official-only/`; retain evidence/report deliverables per user even if generic skill suggests deleting scratch. Root coordinates commits rather than concurrent worker commits. Completion claims use PASS/FAIL/PARTIAL/HOLD/NOT_RUN, never inferred from old reports.
