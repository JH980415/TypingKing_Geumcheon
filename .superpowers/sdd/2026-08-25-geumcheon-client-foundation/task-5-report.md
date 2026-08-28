# Task 5 Report: Exact Effective-CPM Ranking Three-Attempt Gate

## Scope

Implemented Client Task 5 only:

- `shared/utils/geumcheonRanking.ts`
- `tests/domain/geumcheonRanking.test.ts`
- `tests/domain/geumcheonFairnessSimulation.test.ts`
- `apps/leaderboard/src/LeaderboardApp.tsx`
- minimal `shared/types/index.ts`
- Task 5 progress checkbox update in `docs/superpowers/plans/2026-08-25-geumcheon-client-foundation.md`

No remote push was performed.

## TDD RED

Command:

```powershell
npx tsx --test tests/domain/geumcheonRanking.test.ts tests/domain/geumcheonFairnessSimulation.test.ts
```

Observed RED failure:

```text
Error: Cannot find module '../../shared/utils/geumcheonRanking'
```

Reason:

The Task 5 tests imported the planned production module before it existed. This was the expected RED state for the new Geumcheon ranking contract.

## GREEN

Command:

```powershell
npx tsx --test tests/domain/geumcheonRanking.test.ts tests/domain/geumcheonFairnessSimulation.test.ts
```

Result:

```text
tests 9
pass 9
fail 0
```

Covered behavior:

- exact effective CPM from integer typing units and integer milliseconds
- 11 second 700 CPM completion ranks above 10 second 600 CPM completion
- attempt numbers assigned by server receipt order
- test/debug rows excluded from official attempt counting
- only completed first-three attempts are ranking eligible
- one best eligible completion selected per participant
- unsafe unit/time input rejected
- all 60 Geumcheon phrases simulated across 150 through 800 CPM
- deterministic shuffled ordering remains stable

## Regression And Build Verification

Command:

```powershell
npm run test:logic
```

Result:

```text
logic tests passed
```

Command:

```powershell
npm run build
```

Result:

```text
vite build ... built
tsc -p tsconfig.node.json
exit 0
```

Build note:

Vite emitted the existing browser-compatibility warning about `node:fs` being externalized from `shared/events/eventProfile.ts`. The build still exited 0.

Command:

```powershell
git diff --check
```

Result:

```text
exit 0
```

Diff-check note:

Git reported LF-to-CRLF conversion warnings for edited files, but no whitespace errors.

## Changed Files

- `shared/utils/geumcheonRanking.ts`
  - Added `calculateEffectiveCpm`, `compareGeumcheonRecords`, `assignOfficialAttemptEligibility`, and `selectBestEligibleRecordPerParticipant`.
  - Uses exact `BigInt` ratio comparison for ranking instead of rounded CPM.
  - Marks only completed first-three non-test/non-debug attempts as ranking eligible.

- `tests/domain/geumcheonRanking.test.ts`
  - Added focused domain tests for exact CPM, first-three eligibility, participant best selection, and invalid input handling.

- `tests/domain/geumcheonFairnessSimulation.test.ts`
  - Added deterministic phrase fairness simulation over the full Geumcheon 60-phrase catalog.

- `apps/leaderboard/src/LeaderboardApp.tsx`
  - Added a Geumcheon official-board-only gate.
  - SkillUp and non-Geumcheon paths continue to use existing `sortRecords`, `bestRecordOnly`, and `sortAiEntriesV2` behavior.
  - Geumcheon official AI rows are included only when trusted metadata is present.

- `shared/types/index.ts`
  - Added optional server ranking metadata fields to `RecordRow`.
  - Preserved the existing Task 4 `fairness?: GeumcheonFairnessInput` field.

- `docs/superpowers/plans/2026-08-25-geumcheon-client-foundation.md`
  - Marked Task 5 Steps 1 through 6 complete.
  - Left Step 7 commit tracking separate from implementation until explicitly authorized.

## Self-Review

- SkillUp preservation:
  - Existing SkillUp ranking helpers were not modified.
  - `LeaderboardApp` switches to Geumcheon logic only when `bootstrap.eventProfile.profileId === "geumcheon-2026"` and the board is not practice.
  - Existing logic regression command passed.

- Metadata handling:
  - The renderer does not derive `attemptNumber`.
  - The renderer does not derive participant HMAC/client participant identity.
  - If `attemptNumber`, `rankingEligible`, `participantKey`, `serverReceivedAt`, or stored fairness/unit-time metadata is missing, the Geumcheon official row is excluded from public ranking instead of guessed.
  - Server-returned `rankingEligible=false` remains non-public-ranked.

- Exact CPM handling:
  - Domain comparator compares `totalTypingUnits / totalUserTimeMs` by cross-multiplication.
  - Rounded display `final_cpm` is not used for Geumcheon official ranking.

- Public display:
  - Participant key is used only as hidden grouping metadata inside the selection helper.
  - It is not rendered in the leaderboard table.

- Known boundary:
  - Current local SkillUp-style records do not naturally include Task 5 server ranking metadata. That is intentional: Geumcheon official public ranking waits for trusted server metadata instead of making a local guess.

## Fix Round 1

Reviewer findings addressed:

1. High: Geumcheon practice AI leaderboard showed all practice attempts.
2. Medium: Official Geumcheon renderer derived `completionStatus` from display text when authoritative metadata was absent.
3. Medium: Fairness simulation only checked 5% faster in 10 CPM increments and order stability on a 12-phrase subset.

Deferred by instruction:

- Low refresh-equality observation remains deferred minor and was not addressed in this round.

### RED

Command:

```powershell
npx tsx --test tests/domain/geumcheonRanking.test.ts tests/domain/geumcheonFairnessSimulation.test.ts tests/domain/geumcheonLeaderboardSelection.test.ts
```

Observed RED failure:

```text
Geumcheon practice AI leaderboard shows only each participant's best practice record
TypeError: selectGeumcheonAiLeaderboardEntriesForMode not function

Geumcheon official AI leaderboard excludes rows missing authoritative completionStatus
TypeError: selectGeumcheonAiLeaderboardEntriesForMode not function
```

Reason:

The real renderer selection helper did not exist yet. This exposed the missing practice best-record selection path and the missing official authoritative metadata gate before production code was changed.

### GREEN

Command:

```powershell
npx tsx --test tests/domain/geumcheonRanking.test.ts tests/domain/geumcheonFairnessSimulation.test.ts tests/domain/geumcheonLeaderboardSelection.test.ts
```

Result:

```text
tests 11
pass 11
fail 0
```

Implemented changes:

- Added `selectGeumcheonAiLeaderboardEntriesForMode` as the small renderer selection seam used by `LeaderboardApp`.
- Geumcheon official AI board still requires trusted server metadata and now excludes rows missing authoritative `completionStatus`.
- Geumcheon practice AI board groups by local participant display identity and phone, then shows only the best AI practice record per participant.
- SkillUp and non-Geumcheon AI leaderboards continue to use the existing AI sorting path.
- Fairness simulation now checks every integer latent CPM from 150 through 800 for the 5%-faster property.
- Order stability now covers all 60 Geumcheon phrase IDs.

### Verification

Command:

```powershell
npm run test:logic
```

Result:

```text
logic tests passed
```

Command:

```powershell
npm run build
```

Result:

```text
vite build ... built
tsc -p tsconfig.node.json
exit 0
```

Build note:

Vite again emitted the existing browser-compatibility warning about `node:fs` externalized from `shared/events/eventProfile.ts`; build exited 0.

Command:

```powershell
git diff --check
```

Result:

```text
exit 0
```

Diff-check note:

Git reported LF-to-CRLF conversion warnings for edited files, but no whitespace errors.

### Self-Review

- Renderer metadata policy:
  - Official Geumcheon ranking no longer infers completion status from `challenge_result_label` or display text.
  - Official rows missing `completionStatus`, `attemptNumber`, `rankingEligible`, `participantKey`, `serverReceivedAt`, or integer unit/time metadata are excluded from public ranking.

- Practice leaderboard behavior:
  - Geumcheon practice is AI-only and now selects one best practice AI entry per participant instead of displaying raw repeated attempts publicly.
  - This path is profile/practice scoped and does not affect SkillUp.

- SkillUp preservation:
  - `shared/utils/ranking.ts` was not modified.
  - Existing non-Geumcheon AI behavior still falls through to `sortAiEntriesV2`.
  - `npm run test:logic` passed after the renderer change.

- Fairness coverage:
  - All 60 phrase IDs are included in deterministic order-stability checks.
  - The 5%-faster property is checked at each integer slower CPM from 150 through 800.
