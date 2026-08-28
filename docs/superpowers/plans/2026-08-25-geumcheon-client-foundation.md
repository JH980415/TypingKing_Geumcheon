# Geumcheon Client Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the four Geumcheon AI-only Windows variants with isolated event/device profiles, versioned random stage texts, approved AI ranges, auditable timing, and fair official ranking.

**Architecture:** Keep the SkillUp profile as the default compatibility path and load Geumcheon as an explicit event profile. Pass validated profile and variant policy through Electron bootstrap instead of hard-coded event strings. Keep phrase rotation and ranking as pure shared modules so they can be simulated before UI wiring.

**Tech Stack:** TypeScript 5.9, Electron 43, React 19, Vite 7, Node `assert`/`node:test` through `tsx`, electron-builder.

**Spec:** `docs/superpowers/specs/2026-08-25-geumcheon-typingking-design.md`

## Global Constraints

- Work only on local branch `geumcheon-2026`; do not push it.
- Preserve default SkillUp behavior when `EVENT_PROFILE` is absent.
- Do not rename, remove, or repurpose existing SkillUp OneDrive settings, queue paths, ranking exports, or six legacy variants; Geumcheon selection must be additive.
- Geumcheon release contains only `ai`, `ai-leaderboard`, `practice`, and `practice-leaderboard`.
- Official AI ranges are 150–200, 200–250, 250–300 CPM; practice ranges are 100–150, 150–200, 200–250 CPM.
- Official ranking uses unrounded effective CPM and only the first three non-test official attempts per participant.
- Do not commit actual device profiles, credentials, records, queues, logs, or generated releases.
- Execute the three plans serially: this client-foundation plan first, then the NAS-sync plan, then the deployment/report plan. This plan owns the initial shared types, Electron bootstrap, renderer profile integration, and client commands; later plans must extend those files without replacing the SkillUp or Geumcheon behavior established here.
- Embed only the public event profile, phrase catalog, title PNG, key visual, and existing common AI assets through the Geumcheon builders. Keep `device-profile.json`, `bootstrap-credentials.json`, tokens, the local administrator PIN, and actual NAS settings outside every EXE and outside `release-geumcheon/`.

## File Structure

- Create `shared/events/types.ts`: event/device/profile contracts.
- Create `shared/events/eventProfile.ts`: strict profile/device validation and policy accessors.
- Create `shared/events/stageTextCatalog.ts`: profile-aware CSV parsing and catalog validation.
- Create `electron/startupProfile.ts`: profile discovery and per-device runtime paths.
- Create `shared/utils/stageTextShuffle.ts`: persistent versioned shuffle bags.
- Create `shared/utils/geumcheonRanking.ts`: exact rational ranking and attempt eligibility.
- Create `events/skillup-2026/event.config.json`: explicit compatibility profile.
- Create `events/geumcheon-2026/event.config.json`: Geumcheon brand, variants, AI ranges, and privacy metadata slots.
- Create `events/geumcheon-2026/stage_texts.csv`: 60 versioned AI phrases.
- Create `events/geumcheon-2026/assets/event-title.png` and `key-visual.png`: provided official raster assets copied without visual alteration.
- Create four `electron-builder.geumcheon-*.yml` files: Geumcheon product metadata.
- Create tests under `tests/events` and `tests/domain`.
- Modify `shared/types/index.ts`, `electron/main.ts`, renderer components, styles, `package.json`, and release scripts only where the profile contract requires it.

---

### Task 1: Event Profile and Device-Isolated Runtime

**Files:**

- Create: `shared/events/types.ts`
- Create: `shared/events/eventProfile.ts`
- Create: `electron/startupProfile.ts`
- Create: `events/skillup-2026/event.config.json`
- Create: `events/geumcheon-2026/event.config.json`
- Create: `tests/events/eventProfile.test.ts`
- Create: `tests/events/runtimeIsolation.test.ts`
- Modify: `shared/types/index.ts`
- Modify: `electron/main.ts`

**Interfaces:**

- Produces `loadEventProfile(filePath)`, `validateDeviceProfile(value)`, `loadDeviceProfile(filePath)`, `variantPolicyFor(profile, variant)`, and `resolveDeviceRuntimeRoot(localAppData, profileId, deviceId)`.
- Later tasks consume `EventProfile`, `EventVariantPolicy`, and `DeviceProfile` without reading raw JSON themselves.

- [ ] **Step 1: Write failing profile and runtime tests**

```ts
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { validateDeviceProfile } from "../../shared/events/eventProfile";
import { resolveDeviceRuntimeRoot } from "../../electron/startupProfile";

const validDeviceProfile = {
  schemaVersion: 1,
  eventProfileId: "geumcheon-2026",
  eventId: "geumcheon-science-festival-2026",
  deviceId: "PC10",
  role: "player",
  apiBaseUrl: "https://records.example.test",
  sessions: {
    official: { sessionId: "day-1-round-1", dayNo: 1, roundNo: 1 },
    practice: { sessionId: "practice" }
  },
  requestTimeoutMs: 5000,
  retry: { initialDelayMs: 2000, maxDelayMs: 60000 }
} as const;

test("isolates Geumcheon runtime by device", () => {
  assert.equal(
    resolveDeviceRuntimeRoot("C:\\Local", "geumcheon-2026", "PC10"),
    path.join("C:\\Local", "ThePMD", "TypingKing2026", "geumcheon-2026", "PC10")
  );
});

test("rejects an insecure API URL", () => {
  assert.throws(
    () => validateDeviceProfile({ ...validDeviceProfile, apiBaseUrl: "http://records.example.test" }),
    /HTTPS/
  );
});
```

- [ ] **Step 2: Run the focused tests and verify missing-module failure**

Run: `npx tsx --test tests/events/eventProfile.test.ts tests/events/runtimeIsolation.test.ts`

Expected: FAIL because `shared/events/eventProfile.ts` and `electron/startupProfile.ts` do not exist.

- [ ] **Step 3: Implement strict contracts and validators**

```ts
export type EventProfileId = "skillup-2026" | "geumcheon-2026";
export type SessionKind = "official" | "practice";

export type EventVariantPolicy = {
  variant: AppVariant;
  enabled: boolean;
  role: "player" | "leaderboard";
  sessionKind: SessionKind;
  gameModes: readonly ("normal" | "ai_challenge")[];
  displayName: string;
  windowTitle: string;
  artifactName: string;
};

export type EventProfile = {
  schemaVersion: 1;
  profileId: EventProfileId;
  eventId: string;
  nasEventId: string;
  eventName: string;
  eventNameEn: string;
  slogan: string;
  gameName: string;
  runtimeNamespace: string;
  stageTextCatalogVersion: string;
  privacy: { noticeVersion: string | null; retentionExpiresAt: string | null };
  theme: ThemeConfig;
  assets: {
    eventTitle: string;
    pageBackground: string;
    aiBossTyping: string;
    aiBossVictory: string;
    aiBossDefeat: string;
    vsBadge: string;
    stageBadges: readonly [string, string, string];
  };
  variants: Record<AppVariant, EventVariantPolicy>;
  aiChallenge: Record<SessionKind, AiChallengeConfig>;
};

export type DeviceProfile = {
  schemaVersion: 1;
  eventProfileId: EventProfileId;
  eventId: string;
  deviceId: `PC0${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}` | "PC10" | "LEADERBOARD01";
  role: "player" | "leaderboard";
  apiBaseUrl: string;
  sessions: {
    official: { sessionId: string; dayNo: number; roundNo: number };
    practice: { sessionId: string };
  };
  requestTimeoutMs: number;
  retry: { initialDelayMs: number; maxDelayMs: number };
};

export function loadEventProfile(filePath: string): EventProfile;
export function validateDeviceProfile(value: unknown): DeviceProfile;
export function loadDeviceProfile(filePath: string): DeviceProfile;
export function variantPolicyFor(profile: EventProfile, variant: AppVariant): EventVariantPolicy;
export function resolveDeviceRuntimeRoot(
  localAppData: string,
  profileId: EventProfileId,
  deviceId: DeviceProfile["deviceId"]
): string;
```

Validation must reject unknown keys, an event/device mismatch, invalid PC IDs, every non-HTTPS API URL, URL credentials/query/hash, missing sessions, nonpositive timeouts, and retry ranges other than `initialDelayMs <= maxDelayMs`. Tests that need a local HTTP server inject a transport directly and never weaken the persisted profile validator.

- [ ] **Step 4: Implement startup profile discovery**

Use `EVENT_PROFILE` in development and builder-stamped `extraMetadata.typingKingEventProfile` in packaged builds. Load packaged `device-profile.json` next to the portable executable. When neither event selector exists, return the SkillUp compatibility profile and existing runtime root. For Geumcheon, call `app.setPath("userData", path.join(runtimeRoot, "electron-user-data"))` before creating a window. A Geumcheon build without a valid device profile must stop before creating runtime files or a window. Preserve `TYPINGKING_RUNTIME_ROOT` as an explicit development/test override only.

- [ ] **Step 5: Run focused and regression tests**

Run: `npx tsx --test tests/events/eventProfile.test.ts tests/events/runtimeIsolation.test.ts`

Expected: PASS for profile validation and PC01/PC10/LEADERBOARD01 isolation.

Run: `npm run test:logic`

Expected: existing SkillUp logic PASS.

- [ ] **Step 6: Commit**

```text
git add shared/events/types.ts shared/events/eventProfile.ts electron/startupProfile.ts events/skillup-2026/event.config.json events/geumcheon-2026/event.config.json tests/events/eventProfile.test.ts tests/events/runtimeIsolation.test.ts shared/types/index.ts electron/main.ts
git commit -m "feat: add event profiles and isolated device runtime"
```

---

### Task 2: Four Geumcheon AI Variants and Brand Bootstrap

**Files:**

- Create: `events/geumcheon-2026/assets/event-title.png`
- Create: `events/geumcheon-2026/assets/key-visual.png`
- Create: `electron-builder.geumcheon-ai.yml`
- Create: `electron-builder.geumcheon-ai-leaderboard.yml`
- Create: `electron-builder.geumcheon-practice.yml`
- Create: `electron-builder.geumcheon-practice-leaderboard.yml`
- Create: `shared/events/bootstrapData.ts`
- Create: `tests/events/geumcheonVariants.test.ts`
- Modify: `shared/types/index.ts`
- Modify: `electron/main.ts`
- Modify: `apps/shell/src/main.tsx`
- Modify: `apps/typing-game/src/TypingGameApp.tsx`
- Modify: `apps/typing-game/src/AIChallengeGame.tsx`
- Modify: `apps/leaderboard/src/LeaderboardApp.tsx`
- Modify: `apps/shell/src/styles.css`
- Modify: `package.json`

**Interfaces:**

- Consumes `EventProfile` and `EventVariantPolicy` from Task 1.
- Adds `eventProfile`, `variantPolicy`, and optional `deviceProfile` to `BootstrapData`.
- Produces `createBootstrapData(input)` as a pure boundary that derives `variantPolicy` from the validated event profile and selected variant; `electron/main.ts` must use this boundary for the renderer payload.

```ts
export type BootstrapData = {
  config: AppConfig;
  assetBaseUrl: string;
  notices: string[];
  mode: AppMode;
  variant: AppVariant;
  eventProfile: EventProfile;
  variantPolicy: EventVariantPolicy;
  deviceProfile?: DeviceProfile;
};
```

- [ ] **Step 1: Write failing variant-policy tests**

```ts
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createBootstrapData } from "../../shared/events/bootstrapData";
import { loadEventProfile, variantPolicyFor } from "../../shared/events/eventProfile";

const geumcheonProfile = loadEventProfile(
  path.resolve("events/geumcheon-2026/event.config.json")
);

const deviceProfile = {
  schemaVersion: 1,
  eventProfileId: "geumcheon-2026",
  eventId: "geumcheon-science-festival-2026",
  deviceId: "PC01",
  role: "player",
  apiBaseUrl: "https://records.example.test",
  sessions: {
    official: { sessionId: "day-1-round-1", dayNo: 1, roundNo: 1 },
    practice: { sessionId: "practice" }
  },
  requestTimeoutMs: 5000,
  retry: { initialDelayMs: 2000, maxDelayMs: 60000 }
} as const;

test("adds the validated Geumcheon profile policy and device to renderer bootstrap", () => {
  const bootstrap = createBootstrapData({
    config: {} as never,
    assetBaseUrl: "file:///assets",
    notices: [],
    mode: "game",
    variant: "ai",
    eventProfile: geumcheonProfile,
    deviceProfile
  });
  assert.equal(bootstrap.eventProfile.profileId, "geumcheon-2026");
  assert.equal(bootstrap.variantPolicy.variant, "ai");
  assert.equal(bootstrap.deviceProfile?.deviceId, "PC01");
});

for (const variant of ["ai", "ai-leaderboard", "practice", "practice-leaderboard"] as const) {
  test(`${variant} is enabled and AI-only`, () => {
    const policy = variantPolicyFor(geumcheonProfile, variant);
    assert.equal(policy.enabled, true);
    assert.deepEqual(policy.gameModes, ["ai_challenge"]);
  });
}

test("normal variants are disabled", () => {
  assert.equal(variantPolicyFor(geumcheonProfile, "typing").enabled, false);
  assert.equal(variantPolicyFor(geumcheonProfile, "typing-leaderboard").enabled, false);
});
```

- [ ] **Step 2: Run the test and verify it fails on the missing bootstrap boundary**

Run: `npx tsx --test tests/events/geumcheonVariants.test.ts`

Expected: FAIL because `shared/events/bootstrapData.ts` and the event/device fields on `BootstrapData` do not exist yet. The policy-only assertions may already pass after Task 1; the new bootstrap-behavior test is the mandatory RED.

- [ ] **Step 3: Add exact product metadata**

Use these artifact names:

```text
G-Science AI 타자왕.exe
G-Science AI 타자왕_리더보드.exe
G-Science AI 타자왕_연습모드.exe
G-Science AI 타자왕_연습모드_리더보드.exe
```

Each builder must set a distinct `com.thepmd.gscience.typingking.*` app ID, `extraMetadata.typingKingEventProfile: geumcheon-2026`, output under `release-build/geumcheon/<variant>/`, and preserve unsigned-build disclosure.

```json
{
  "scripts": {
    "dist:geumcheon:ai": "electron-builder --config electron-builder.geumcheon-ai.yml --publish=never",
    "dist:geumcheon:ai-leaderboard": "electron-builder --config electron-builder.geumcheon-ai-leaderboard.yml --publish=never",
    "dist:geumcheon:practice": "electron-builder --config electron-builder.geumcheon-practice.yml --publish=never",
    "dist:geumcheon:practice-leaderboard": "electron-builder --config electron-builder.geumcheon-practice-leaderboard.yml --publish=never",
    "dist:geumcheon": "npm run build && npm run dist:geumcheon:ai && npm run dist:geumcheon:ai-leaderboard && npm run dist:geumcheon:practice && npm run dist:geumcheon:practice-leaderboard"
  }
}
```

- [ ] **Step 4: Replace event hard-coding with bootstrap values**

The renderer must obtain titles, labels, asset paths, palette, and allowed game modes from `eventProfile`/`variantPolicy`. Keep existing text as the SkillUp profile values. For Geumcheon practice, bypass the normal/AI chooser and enter AI practice only. In `electron/main.ts`, derive role, session kind, record mode, window title, icon, and application user-model ID from the validated policy rather than executable-name assumptions.

- [ ] **Step 5: Apply the approved visual tokens**

Copy `<DOWNLOADS_DIR>/금천과학축제2026_타이틀_260820.png` byte-for-byte to `events/geumcheon-2026/assets/event-title.png`. Copy the provided final key visual byte-for-byte to `events/geumcheon-2026/assets/key-visual.png`; verify each destination SHA-256 equals its source before UI work. Set CSS variables to `#552D8D`, `#3F1556`, `#C40080`, `#00B3EC`, `#FED900`, and `#FFFFFF`. Use both images responsively without stretching or recoloring; retain legible game panels at 1366×768 and 1920×1080.

- [ ] **Step 6: Run tests and renderer build**

Run: `npx tsx --test tests/events/geumcheonVariants.test.ts`

Expected: PASS for four enabled variants and two disabled normal variants.

Run: `npm run build`

Expected: Vite and Electron TypeScript builds PASS.

- [ ] **Step 7: Commit**

```text
git add events/geumcheon-2026/assets/event-title.png events/geumcheon-2026/assets/key-visual.png electron-builder.geumcheon-ai.yml electron-builder.geumcheon-ai-leaderboard.yml electron-builder.geumcheon-practice.yml electron-builder.geumcheon-practice-leaderboard.yml shared/events/bootstrapData.ts tests/events/geumcheonVariants.test.ts shared/types/index.ts electron/main.ts apps/shell/src/main.tsx apps/typing-game/src/TypingGameApp.tsx apps/typing-game/src/AIChallengeGame.tsx apps/leaderboard/src/LeaderboardApp.tsx apps/shell/src/styles.css package.json
git commit -m "feat: add Geumcheon AI application variants"
```

---

### Task 3: Versioned 60-Phrase Catalog and Shuffle Bags

**Files:**

- Create: `events/geumcheon-2026/stage_texts.csv`
- Create: `shared/events/stageTextCatalog.ts`
- Create: `shared/utils/stageTextShuffle.ts`
- Create: `tests/domain/geumcheonStageTexts.test.ts`
- Create: `tests/domain/stageTextShuffle.test.ts`
- Modify: `shared/types/index.ts`
- Modify: `shared/csv/fileStore.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `apps/shell/src/global.d.ts`
- Modify: `apps/typing-game/src/TypingGameApp.tsx`

**Interfaces:**

- Produces `parseStageTextCatalog`, `validateStageTextCatalog`, `stageTextBagKey`, and `drawStageTextFromBag`.
- Extends `StageText` with `catalog_version` while accepting legacy SkillUp CSV rows without that column.
- Produces main-process IPC `stage:draw` so Geumcheon never trusts renderer-only `localStorage` for official bag state.

- [ ] **Step 1: Write failing catalog and shuffle tests**

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  parseStageTextCatalog,
  validateStageTextCatalog
} from "../../shared/events/stageTextCatalog";
import {
  drawStageTextFromBag,
  stageTextBagKey,
  type StageTextShuffleState
} from "../../shared/utils/stageTextShuffle";

test("contains exactly twenty phrases per stage", () => {
  const rows = parseStageTextCatalog(
    fs.readFileSync("events/geumcheon-2026/stage_texts.csv", "utf8")
  );
  validateStageTextCatalog(rows, {
    expectedVersion: "geumcheon-draft-20260825-v1",
    expectedMode: "ai_challenge",
    expectedRowsPerStage: 20
  });
  const countByStage = Object.fromEntries(
    ["1", "2", "3"].map((stage) => [
      stage,
      rows.filter((row) => row.stage_number === stage).length
    ])
  );
  assert.equal(rows.length, 60);
  assert.deepEqual(countByStage, { "1": 20, "2": 20, "3": 20 });
});

test("does not repeat before a bag is exhausted", () => {
  const rows = parseStageTextCatalog(
    fs.readFileSync("events/geumcheon-2026/stage_texts.csv", "utf8")
  ).filter((row) => row.stage_number === "1");
  const key = stageTextBagKey({
    eventId: "geumcheon-science-festival-2026",
    catalogVersion: "geumcheon-draft-20260825-v1",
    sessionKind: "official",
    gameMode: "ai_challenge",
    stageNumber: 1
  });
  let state: StageTextShuffleState = { schemaVersion: 2, bags: {} };
  const drawn: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    const result = drawStageTextFromBag(rows, key, state, () => 0.37);
    drawn.push(result.selected.id);
    state = result.nextState;
  }
  assert.equal(new Set(drawn).size, 20);
});
```

- [ ] **Step 2: Run tests and verify catalog/module failure**

Run: `npx tsx --test tests/domain/geumcheonStageTexts.test.ts tests/domain/stageTextShuffle.test.ts`

Expected: FAIL because the catalog and shuffle module do not exist.

- [ ] **Step 3: Author and validate the catalog**

Use IDs `gsc26-ai-s1-001` through `gsc26-ai-s3-020`, catalog version `geumcheon-draft-20260825-v1`, game mode `ai_challenge`, and 20 active rows per stage. Content must use approved science-plan topics, contain no duplicate body or youth-harmful terms, and match `^[가-힣ㄱ-ㅎㅏ-ㅣ0-9 !,.~?\\r\\n]+$`; spell English abbreviations such as AI and VR as Korean words in the phrases.

```ts
export function parseStageTextCatalog(csvText: string): StageText[];
export function validateStageTextCatalog(
  rows: readonly StageText[],
  rules: {
    expectedVersion: string;
    expectedMode: "ai_challenge";
    expectedRowsPerStage: 20;
  }
): void;
```

- [ ] **Step 4: Implement persistent shuffle bags**

```ts
export function drawStageTextFromBag(
  rows: readonly StageText[],
  key: string,
  state: StageTextShuffleState,
  random: () => number = Math.random
): { selected: StageText; nextState: StageTextShuffleState };
```

Separate bags by event, catalog version, official/practice session, game mode, and stage. On refill, swap the first item when it equals `lastSelectedId`.

- [ ] **Step 5: Wire the bag into game start and persist state**

Store non-sensitive bag state atomically at `<device-runtime>/state/stage-text-shuffle.json`. Register `stage:draw` in `electron/main.ts`, expose only `drawStageTexts(input)` through preload, and return three `StageTextSelection` values after the main process has persisted the next state. Record selected IDs and catalog version with each attempt. Keep the current localStorage rotation path for SkillUp until its existing logic tests prove an intentional migration.

```ts
export type DrawStageTextsInput = {
  sessionKind: "official" | "practice";
  gameMode: "ai_challenge";
};
export type StageTextSelection = {
  id: string;
  catalogVersion: string;
  stageNumber: 1 | 2 | 3;
  text: string;
};
export type DrawStageTextsResult = {
  catalogVersion: string;
  selections: readonly [StageTextSelection, StageTextSelection, StageTextSelection];
};
```

- [ ] **Step 6: Run focused and logic tests**

Run: `npx tsx --test tests/domain/geumcheonStageTexts.test.ts tests/domain/stageTextShuffle.test.ts`

Expected: PASS for 60 rows, allowed content, no repeat, refill, and official/practice separation.

- [ ] **Step 7: Commit**

```text
git add events/geumcheon-2026/stage_texts.csv shared/events/stageTextCatalog.ts shared/utils/stageTextShuffle.ts tests/domain/geumcheonStageTexts.test.ts tests/domain/stageTextShuffle.test.ts shared/types/index.ts shared/csv/fileStore.ts electron/main.ts electron/preload.ts apps/shell/src/global.d.ts apps/typing-game/src/TypingGameApp.tsx
git commit -m "feat: add versioned Geumcheon stage text shuffle bags"
```

---

### Task 4: Session AI Speeds and Auditable Timing Metadata

**Files:**

- Create: `tests/domain/geumcheonTiming.test.ts`
- Modify: `shared/events/eventProfile.ts`
- Modify: `shared/types/index.ts`
- Modify: `shared/utils/typing.ts`
- Modify: `apps/typing-game/src/TypingGameApp.tsx`
- Modify: `apps/typing-game/src/AIChallengeGame.tsx`
- Modify: `shared/csv/fileStore.ts`

**Interfaces:**

- Produces `GeumcheonFairnessInput` in `SaveRecordInput.fairness`.
- The NAS plan consumes exact text ID, catalog version, target/typed text, user time, AI CPM, and outcome.

- [ ] **Step 1: Write failing AI-range and timer tests**

```ts
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  loadEventProfile,
  resolveAiChallengeConfig
} from "../../shared/events/eventProfile";
import { calculateTotalUserTimeMs } from "../../shared/utils/typing";

const profile = loadEventProfile(
  path.resolve("events/geumcheon-2026/event.config.json")
);

test("uses official and practice AI ranges from the event profile", () => {
  assert.deepEqual(resolveAiChallengeConfig(profile, "official").stageSpeedRanges, {
    stage1: { min: 150, max: 200 },
    stage2: { min: 200, max: 250 },
    stage3: { min: 250, max: 300 }
  });
  assert.deepEqual(resolveAiChallengeConfig(profile, "practice").stageSpeedRanges, {
    stage1: { min: 100, max: 150 },
    stage2: { min: 150, max: 200 },
    stage3: { min: 200, max: 250 }
  });
});

test("sums only monotonic per-stage user time", () => {
  assert.equal(calculateTotalUserTimeMs([1200, 2300, 3400]), 6900);
});
```

- [ ] **Step 2: Run tests and verify failure on current SkillUp ranges**

Run: `npx tsx --test tests/domain/geumcheonTiming.test.ts`

Expected: FAIL because the current default ranges are 300–500 CPM and no fairness payload exists.

- [ ] **Step 3: Implement profile-driven AI plans and monotonic timing**

Start user timing from `performance.now()` after countdown when input becomes active. End on exact completion, AI win, or confirmed interruption, and round the single measured difference once to an integer millisecond for storage. Include IME composition, correction, idle time, focus loss, and the control-confirmation interval. Exclude countdown and between-stage animation. Remove the current `stageStartRef.current += pausedMs` adjustment for Geumcheon official play; retain it only on the SkillUp compatibility path if its existing behavior depends on it.

```ts
export function calculateTotalUserTimeMs(stageTimesMs: readonly number[]): number {
  if (stageTimesMs.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Invalid user time");
  }
  return stageTimesMs.reduce((sum, value) => sum + value, 0);
}
```

- [ ] **Step 4: Persist the exact fairness payload**

```ts
export type GeumcheonStageResultInput = {
  stageNumber: 1 | 2 | 3;
  textId: string;
  catalogVersion: string;
  targetText: string;
  typedText: string;
  userTimeMs: number;
  typingUnits: number;
  aiCpm: number;
  result: "USER_WIN" | "AI_WIN" | "INTERRUPTED";
};

export type GeumcheonFairnessInput = {
  catalogVersion: string;
  totalUserTimeMs: number;
  stages: readonly GeumcheonStageResultInput[];
};

export type SaveRecordInput = {
  // Retain every current SkillUp field unchanged.
  fairness?: GeumcheonFairnessInput;
};
```

The fairness array contains one to three consecutive stage entries. Completed records require stages 1, 2, and 3; failed/interrupted records retain every completed stage plus the partial terminal stage. `typedText` must be the exact text present when timing stopped. Debug/test attempts remain marked and excluded from official eligibility. Client `typingUnits` is diagnostic; the NAS recalculates it from `typedText` and does not trust it.

- [ ] **Step 5: Run focused tests and build**

Run: `npx tsx --test tests/domain/geumcheonTiming.test.ts`

Expected: PASS for official/practice ranges and timing boundaries.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```text
git add tests/domain/geumcheonTiming.test.ts shared/events/eventProfile.ts shared/types/index.ts shared/utils/typing.ts apps/typing-game/src/TypingGameApp.tsx apps/typing-game/src/AIChallengeGame.tsx shared/csv/fileStore.ts
git commit -m "feat: record fair AI challenge timing metadata"
```

---

### Task 5: Exact Effective-CPM Ranking and Three-Attempt Gate

**Files:**

- Create: `shared/utils/geumcheonRanking.ts`
- Create: `tests/domain/geumcheonRanking.test.ts`
- Create: `tests/domain/geumcheonFairnessSimulation.test.ts`
- Modify: `apps/leaderboard/src/LeaderboardApp.tsx`

**Interfaces:**

- Produces `calculateEffectiveCpm`, `compareGeumcheonRecords`, `assignOfficialAttemptEligibility`, and `selectBestEligibleRecordPerParticipant`.
- Keeps existing `compareRecords`, `sortRecords`, and `bestRecordOnly` unchanged for SkillUp; the leaderboard selects Geumcheon logic only when `profileId === "geumcheon-2026"`.

```ts
export type OfficialAttemptCandidate = {
  recordId: string;
  participantKey: string;
  serverReceivedAt: string;
  completedAt: string;
  completionStatus: "completed" | "failed" | "interrupted";
  completedStages: number;
  progressPercent: number;
  totalTypingUnits: number;
  totalUserTimeMs: number;
  isTest: boolean;
  isDebug: boolean;
};

export type AttemptEligibility = {
  attemptNumber: number | null;
  rankingEligible: boolean;
};

export function calculateEffectiveCpm(totalTypingUnits: number, totalUserTimeMs: number): number;
export function compareGeumcheonRecords(a: OfficialAttemptCandidate, b: OfficialAttemptCandidate): number;
export function assignOfficialAttemptEligibility<T extends OfficialAttemptCandidate>(
  records: readonly T[],
  limit?: number
): Array<T & AttemptEligibility>;
export function selectBestEligibleRecordPerParticipant<
  T extends OfficialAttemptCandidate & AttemptEligibility
>(records: readonly T[]): T[];
```

- [x] **Step 1: Write the failing dispute and eligibility tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  assignOfficialAttemptEligibility,
  compareGeumcheonRecords,
  type OfficialAttemptCandidate
} from "../../shared/utils/geumcheonRanking";

function completed(
  overrides: Partial<OfficialAttemptCandidate> = {}
): OfficialAttemptCandidate {
  return {
    recordId: "gsc26-pc01-00000000-0000-4000-8000-000000000001",
    participantKey: "participant-hmac",
    serverReceivedAt: "2026-09-18T01:00:00.000Z",
    completedAt: "2026-09-18T01:00:00.000Z",
    completionStatus: "completed",
    completedStages: 3,
    progressPercent: 100,
    totalTypingUnits: 300,
    totalUserTimeMs: 30000,
    isTest: false,
    isDebug: false,
    ...overrides
  };
}

test("ranks 700 CPM over a shorter 600 CPM record", () => {
  const faster = completed({ totalTypingUnits: 385, totalUserTimeMs: 33000 });
  const shorter = completed({
    recordId: "gsc26-pc01-00000000-0000-4000-8000-000000000002",
    totalTypingUnits: 300,
    totalUserTimeMs: 30000
  });
  assert.ok(compareGeumcheonRecords(faster, shorter) < 0);
});

test("excludes the fourth official attempt", () => {
  const rows = assignOfficialAttemptEligibility(
    [1, 2, 3, 4].map((attempt) => completed({
      recordId: `gsc26-pc01-00000000-0000-4000-8000-${String(attempt).padStart(12, "0")}`,
      serverReceivedAt: `2026-09-18T01:00:0${attempt}.000Z`
    }))
  );
  assert.deepEqual(rows.map((row) => row.rankingEligible), [true, true, true, false]);
});
```

- [x] **Step 2: Run tests and verify failure**

Run: `npx tsx --test tests/domain/geumcheonRanking.test.ts tests/domain/geumcheonFairnessSimulation.test.ts`

Expected: FAIL because the Geumcheon comparator does not exist.

- [x] **Step 3: Implement exact rational comparison**

Validate all unit/time inputs as nonnegative safe integers and require positive time before converting them to `BigInt`. Compare `unitsA * timeB` against `unitsB * timeA`; do not sort on rounded display CPM. Rank completed attempts first. Among non-completed attempts, compare reached stage, progress, and the same exact CPM ratio; place interrupted attempts after ordinary failures. Apply final tie-breakers: more units, less user time, earlier completed time, lexical record ID.

- [x] **Step 4: Implement first-three eligibility**

Group by server-generated participant key, exclude test/debug rows from attempt counting, order by `serverReceivedAt` then `recordId`, mark only the first three, and select one best eligible record per participant. Never expose the participant key in display rows.

- [x] **Step 5: Run the required fairness simulation**

Simulate all 60 phrase unit counts at each integer latent speed from 150 through 800 CPM. For each phrase, derive ideal elapsed time as `typingUnits * 60000 / latentCpm`, then compare with exact rational logic. Exercise deterministic seeded orders, while separately asserting that every one of the 60 phrase IDs produces the same result regardless of its position. Assert same-speed deviation is at most 1 display CPM, every 5%-faster exact typist remains ahead, the 600/700 dispute case passes, and ordering a fixed record set differently cannot change its sorted record IDs.

```ts
for (let latentCpm = 150; latentCpm <= 800; latentCpm += 1) {
  for (const phrase of allSixtyPhrases) {
    const units = countConvertedTypingUnits(phrase.text);
    const elapsedMs = Math.max(1, Math.round((units * 60000) / latentCpm));
    assert.ok(Math.abs(calculateEffectiveCpm(units, elapsedMs) - latentCpm) <= 1);
  }
}
```

Run: `npx tsx --test tests/domain/geumcheonRanking.test.ts tests/domain/geumcheonFairnessSimulation.test.ts`

Expected: all deterministic fairness gates PASS. The five-person phrase difficulty pilot remains a separately reported field/content gate.

- [x] **Step 6: Wire the comparator to Geumcheon leaderboards**

Official board shows the best of the first three eligible attempts; practice board shows the best practice record. Display all participant rows with vertical scrolling and keep all raw attempts outside the public view. Consume server-returned `attemptNumber` and `rankingEligible`; do not derive a participant HMAC or authoritative attempt number in the renderer.

- [ ] **Step 7: Commit**

```text
git add shared/utils/geumcheonRanking.ts tests/domain/geumcheonRanking.test.ts tests/domain/geumcheonFairnessSimulation.test.ts apps/leaderboard/src/LeaderboardApp.tsx
git commit -m "feat: add fair Geumcheon ranking eligibility"
```

---

### Task 6: Client Regression and Four-Variant Build Gate

**Files:**

- Modify: `package.json`
- Create: `scripts/prepare-geumcheon-client-release.mjs`
- Create: `scripts/geumcheon-client-build-check.ts`

**Interfaces:**

- Produces a credential-free `release-geumcheon/` assembled from the four isolated builder outputs and a machine-readable client verification summary consumed by the deployment/report plan.

```ts
export type GeumcheonClientBuildSummary = {
  schemaVersion: 1;
  eventProfileId: "geumcheon-2026";
  checkedAt: string;
  artifacts: Array<{ variant: AppVariant; fileName: string; sha256: string; bytes: number }>;
  checks: {
    exactArtifactNames: true;
    profileIncluded: true;
    assetsIncluded: true;
    normalArtifactAbsent: true;
  };
};
```

- [ ] **Step 1: Add a failing build-output check**

Add `test:geumcheon:client` with the eight explicit test paths created in Tasks 1–5, avoiding shell-dependent glob expansion. Assert the Geumcheon build configuration emits exactly the four approved artifact names, contains the event profile and two approved raster assets, and contains no normal typing artifact.

```json
{
  "scripts": {
    "test:geumcheon:client": "tsx --test tests/events/eventProfile.test.ts tests/events/runtimeIsolation.test.ts tests/events/geumcheonVariants.test.ts tests/domain/geumcheonStageTexts.test.ts tests/domain/stageTextShuffle.test.ts tests/domain/geumcheonTiming.test.ts tests/domain/geumcheonRanking.test.ts tests/domain/geumcheonFairnessSimulation.test.ts"
  }
}
```

Implement the build check with an exact allow-list; fail on a missing artifact, an extra EXE, a zero-byte asset, or an executable whose name is not listed.

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const expected = new Map([
  ["ai", "G-Science AI 타자왕.exe"],
  ["ai-leaderboard", "G-Science AI 타자왕_리더보드.exe"],
  ["practice", "G-Science AI 타자왕_연습모드.exe"],
  ["practice-leaderboard", "G-Science AI 타자왕_연습모드_리더보드.exe"]
] as const);
for (const fileName of expected.values()) {
  assert.equal(fs.existsSync(path.join("release-geumcheon", fileName)), true);
}
```

- [ ] **Step 2: Run the check before packaging**

Run: `npx tsx scripts/geumcheon-client-build-check.ts`

Expected: FAIL because the credential-free `release-geumcheon/` handoff has not been assembled.

- [ ] **Step 3: Build the four variants**

Run: `npm run dist:geumcheon`

Expected: exactly one approved portable EXE in each of `release-build/geumcheon/ai/`, `ai-leaderboard/`, `practice/`, and `practice-leaderboard/`. This task does not create the final USB tree; the deployment plan later assembles `deployment-output/geumcheon-2026/usb-master/`.

- [ ] **Step 4: Assemble the credential-free deployment handoff**

Implement `prepare-geumcheon-client-release.mjs` with an exact allow-list. It must read the four isolated builder outputs, create a generated-output sentinel, atomically assemble `release-geumcheon/`, include only the four approved EXEs plus public event resources required at runtime, and refuse to copy any device profile, bootstrap credentials, token, PIN, record, queue, log, or actual NAS setting. A `--replace` option may replace only a directory containing the exact generated-output sentinel.

Run: `npm run prepare:geumcheon-client-release`

Expected: `release-geumcheon/` contains the four approved executables and public runtime resources, contains no credentials or per-device configuration, and is ready for the deployment plan to consume.

- [ ] **Step 5: Run complete client gates**

Run: `npm run test:logic`

Run: `npm run test:geumcheon:client`

Run: `npx tsx scripts/e2e-multi-pc-check.ts`

Run: `npm run build`

Run: `npm run scan:pii`

Run: `npm audit --audit-level=high`

Expected: all PASS or zero high/critical audit findings. Existing SkillUp OneDrive/multi-PC assertions must remain green; do not update their expected values merely to accommodate Geumcheon.

- [ ] **Step 6: Run the build-output check again**

Run: `npx tsx scripts/geumcheon-client-build-check.ts`

Expected: PASS and summary written under ignored `test_artifacts/geumcheon-client/`.

- [ ] **Step 7: Commit**

```text
git add package.json scripts/prepare-geumcheon-client-release.mjs scripts/geumcheon-client-build-check.ts
git commit -m "test: verify Geumcheon client foundation"
```
