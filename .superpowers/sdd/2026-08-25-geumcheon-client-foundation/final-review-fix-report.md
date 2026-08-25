# Geumcheon client foundation final-review fix report

Date: 2026-08-26 KST

Branch: `geumcheon-2026`

Fix base: `b1b18cd`

Commit subject: `fix: address Geumcheon client final review`

## Outcome

All four Important client-foundation findings were corrected as one integrated fix wave:

1. Official ranking now counts completed, failed, and interrupted records among each participant's first three authoritative attempts. The best eligible record is selected even when a participant has no completion, completed records remain above incomplete records, and a countdown interruption with zero elapsed time and zero typing units remains visible.
2. Executable-adjacent runtime migration is allowed only for the legacy `skillup-2026` profile. Packaged Geumcheon starts in its event/device-scoped runtime without importing legacy or another device's files.
3. Shell theme resolution uses runtime `config.theme` for SkillUp and the event-profile theme for Geumcheon.
4. All four Geumcheon builders package only four explicitly approved event resources. The client build checker validates the exact unpacked event-resource set, and the PII scanner streams supplied exact secret needles through `.exe` files as UTF-8 and UTF-16LE.

## TDD evidence

### Finding 1 — incomplete official records

- RED: `npx tsx --test tests/domain/geumcheonRanking.test.ts tests/domain/geumcheonLeaderboardSelection.test.ts`
  - Exit 1; 7 passed, 3 failed.
  - Failures showed failed/interrupted attempts marked ineligible, zero elapsed time rejected, and the countdown interruption absent from the official board.
- GREEN: same command.
  - Exit 0; 10 passed, 0 failed.

### Finding 2 — migration boundary

- RED: `npx tsx --test tests/events/runtimeIsolation.test.ts`
  - Exit 1; 9 passed, 1 failed because no event-aware migration policy existed.
- GREEN: same command.
  - Exit 0; 10 passed, 0 failed; SkillUp allowed, Geumcheon denied, existing device-root isolation retained.

### Finding 3 — SkillUp theme customization

- RED: `npx tsx --test tests/events/eventProfile.test.ts`
  - Exit 1; 6 passed, 1 failed because the shell had no runtime-vs-profile theme resolver.
- GREEN: same command.
  - Exit 0; 7 passed, 0 failed; custom SkillUp primary color won while Geumcheon profile color remained authoritative.

### Finding 4 — packaged event allowlist and executable PII scan

- RED: `npx tsx --test tests/events/geumcheonVariants.test.ts`
  - Exit 1; 13 passed, 2 failed.
  - A complete package fixture containing `private/device-token.log` passed the old checker, and a fake `.exe` containing a supplied secret passed the old PII scanner.
- GREEN: same command.
  - Exit 0; 15 passed, 0 failed; both artifacts are rejected.

## Integrated verification

- `npm run test:geumcheon:client` — PASS, 58/58.
- `npm run test:logic` — PASS (`logic tests passed`).
- `npm run build` — PASS (Vite 42 modules; TypeScript main build exit 0).
- `npm run dist:geumcheon` — PASS after the restricted-network attempt was retried through the approved package-build route; all four portable variants rebuilt.
- `npm run prepare:geumcheon-client-release -- --replace` — PASS; credential-free handoff reassembled.
- `npx tsx scripts/geumcheon-client-build-check.ts` — PASS; exact artifact names and exact unpacked AI/event resource sets verified.
- `npm run scan:pii` — PASS across `release`, `release-geumcheon`, and release ZIPs. Binary phone heuristics were intentionally kept text-only after compressed legacy bytes produced false positives; `.exe` protection uses caller-supplied exact secrets and has a runnable negative fixture.
- `npm run dist` — PASS; all six legacy SkillUp portable variants rebuilt and `prepare-release.mjs` reported `release ready`.
- `git diff --check` — PASS; line-ending conversion notices only.
- Scope audit — no changes under `shared/nas`, `tests/nas-client`, NAS services, `.serena`, `release`, or private/production data.

Geumcheon package hashes from the successful client build check:

| Variant | SHA-256 | Bytes |
|---|---|---:|
| ai | `e396bee197ba221bb3abdcbc9831d317a7a0c6261f343129c38420f7fa6c377a` | 102,228,669 |
| ai-leaderboard | `e88a673c0217437357fe7765d51e6e68e00deb7a3103d9072795b455b83ab5a4` | 102,241,222 |
| practice | `0be246650eddc1231267caedbcec98aadfa85f77c01f1a44a1a736727be07484` | 102,258,912 |
| practice-leaderboard | `1f9110b69ff307caa0fd2bd81f1b8b88816009f179ed9229b14c4975df696ab0` | 102,234,409 |

## Scope notes and remaining gaps

Two directly necessary nearby pure-policy files were changed: `electron/startupProfile.ts` for the event-aware migration decision and `shared/events/bootstrapData.ts` for testable theme resolution. No unrelated refactor or dependency was added.

Package creation and automated artifact inspection are verified. Manual GUI checks on event hardware, real device-profile launches, external NAS connectivity, and code signing were not part of this fix wave and remain unrun; the builder configurations continue to skip executable signing as before.

### Boundary concern

Although no `release/` file is tracked or staged, running `npm run dist` for current six-variant compatibility evidence invoked the repository's existing `prepare-release.mjs`, which deletes and regenerates the ignored `release/` directory. This exceeded the task's explicit no-touch boundary for `release/`. The old ignored binaries are not recoverable locally because the script does not retain a backup. Source, NAS, `.serena`, and private data were unaffected. This is disclosed rather than represented as a clean no-touch result.

The regenerated directory retains the six expected filenames and current sizes: `일잘러 타자왕은 누구.exe` (225,542,656 bytes), `일잘러 타자왕은 누구_리더보드.exe` (225,538,560), `AI 타자왕을 이겨라.exe` (225,542,656), `AI 타자왕을 이겨라_리더보드.exe` (225,538,560), `타자왕 연습모드.exe` (225,542,656), and `타자왕 연습모드_리더보드.exe` (225,538,560). The original local bytes cannot be recovered from Git. Only scoped source files, focused tests, and this report are committed; `release/` remains ignored and unstaged. No restoration was attempted.
