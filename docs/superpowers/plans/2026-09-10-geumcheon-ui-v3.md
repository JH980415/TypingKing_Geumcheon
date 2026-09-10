# Geumcheon UI v3 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with task-scoped ownership and review. Do not create another worktree, push, merge, delete old artifacts, or dispatch nested reviewers.

**Goal:** Implement U01–U12 of the user's 20260910 v3 package, retain records/calculations/security, and provide separately verified review/NAS candidate packages and evidence.
**Architecture:** Continue the existing isolated R7 worktree. Keep UI changes Geumcheon-scoped; use the existing authenticated records:list request/response for atomic protected partial search. No new NAS endpoint or permission is needed. Main owns implementation of filtering, renderer owns submitted/draft state and existing ranking after a single snapshot.
**Tech Stack:** Electron43, React19, TypeScript, Vite, Node test/tsx, Playwright-core existing project test instrumentation, Python/.NET artifact audits.
**Spec:** Codex/Inputs/UIV3_20260910/TypingKing_UI_Work_Package_20260910_v3/01_FINAL_WORK_ORDER_v3.md. Read the entire spec, original seven-slide PPT/notes, ASSET_MAP and latest reference. User's current direct request wins over attachment text.

## Global Constraints

- ACTIVE_CHANGE_IDS=U01-U12; PRODUCTION_RELEASE=HOLD; USER_FINAL_UI_APPROVAL=PENDING.
- Original PNGs/PPT, earlier R7 builds, records, failed evidence and other events are preserved. No generative redraw, crop, image substitution, or resurrection of removed logos.
- Use ready PNGs exactly: title_logo_062843.png; geumnarae_main_052455_alpha.png; geumnarae_stage1_defeat_054108_alpha.png. U08 is Stage1 USER_WIN, not participant loss.
- Logo visible bbox alpha>=8 [21,66,2027,607], canvas2048x682. Same scale x/y, relative ratio error<=0.5%; center X equals outer-board center X and center Y equals outer-board top Y, each<=2 CSS px.
- Logo full canvas remains unclipped, no patched rectangle/white line, no duplicated image/half opacity. Top clearance>=8px; header/count/controls clearance>=12px. Fix original table/form boxes first; no shrink, movement, row/font/global-scale change to fit.
- Before/after invariant boxes differ<=2 CSS px at same viewport. Explicit U06 bottom and U11 control-only rearrangement are exceptions. Native scrollbar inner width is not outer-box shrink.
- U04 fonts each baseline*1.30, line-height ratio1.25 retained, letter spacing baseline+0.02em; group center X at right panel center and center Y at inner border top/name-label midpoint, errors<=2px, >=12px clearance at720. Form/buttons fixed.
- U06 only necessary left background lower-bound extension; cards/panel children/right panel fixed; >=12px card/border clearance. U07 existing two-line text and capsule move together; >=12px panel/content-edge clearance.
- U05 remove only ', 경품 지급 및 본인 확인' from displayed purpose line; all other consent text/data/requiredness unchanged.
- U09 final-only description 'AI 금나래보다 빠르고 정확하게 완성했습니다.'; no personal-name insertion. Intermediate two-line left-aligned win/loss captions and badges remain, no standalone Stage labels.
- U01 Geumcheon visible participant words become 도전자; internal keys/CSV/raw result labels/other-event semantics are not globally rewritten. U12 AI-winning display 'AI 금나래 승리'; challenger-winning display '도전자 승리'; other statuses preserved.
- U11 name/contact partial search: button or non-composing Enter only; field change and blank query clear applied condition without changing session/view. Keep draft distinct from applied, refresh uses applied; invalid contacts are errors not empty/full-list. Full eligible snapshot, existing best/rank BEFORE match filter, original ranks and display masking retained.
- Search adds no raw PII field/log/query echo, no privileges; existing authenticated raw data contract is acknowledged, not falsely claimed absent. Optional search uses fresh-only NAS read; existing no-argument fallback remains unchanged. No actual NAS/ACL/network/container changes.
- Actual EXE evidence distinct from headless/SSR/unit, native F11 distinct from CDP; human IME/native F11 failure remains NOT_RUN. Old raw FAIL never overwritten. No OneDrive/GitHub transfer in this round without extra approval.

### Task 1: Freeze inputs and actual before baseline (root)

**Files:** Inputs above; scripts/uiv3-runtime-check.ts; Codex/Evidence/UIV3_20260910/before/review-01/index.json.
**Consumes:** Productfc6e071, verificationHEAD71fa295, prior four EXE manifest and package SHA.
**Produces:** Same EXE before images, extended rect/font/border measurements, fresh run receipt; verified v3 manifest25entries.

- [x] Read all v3 instructions; validate ZIP CRC, safe paths, exact manifest membership and all hashes before extracting to a new directory.
- [x] Verify linked worktree, HEAD and remote; create local codex/geumcheon-2026-ui-v3 from71fa295, no push/merge.
- [x] Preserve old harness; copy to uiv3 runtime harness and add invariant selectors/typography only.
- [x] Start actual old review EXEs with explicit fc6 source label and isolated synthetic local storage, capture720/1080 main/duel/results/leaderboard.
- [ ] Record completion/owned-process absence and binary/index/harness SHA. Run focused baseline layout/game/connection tests once, record preexisting failures without claiming fixes.

### Task 2: Exact asset mapping and U10/U11 control-region styling

**Ownership:** events/geumcheon-2026/event.config.json; three newly named files under events/geumcheon-2026/assets/; apps/leaderboard/src/r7-geumcheon.css; tests/events/uiv3LeaderboardLayout.browser.ts and necessary existing asset/layout expectations only. Do not edit LeaderboardApp.tsx (Task4).
**Consumes:** Before box geometry and provided ready PNG hashes; Task4 uses .uiv3-search-controls, .uiv3-search-primary, .uiv3-search-secondary.
**Produces:** Assets used by current active references; intact board geometry with alpha-bbox-centered logo; bounded controls styling.

- [ ] RED: real React browser loads current event profile, independently scans image alpha>=8, measures true contain paint. At each viewport and0/20/scrolled rows assert old outer/inner/header/row metrics plus new ratio/center. Current stretched left logo must fail.
```ts
assert.ok(Math.abs(visibleCenterX - (board.x + board.width / 2)) <= 2);
assert.ok(Math.abs(visibleCenterY - board.y) <= 2);
assert.ok(Math.abs(paintedWidth / paintedHeight / (2048 / 682) - 1) <= .005);
```
- [ ] Add three ready files by byte copy only, config maps eventTitle/aiBossMain/aiBossDefeats[0]. Other refs and original files untouched. Assert actual active image SHA and all other five win/loss image mappings.
- [ ] Replace only logo CSS: independent overlay relative to fixed header/app; uniform scale constrained by top/header/count/control clearance. Use image left=board.centerX-s*1024 and top=board.y-s*336.5, width2048*s,height682*s. Keep foreground above board background and below modals, pointer-events:none; header clipping must not crop upper half.
- [ ] Search classes style within current right controls area, existing fonts/colors/heights, gap8; select>=80/input>=160/search>=56; wrap permitted only inside that area. Do not reposition table.
- [ ] GREEN: same browser tests, existing sticky-header pixel test, asset tests. Write measured allowed logo size and table/reference difference. No old geometry assertion is dropped merely to pass; old logo target alone is superseded by v3.
- [ ] Self-review diff, focused report with RED/GREEN logs; root coordinates commit and task review.

### Task 3: Game U01/U02/U03/U04/U05/U06/U07/U08/U09

**Ownership:** apps/typing-game/src/TypingGameApp.tsx; AIChallengeGame.tsx; r7-geumcheon.css; game-specific tests under tests/events/uiv3GamePresentation.test.ts and uiv3GameLayout.browser.ts; scoped updates to old game tests. No event config or leaderboard edits.
**Consumes:** Task2 paths resolve via existing event asset resolver, before index geometry. Uses original source RGBA full canvas.
**Produces:** Geumcheon-only display and layout corrections, foreground invariance, all six intermediate outcomes unchanged except U08 asset and allowed labels.

- [ ] RED: render real game/consent/result components in Geumcheon and non-Geumcheon profiles; verify final-only description, visible terms and exact consent substring delta; stored save result labels retain original values. Use observable output, not source-text grep.
- [ ] RED geometry: actual browser interaction with input/error/consent/duel and fixed baseline boxes. At720 baseline fonts18.56,target24.128;1080baseline25,target32.5; letterSpacing targetfont*.02; A=panel.top+borderTop,B=name-label.top.
- [ ] Preserve original title/character slots, object-fit contain. Freeze old slogan flow allocation, center enlarged group independently in A/B region without form movement. Do not invent fallback shrink/reflow.
- [ ] U06 current actual before gap14px at720,22px at1080 already>=12: retain background if all3 stages confirm. U07 current8px gap: translate entire existing guide4px down, without reflowing flex foreground; check each stage/resolution.
- [ ] Replace permitted visible terms with event-scoped expressions/helper, exact purpose-line display deletion and U09 final-only copy. No persisted config/raw record rewrite; popup lines/positions unchanged.
- [ ] GREEN: game SSR/behavior/both-resolution geometry tests plus existing caret/popups/main-group tests. Record any measured conflict instead of altering untouched boxes.
- [ ] Self-review, RED/GREEN/coordinates report, root-coordinated commit/task review.

### Task 4: Atomic protected partial search and leaderboard U01/U12

**Ownership:** apps/leaderboard/src/LeaderboardApp.tsx; electron/main.ts,preload.ts,geumcheonConnection.ts,nas/runtime.ts; apps/shell/src/global.d.ts; shared existing IPC/types file plus focused search helper if necessary; tests/electron/geumcheonConnection.test.ts, focused search tests and NAS runtime tests. No LB CSS (Task2), no game/config/server edits.
**Produces interface:**
```ts
type RecordListRequest = { search: {field:'name'|'contact';term:string} | null };
type RecordListResult = ApiResult<RecordRow[]> & {matchingRecordIds?: string[] | null};
// omitted request keeps original behavior, shape and caching
listRecords(request?: RecordListRequest): Promise<RecordListResult>;
```
- [ ] RED main behavior fixtures: raw name internal substring; phone0 preserved, hyphen/whitespace normalized; invalid char/unknown key/role/session rejected; fresh-only failure not stale success; noquery old fallback unchanged; one underlying query supplies data+IDs atomically.
```ts
// Manual fixture expectations; never calculate expected IDs with production match helper.
assert.deepEqual(result.matchingRecordIds, ['synthetic-001']);
assert.equal(runtimeLoads, 1);
assert.deepEqual(Object.keys(result).sort(), ['data','matchingRecordIds','ok']);
```
- [ ] Implement handler optional-request branch using safeAsync wrapper local flattening. Require Geumcheon+official+leaderboard+connection; query cannot choose device/session/source. Existing data projection unchanged, IDs only metadata. Runtime loadRecords({freshOnly:true}) bypasses last-known-good success fallback only on new path.
- [ ] UI one snapshot state {rows,matchingRecordIds}, field/draft/applied distinction, composition guard, request generation and latest-result protection. All refresh paths preserve applied search and mode. Equal masked-phone rows must not suppress updated full snapshot search IDs.
- [ ] Implement three primary controls and secondary refresh/admin existing controls using Task2 agreed class names; no global layout work. Existing unauthorized display masking stays. Apply matching IDs after unchanged best/rank function.
- [ ] RED/GREEN real UI interaction fixtures: typing not applied; button/Enter; composing Enter; clear/field change; manual/auto refresh while draft changed; zero/error distinction; >120records; original rank; best/all; long/invalid contact; in-flight old reply ignored.
- [ ] U01/U12 presentation-only labels in this component; internal winner/status/rank keys and other-event UI unchanged.
- [ ] Run focused connection/search/NAS tests and self-review; report original raw renderer boundary accurately and no server/security weakening. Root coordinates commit/task review.

### Task 5: Integrated source verification, new builds and actual EXEs (root)

**Files:** scripts/uiv3-runtime-check.ts; build configs only output directory/release candidate metadata as needed; Codex/Evidence/UIV3_20260910/{after,builds,source-checks}; separate release-build/uiv3 folders and Outputs/UIV3_20260910.
**Consumes:** Tasks2–4 reviewed code, baseline index and provided ready hashes.

- [ ] Integrate test harness new labels/search submission and actual image pins; keep raw old failure evidence. Expectations independently derived from before snapshot/spec, not same production placement helper.
- [ ] Source tests/typing with bounded concurrency, actual browser geometry and search; inspect diff for server/calculation/CSV/auth changes.
- [ ] Commit exact scoped source/test/assets after secret/unrelated-file review, no push/main merge; record SHA.
- [ ] Build review game/LB and NAS game/LB into new directories; never overwrite old deliverables. Verify each ASAR assets/dependencies, EXE SHA and required files.
- [ ] Execute actual four EXEs with isolated synthetic records/local HTTPS, both resolutions, all U01–12 states. Capture clean+diagnostic views, same snapshot coordinates, search sequence and caret frames. Native F11 initialization currently blocked; preserve NOT_RUN and separate human checklist. No bypass of native tool/security/TLS.
- [ ] Close exact owned processes and temporary listener, record explicit exit/process receipt. Old overall FAIL or new failing assertions are not converted to PASS by exit0.

### Task 6: Independent delivery audit and report (root)

**Outputs:** separate review2/NAS2/device5/server-if-unchanged-reuse packages, U01–U12 matrix, report/diff/source/build/test/asset manifests, before/after captures and continuous evidence, final ZIP sizes/SHA.

- [ ] Produce privacy-reviewed report/evidence package without raw PPT/reference participant data/credentials. Originals stay local. Capture diagnostic overlay separately, do not paint reference PNG into fake app screen.
- [ ] Audit archives with CRC, path traversal/Unicode/case duplicates, exact membership, source byte equality, independent .NET stream SHA. Existing server reuse must be labeled NOT_REBUILT; source HTTPS validation is not successful final-server/NAS integration.
- [ ] Final code review across task interactions; resolve load-bearing findings then reverify affected outputs. Only report current evidence-backed statuses.
- [ ] Report executed vs FAIL/HOLD/NOT_RUN, native/actual NAS/user-approval gaps. No external delivery until new explicit approval. Preserve workspace/ledger/old packages even if generic skill cleanup suggests deletion.

## Preflight Self-Review

All U01–U12 map to tasks2–4; build/EXE/coordinates/frames/hashes/matrix to5–6. No placeholder behavior/API names; measurements above are actual before readings except spec tolerances. Search field types differ from display labels deliberately. Existing .git worktree is already isolated; dependencies installed, no reinstall. Parallel owners share interfaces but no files except root-coordinated expectation updates. Production-source edits begin only after before screens/coordinates are saved. Full native acceptance remains a tool-dependent gate, not a reason to abandon independent UI work.
