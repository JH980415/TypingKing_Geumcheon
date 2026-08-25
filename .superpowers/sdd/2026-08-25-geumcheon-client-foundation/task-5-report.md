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
