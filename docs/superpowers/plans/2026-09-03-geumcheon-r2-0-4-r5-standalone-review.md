# Geumcheon R2.0.4 R5 Standalone Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox syntax for recovery after interruption.

**Goal:** Deliver four true single-file Electron review executables for the Geumcheon 2026 AI Typing King, with local review-only persistence, the R5 ranking/stage/UI corrections, current verification evidence, and the two exact ZIP deliverables.

**Architecture:** Keep the existing production Geumcheon startup, NAS credential import, role enforcement, TLS validation, and fail-closed behavior unchanged. Builder-stamped metadata selects a separate packaged-only `review` path that uses `%LOCALAPPDATA%` local namespaces and never initializes the NAS client or credential bootstrap. Shared ranking remains the single source for UI, export, and Record API order; review records are written atomically as review-marked envelopes and read by the matching official/practice pair.

**Tech Stack:** Electron 43, React 19, TypeScript 5.9, Vite 7, electron-builder portable target, Node test runner through `tsx`, Playwright Electron control.

**Spec:** `Codex/Work/R5/00_Input/TypingKing_Geumcheon_R2_0_4_R5_WORK_PACKAGE_20260903/02_INSTRUCTIONS/TypingKing_Geumcheon_R2_0_4_R5_최종작업지시서_20260903.md`

## Global Constraints

- Baseline is `codex/geumcheon-2026-r2-0-3` at `5162ca8a697574015acd3a699d3daf948f4f186a`; work branch is `codex/geumcheon-2026-r2-0-4-standalone-review-r5`.
- Do not merge into `geumcheon/main`; push only the R5 work branch.
- Never use or embed a real NAS address, production credential, token, private key, or real participant test data.
- Production remains fail-closed, TLS verification remains enforced, player/leaderboard permissions remain separated, and canonical-attempt enforcement remains active.
- Review identity is builder-stamped, not enabled by an environment variable or CLI flag. Packaged variant metadata wins over runtime environment/CLI overrides.
- Review metadata values are exactly `environment=review`, `profileId=geumcheon-2026`, `eventId=geumcheon-science-festival-2026-review`, `buildId=R2.0.4-R5`.
- Official and practice data are physically separate; each game/leaderboard pair shares only its matching namespace.
- Preserve the approved title asset, title containment, leaderboard central title, row select/deselect, masking, alpha 0.75 panel, countdown placement, stage badges, retry records, and interruption records.
- User ZIP contains exactly the four approved EXEs, plus no README unless execution proves one is necessary. GPT LITE contains no EXE, credentials, real PII, real NAS address, userData, node_modules, nested ZIP, or raw development output.
- A current runtime or visual check is required for PASS. Unsupported physical-network, actual NAS, or human-IME checks remain HOLD/NOT_RUN.
- Work in the current clean checkout on the dedicated R5 branch because the canonical package names this project root and branch; do not create a second checkout or alter the baseline branch.

---

### Task 1: R5 ranking comparator and functional best/all leaderboard

**Files:**
- Modify: `shared/utils/ranking.ts`
- Modify: `apps/leaderboard/src/LeaderboardApp.tsx`
- Modify: `shared/csv/fileStore.ts`
- Modify: `services/nas-record-api/src/recordStore.ts`
- Modify: `tests/domain/geumcheonCanonicalRanking.test.ts`
- Modify: `tests/domain/geumcheonLeaderboardSelection.test.ts`
- Modify: `tests/domain/geumcheonLeaderboardCsv.test.ts`
- Modify: `services/nas-record-api/test/leaderboard.test.ts`

**Interfaces:**
- `canonicalAiRankKey(record)` produces only participant-win priority and participant average CPM; total time, stage, and progress are absent.
- `compareCanonicalAiDisplayOrder(left, right)` uses `recordedAt` ascending and `recordId` ascending only after equal result/CPM.
- `selectGeumcheonAiLeaderboardEntriesForMode(entries, mode)` consumes `viewMode: "all" | "best"` and groups best-only by `record.participantKey` first.
- Record API and CSV export consume the same comparator semantics; total duration remains display data only.

- [ ] **Step 1: Add failing comparator tests.** Add the canonical A–F inversion fixture from the spec, mutate every duration without changing order, assert CPM descending in win/loss groups, and assert deterministic `recordedAt`/`recordId` order on an exact result+CPM tie.
- [ ] **Step 2: Run RED.** Run `npx tsx --test tests/domain/geumcheonCanonicalRanking.test.ts`; expect failures showing stage/progress/time still affect order.
- [ ] **Step 3: Implement the minimum shared comparator.** Change only the rank key/result mapping and legacy comparator needed to enforce participant win first, CPM descending, then stable timestamp/ID.
- [ ] **Step 4: Run GREEN.** Re-run the canonical ranking test and existing logic tests.
- [ ] **Step 5: Add failing best/all and export/API tests.** Prove all attempts remain in `all`, one best attempt per opaque participant key remains in `best`, same-name different keys remain separate, refresh input does not reset view mode, CSV/API order matches the A–F comparator, and total time does not affect any order.
- [ ] **Step 6: Run RED.** Run the three domain tests and NAS leaderboard test; expect the AI view-mode and server/export-order assertions to fail.
- [ ] **Step 7: Wire the shared comparator and toggle.** Pass `viewMode` to the AI selector, use `participantKey` before the existing private fallback identity, add `aria-pressed`, and reuse the comparator in export and effective API list order without altering record acceptance or storage validation.
- [ ] **Step 8: Run GREEN and regression.** Run `npx tsx --test tests/domain/geumcheonCanonicalRanking.test.ts tests/domain/geumcheonLeaderboardSelection.test.ts tests/domain/geumcheonLeaderboardCsv.test.ts services/nas-record-api/test/leaderboard.test.ts` and `npm run test:logic`.

### Task 2: Exact stage texts and Geumnarae CPM ranges

**Files:**
- Modify: `events/geumcheon-2026/stage_texts.csv`
- Modify: `events/geumcheon-2026/event.config.json`
- Modify: `apps/typing-game/src/AIChallengeGame.tsx`
- Modify: `tests/domain/geumcheonStageTexts.test.ts`
- Modify: `tests/domain/stageTextShuffle.test.ts`
- Modify: `tests/domain/geumcheonTiming.test.ts`
- Modify only if current server validation is exact-range-bound: `services/nas-record-api/src/config.ts`
- Modify only with the server config above: `services/nas-record-api/test/auth.test.ts`, `services/nas-record-api/test/recordSchema.test.ts`, and fixtures containing old exact ranges.

**Interfaces:**
- Stage 1 candidates are exactly `로봇과 노는 금천과학축제` and `인공지능과 함께하는 축제`.
- Stage 2 candidates are exactly `인공지능 로봇의 신나는 축제!` and `AI야, 금천과학축제 놀러가자!`.
- Stage 3 is exactly `AI와 소통하는 활기찬 미래 금천`.
- Official and practice Geumnarae ranges are both inclusive integers: stage 1 `100..125`, stage 2 `125..150`, stage 3 `150..200`.
- `createAiCpm(stage, config, fixedDebugSpeed, random)` accepts an injectable random function for boundary tests while defaulting to `Math.random`.

- [ ] **Step 1: Replace old expectations with failing exact-catalog tests.** Assert exactly 2/2/1 active rows, verbatim punctuation/spacing, Stage 3 fixed across draws, Stage 1/2 never leave their candidate sets, and a new attempt can select another candidate.
- [ ] **Step 2: Run RED.** Run `npx tsx --test tests/domain/geumcheonStageTexts.test.ts tests/domain/stageTextShuffle.test.ts`; expect the 60-row draft catalog to fail.
- [ ] **Step 3: Replace the draft CSV with the five canonical rows.** Preserve the existing schema and use a new R5 catalog version consistently.
- [ ] **Step 4: Run GREEN.** Re-run both stage-text tests.
- [ ] **Step 5: Add failing difficulty boundary tests.** Assert both variants use the three R5 ranges, injected random `0` reaches each minimum, injected random just below `1` reaches each maximum, and the participant CPM/accuracy calculation tests remain unchanged.
- [ ] **Step 6: Run RED.** Run `npx tsx --test tests/domain/geumcheonTiming.test.ts` and the applicable server config/schema tests; expect old ranges to fail.
- [ ] **Step 7: Apply only the range/config changes.** Update event config and exact-range server validation fixtures if required; expose/inject RNG in `createAiCpm` without changing participant calculation or rendering.
- [ ] **Step 8: Run GREEN and regression.** Run the updated timing/server tests and `npm run test:geumcheon:client`.

### Task 3: Builder-stamped review startup and atomic local review storage

**Files:**
- Create: `electron/review/reviewLocalRuntime.ts`
- Create: `electron/geumcheonConnection.ts`
- Modify: `electron/startupProfile.ts`
- Modify: `electron/main.ts`
- Modify: `shared/types/index.ts`
- Modify: `shared/events/bootstrapData.ts`
- Modify: `shared/nas/protocol.ts`
- Modify: `apps/shell/src/OneDriveSettingsPanel.tsx`
- Modify: `apps/shell/src/global.d.ts`
- Modify: `electron/preload.ts` only if a dedicated validation IPC is needed after reuse of current readiness/list calls is proven insufficient.
- Create: `tests/events/r5ReviewStartup.test.ts`
- Create: `tests/events/r5ReviewLocalRuntime.test.ts`
- Modify: `tests/nas-client/protocol.test.ts`
- Modify: `tests/events/tlsEnvironmentGuard.test.ts`

**Interfaces:**
- `ReviewRuntimeContext` is exposed in `BootstrapData.reviewContext?` with exact environment/profile/event/build, device ID, role, session, and `storageKind: "local"`; it contains no absolute path or credential.
- `resolvePackagedMetadata()` recognizes review only when package metadata has exact `typingKingEnvironment: review` and `typingKingBuildId: R2.0.4-R5` with Geumcheon profile/variant.
- `resolveStartupProfile()` maps review runtime storage to `%LOCALAPPDATA%/ThePMD/TypingKing/Geumcheon2026/Review/<official|practice>` and userData to a variant-specific sibling, never reads `device-profile.json`, and seeds packaged stage texts before runtime initialization.
- `initializeGeumcheonConnection()` accepts production/review factories and selects exactly one, enabling a test that production/NAS factory calls are zero in review mode.
- Review record envelope fields are exact: `schemaVersion: 1`, `environment: "review"`, `profileId: "geumcheon-2026"`, `eventId: "geumcheon-science-festival-2026-review"`, `buildId: "R2.0.4-R5"`, matching `sessionKind`, opaque `participantKey`, and `record`.
- Review writes use unique per-record JSON temp files followed by same-directory atomic rename; incomplete `.tmp` files are never listed. Official and practice directories are disjoint.

- [ ] **Step 1: Add failing startup/security tests.** Assert exact metadata recognition, malformed/CLI/env attempts cannot enable review, packaged metadata fixes the variant, review needs no adjacent profile/credential, production still fails without them, TLS bypass remains rejected, and the NAS factory call count is zero for review.
- [ ] **Step 2: Run RED.** Run the new startup test plus `tests/events/tlsEnvironmentGuard.test.ts`; expect missing review path failures.
- [ ] **Step 3: Implement review startup and backend selection.** Add exact metadata/context types and the factory seam; keep all credential import and NAS client creation exclusively in the production branch.
- [ ] **Step 4: Run GREEN.** Re-run startup/TLS tests and existing event-profile/runtime-isolation tests.
- [ ] **Step 5: Add failing review-store tests.** Cover official game→official leaderboard, practice game→practice leaderboard, zero cross-leak, per-record review marker, HMAC participant key without raw PII in logs/UI metadata, concurrent unique writes, same-ID recovery, ignored partial temp, atomic corrupt-file handling, checkpoint recovery, and no helper executable creation.
- [ ] **Step 6: Run RED.** Run `npx tsx --test tests/events/r5ReviewLocalRuntime.test.ts`; expect missing module failures.
- [ ] **Step 7: Implement the local runtime.** Reuse `saveRecord` calculations and locks plus the canonical attempt runtime; generate review-only IDs, write marked envelopes atomically, keep official/practice roots separate, and implement list/edit/hide/reset through the same local authority. Do not import or instantiate NAS/credential code in this module.
- [ ] **Step 8: Expose truthful admin validation.** In review mode render `저장방식: 검토용 로컬 저장`, fixed role/session, and `검증 결과: 정상` only after the matching local readiness/list call succeeds. Never show a token, URL, absolute path, or internal error code.
- [ ] **Step 9: Run GREEN and security regression.** Run both new tests, `npm run test:nas-client`, event TLS/profile tests, and `npm run scan:pii`.

### Task 4: R5 main, focus, battle header, and responsive UI

**Files:**
- Modify: `apps/typing-game/src/TypingGameApp.tsx`
- Modify: `apps/typing-game/src/AIChallengeGame.tsx`
- Modify: `apps/shell/src/styles.css`
- Modify: `tests/events/geumcheonUiText.test.ts`
- Modify: `tests/events/geumcheonUiAssets.test.ts`
- Modify: `scripts/e2e-geumcheon-approved-ui-check.ts`

**Interfaces:**
- `.left-title-group` contains the approved title image and exact subtitle at one shared max width and center alignment.
- `.entry-panel` has a top `.entry-event-copy`, centered `.entry-form-group`, and existing bottom action row. Geumcheon renders no right-side mode label/card.
- Geumcheon input/select/textarea/checkbox/button focus uses one visible magenta/purple indicator and no yellow/gold outer ring; other profiles remain unchanged.
- `.challenge-stage-center` contains a dedicated game-name row above a separate `.stage-badge-row`, with actual layout space rather than z-index overlap.

- [ ] **Step 1: Add failing structural and computed-style tests.** Assert no Geumcheon mode block, exactly one event copy in the right panel, shared title/subtitle wrapper, accessible magenta focus with no yellow computed outline/shadow/border, separate challenge title/badge rows, and preserved leaderboard outer-title removal/central title/row deselect.
- [ ] **Step 2: Run RED.** Run the two UI tests and the focused E2E test; expect current mode block, yellow outline, and overlap/layout assertions to fail.
- [ ] **Step 3: Implement the minimum JSX/CSS changes.** Do not redesign the approved art. Preserve title aspect ratio and fixed containment; reserve form error height; keep start/admin controls in the lower action area; scope all overrides to `data-event-profile="geumcheon-2026"`.
- [ ] **Step 4: Run GREEN at 1280×720 and 1920×1080.** The E2E must capture official/practice main, Stage 1/2/3, focus states, and official/practice leaderboard all/best with at least 10 synthetic records. Assert title/badge overlap `0px`, no panel overflow, masking/search/scroll, and alpha `0.75`.
- [ ] **Step 5: Inspect every generated screenshot.** Record any visual issue as FAIL, correct it, and repeat the exact resolution test. Add Korean IME real-input as a manual UAT item and mark NOT_RUN unless a human actually performs it.

### Task 5: Four true portable review EXEs and executable verification harness

**Files:**
- Create: `electron-builder.geumcheon-ai-review.yml`
- Create: `electron-builder.geumcheon-ai-leaderboard-review.yml`
- Create: `electron-builder.geumcheon-practice-review.yml`
- Create: `electron-builder.geumcheon-practice-leaderboard-review.yml`
- Modify: `package.json`
- Create: `tests/events/r5ReviewPackaging.test.ts`
- Create: `scripts/r5-standalone-review-check.ts`

**Interfaces:**
- Four configs use distinct review app IDs/product names, `target: portable`, `asar: true`, internal event/assets/stage resources, exact review metadata, and exact artifact names from the canonical spec.
- Outputs are under `release-build/geumcheon-review/<variant>/`; no production artifact is overwritten.
- `npm run dist:geumcheon:review` builds all four after one source build.
- The verification script receives explicit EXE paths/output root, creates four independent empty directories, copies exactly one EXE into each, launches with Playwright/Electron, records window/process/folder evidence, performs pair sharing, and always closes processes in `finally`.

- [ ] **Step 1: Add failing packaging-contract tests.** Assert four configs/scripts, exact filenames, unique app IDs, portable target, asar/resources, exact review metadata, and absence of launcher/runtime/CMD/credential references.
- [ ] **Step 2: Run RED.** Run `npx tsx --test tests/events/r5ReviewPackaging.test.ts`; expect missing config/script failures.
- [ ] **Step 3: Add the four builder configs and scripts.** Clone only the approved existing resource allowlist and change output/app metadata/artifact names; do not change production configs.
- [ ] **Step 4: Run GREEN and build.** Re-run packaging tests, run `npm run build`, then `npm run dist:geumcheon:review`.
- [ ] **Step 5: Add a failing artifact-level harness test.** It must reject a 5KB/non-PE launcher, sibling runtime/config/CMD dependency, duplicate EXE hashes, unexpected helper processes/files, credential dialogs, or missing review context.
- [ ] **Step 6: Run the real empty-folder protocol for all four.** Copy one EXE only, verify PE/size/hash/listing, direct GUI launch, no command window/popup, local validation, game or leaderboard flow, clean exit, zero helper executable residue, and allowed review data only.
- [ ] **Step 7: Run official/practice pair tests.** Save synthetic records from each game and observe them in the matching leaderboard within two refreshes; assert zero cross-namespace leakage.
- [ ] **Step 8: Verify offline honestly.** Use a genuinely network-disabled Windows Sandbox or equivalent host control if available. If unavailable, retain code-level no-network evidence but set `OFFLINE_SINGLE_EXE_TEST=HOLD`; do not infer PASS.

### Task 6: Full verification, evidence, packages, GitHub, and OneDrive backup

**Files (generated, ignored):**
- Create under `Codex/Outputs/R5/`: `00_FINAL_REPORT_R5.md` through `13_SHA256SUMS.txt`, `Screenshots/before`, `Screenshots/after`, and `Logs/sanitized` exactly as the canonical deliverable list.
- Create: `Codex/Outputs/R5/R2_STANDALONE_REVIEW_EXE_4종.zip`
- Create: `Codex/Outputs/R5/GPT_TRANSFER_LITE_R5_20260903.zip`
- Copy final packages to a new non-colliding OneDrive folder under `C:/Users/박재환/OneDrive - 더피엠디/1. 박재환/AI 관련/Backup/`.

- [ ] **Step 1: Run the complete fresh verification set.** Run `npm run test:logic`, `npm run test:geumcheon:client`, `npm run test:nas-client`, all new R5 tests, server tests affected by the diff, `npm run build`, `npm run scan:pii`, `npm audit --audit-level=high`, and `git diff --check`. Save sanitized output and exact exit/count summaries.
- [ ] **Step 2: Re-read the canonical requirement matrix.** Fill every row with PASS/PARTIAL/FAIL/HOLD/NOT_RUN and a current source/test/screenshot/runtime artifact; never copy a prior PASS.
- [ ] **Step 3: Generate all thirteen reports/manifests.** Include the revoked 5,632-byte launcher finding, source mapping, exact changed files/diff, four-EXE table, local role/session results, UI/ranking/stage/security evidence, actual NAS `NOT_RUN`, and human IME status.
- [ ] **Step 4: Build and independently inspect the user ZIP.** Include only the four exact EXEs; verify entries, no traversal/duplicates, CRC, PE headers, four distinct SHA-256 values, size, and forbidden-name/content scan.
- [ ] **Step 5: Build and independently inspect the GPT LITE ZIP.** Exclude EXEs and all forbidden data; target under 30 MiB; verify entries, CRC, no traversal/duplicates, manifest sizes, and SHA-256.
- [ ] **Step 6: Review the complete branch diff.** Dispatch a fresh final reviewer, fix every load-bearing finding, rerun affected tests, and repeat the package manifests if bytes changed.
- [ ] **Step 7: Commit only R5 source/config/test/plan changes.** Confirm generated outputs, release builds, credentials, userData, logs, test artifacts, ZIPs, and OneDrive backup are ignored/untracked and absent from the commit.
- [ ] **Step 8: Push only the R5 branch to `geumcheon`.** Verify local commit SHA equals `git ls-remote` branch SHA and `geumcheon/main` remains unmerged.
- [ ] **Step 9: Copy both verified ZIPs and checksum manifest to the new OneDrive R5 backup folder.** Re-hash source/destination bytes and report sync availability separately from local copy success.
- [ ] **Step 10: Return the two exact user paths and final status block.** `PRODUCTION_RELEASE=HOLD` and `ACTUAL_NAS_DEVICE_SESSION_VALIDATION=NOT_RUN` remain fixed; any unexecuted standalone/offline/UI item remains HOLD.
