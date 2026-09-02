import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildStorageSettingsPatch,
  formatQueuedRecordFlushMessage,
  OneDriveSettingsPanel,
  storageErrorForDisplay,
  validateStorageAccessForRole
} from "../../apps/shell/src/OneDriveSettingsPanel";
import { formatStageTextPublishSuccess } from "../../apps/typing-game/src/StageTextAdmin";
import * as leaderboardModule from "../../apps/leaderboard/src/LeaderboardApp";
import { formatGameStartReadinessFailure } from "../../apps/typing-game/src/TypingGameApp";

const geumcheonDevices = {
  player: {
    schemaVersion: 1,
    eventProfileId: "geumcheon-2026",
    eventId: "geumcheon-science-festival-2026",
    deviceId: "PC10",
    role: "player",
    apiBaseUrl: "https://127.0.0.1:18443",
    sessions: {
      official: { sessionId: "official-day2-round3", dayNo: 2, roundNo: 3 },
      practice: { sessionId: "practice-session" }
    },
    requestTimeoutMs: 5000,
    retry: { initialDelayMs: 1000, maxDelayMs: 5000 }
  },
  leaderboard: {
    schemaVersion: 1,
    eventProfileId: "geumcheon-2026",
    eventId: "geumcheon-science-festival-2026",
    deviceId: "LEADERBOARD01",
    role: "leaderboard",
    apiBaseUrl: "https://127.0.0.1:18443",
    sessions: {
      official: { sessionId: "official-day2-round3", dayNo: 2, roundNo: 3 },
      practice: { sessionId: "practice-session" }
    },
    requestTimeoutMs: 5000,
    retry: { initialDelayMs: 1000, maxDelayMs: 5000 }
  }
} as const;

function renderSettings(
  profileId: "skillup-2026" | "geumcheon-2026",
  role: "player" | "leaderboard",
  isPractice = false
) {
  const props = profileId === "geumcheon-2026"
    ? {
        role,
        isPractice,
        eventProfileId: profileId,
        deviceProfile: geumcheonDevices[role],
        sessionKind: isPractice ? "practice" : "official",
        gameMode: "ai_challenge"
      }
    : { role, isPractice, eventProfileId: profileId };
  return renderToStaticMarkup(createElement(OneDriveSettingsPanel as never, props as never));
}

function optionValues(html: string): string[] {
  return Array.from(html.matchAll(/<option value="([^"]+)"/g), (match) => match[1]);
}

test("SkillUp player settings preserve the OneDrive UI and PC01 through PC06 policy", () => {
  const html = renderSettings("skillup-2026", "player");

  assert.match(html, /OneDrive 기록 설정/);
  assert.match(html, /OneDrive 루트 폴더/);
  assert.match(html, /폴더 생성 및 검증/);
  assert.deepEqual(optionValues(html), ["PC01", "PC02", "PC03", "PC04", "PC05", "PC06"]);
  assert.doesNotMatch(html, /중앙 기록 API|LEADERBOARD01/);
});

test("SkillUp leaderboard settings preserve the PC07 and PC08 policy", () => {
  const html = renderSettings("skillup-2026", "leaderboard");

  assert.match(html, /OneDrive 기록 설정/);
  assert.deepEqual(optionValues(html), ["PC07", "PC08"]);
  assert.doesNotMatch(html, /LEADERBOARD01|중앙 기록 API/);
});

test("Geumcheon player settings show only the provisioned central API device and session", () => {
  const html = renderSettings("geumcheon-2026", "player");

  assert.match(html, /중앙 기록 API/);
  assert.match(html, /PC10/);
  assert.match(html, /공식 2일차 3회차/);
  assert.match(html, /연결·장치 역할·세션 검증/);
  assert.doesNotMatch(
    html,
    /OneDrive|NAS 운영 루트|폴더 선택|폴더 구조 생성|현재 운영 폴더 열기|구버전 저장 보조 파일 정리|백업/
  );
  assert.deepEqual(optionValues(html), []);
});

test("Geumcheon leaderboard settings show the fixed read-only device without local storage controls", () => {
  const html = renderSettings("geumcheon-2026", "leaderboard");

  assert.match(html, /LEADERBOARD01/);
  assert.match(html, /조회 전용/);
  assert.match(html, /공식 2일차 3회차/);
  assert.match(html, /연결·장치 역할·세션 검증/);
  assert.doesNotMatch(html, /OneDrive|NAS 운영 루트|폴더 선택|폴더 구조 생성|현재 운영 폴더 열기|백업/);
  assert.deepEqual(optionValues(html), []);
});

test("Geumcheon leaderboard disables legacy backup and restore tools while SkillUp keeps them", () => {
  const supportsLegacyTools = (leaderboardModule as Record<string, unknown>).supportsLegacyLeaderboardStorageTools;
  assert.equal(typeof supportsLegacyTools, "function");
  assert.equal((supportsLegacyTools as (profileId: string) => boolean)("geumcheon-2026"), false);
  assert.equal((supportsLegacyTools as (profileId: string) => boolean)("skillup-2026"), true);
});

test("leaderboard storage validation reads records without invoking the writable folder probe", async () => {
  let readAttempts = 0;
  let writeProbeAttempts = 0;
  const result = await validateStorageAccessForRole("leaderboard", {
    validateReadable: async () => {
      readAttempts += 1;
      return { ok: true, data: [] };
    },
    validateWritable: async () => {
      writeProbeAttempts += 1;
      return { ok: true };
    }
  });

  assert.deepEqual(result, { ok: true, mode: "read_only" });
  assert.equal(readAttempts, 1);
  assert.equal(writeProbeAttempts, 0);
});

test("practice settings persist their session kind and constrain the device role", () => {
  const commonForm = {
    oneDriveRoot: "Z:\\typingking",
    recordBaseFolderName: "기록저장",
    dayNo: "2",
    roundNo: "3",
    pcId: "PC10"
  };

  assert.deepEqual(buildStorageSettingsPatch(commonForm, "player", true), {
    syncMode: "onedrive_manual",
    pcRole: "player",
    pcId: "PC10",
    oneDriveRoot: "Z:\\typingking",
    recordBaseFolderName: "기록저장",
    dayNo: 2,
    roundNo: 3,
    isPracticeSession: true
  });
  assert.equal(
    buildStorageSettingsPatch({ ...commonForm, pcId: "PC07" }, "leaderboard", false).pcId,
    "LEADERBOARD01"
  );
});

test("storage results hide internal paths and use NAS operating terms", () => {
  const message = formatQueuedRecordFlushMessage({
    attempted: 2,
    sent: 1,
    failed: 1,
    targetPaths: ["C:\\Users\\operator\\secret\\records"],
    failures: [
      {
        sourceFileName: "queued-secret.json",
        fileName: "record-secret.json",
        recordId: "record-1",
        gameMode: "ai_challenge",
        targetPath: "C:\\Users\\operator\\secret\\records",
        error: "NAS_WRITE_FAILED: C:\\Users\\operator\\secret\\records"
      }
    ]
  });
  const safeError = storageErrorForDisplay(
    "BOOTSTRAP_CREDENTIAL_INVALID: C:\\Users\\operator\\secret\\credential.json",
    "NAS 기록 저장소 연결을 확인해 주세요."
  );
  const actionableError = storageErrorForDisplay(
    "NAS 기록 저장소 연결을 확인한 뒤 다시 시도해 주세요.",
    "관리자에게 문의해 주세요."
  );
  const legacyStorageError = storageErrorForDisplay(
    "OneDrive 루트 폴더를 확인해 주세요.",
    "NAS 운영 루트를 확인해 주세요."
  );
  const missingFileError = storageErrorForDisplay(
    "ENOENT: no such file or directory",
    "NAS 운영 루트를 확인해 주세요."
  );
  const httpError = storageErrorForDisplay(
    "404 Not Found",
    "NAS 운영 루트를 확인해 주세요."
  );
  const nasPathError = storageErrorForDisplay(
    "failed to open /volume1/typingking/records",
    "NAS 운영 루트를 확인해 주세요."
  );
  const publishMessage = formatStageTextPublishSuccess(10);

  for (const copy of [message, safeError, publishMessage]) {
    assert.doesNotMatch(copy, /C:\\Users|secret|BOOTSTRAP_CREDENTIAL_INVALID|NAS_WRITE_FAILED|OneDrive/);
  }
  assert.match(message, /NAS 기록 저장소/);
  assert.equal(safeError, "NAS 기록 저장소 연결을 확인해 주세요.");
  assert.equal(actionableError, "NAS 기록 저장소 연결을 확인한 뒤 다시 시도해 주세요.");
  assert.equal(legacyStorageError, "NAS 운영 루트를 확인해 주세요.");
  assert.equal(missingFileError, "NAS 운영 루트를 확인해 주세요.");
  assert.equal(httpError, "NAS 운영 루트를 확인해 주세요.");
  assert.equal(nasPathError, "NAS 운영 루트를 확인해 주세요.");
  assert.match(publishMessage, /NAS 운영 저장소/);
  assert.match(publishMessage, /10건/);
});

test("leaderboard operation failures never expose raw IPC errors or legacy storage wording", () => {
  for (const operation of ["refresh", "authorize", "edit", "hide", "clear", "export", "backup", "restore"] as const) {
    const message = leaderboardModule.formatLeaderboardOperationError(
      "NAS_WRITE_FAILED: C:\\Users\\operator\\secret\\record-secret.json\n    at internalWrite",
      operation
    );
    assert.doesNotMatch(message, /NAS_WRITE_FAILED|C:\\Users|secret|record-secret\.json|internalWrite|OneDrive/);
  }
});

test("game start readiness keeps safe session guidance and points each profile to its own admin flow", () => {
  const formatForProfile = formatGameStartReadinessFailure as (
    result: Parameters<typeof formatGameStartReadinessFailure>[0],
    profileId: string
  ) => string;
  const sessionGuidance = "2일차 1회차로 변경해 주세요.";
  assert.equal(
    formatForProfile(
      { ok: true, data: { ready: false, message: sessionGuidance } },
      "geumcheon-2026"
    ),
    sessionGuidance
  );

  const message = formatForProfile(
    {
      ok: false,
      error: "GEUMCHEON_NAS_UNAVAILABLE: C:\\Users\\operator\\secret\\credential.json"
    },
    "geumcheon-2026"
  );
  assert.match(message, /중앙 기록 API/);
  assert.match(message, /연결·장치 역할·세션 검증/);
  assert.doesNotMatch(
    message,
    /GEUMCHEON_NAS_UNAVAILABLE|C:\\Users|secret|credential\.json|OneDrive|NAS 운영 루트/
  );

  const legacyMessage = formatForProfile(
    {
      ok: true,
      data: {
        ready: false,
        message:
          "기록 저장 폴더 설정이 완료되지 않았습니다.\n관리자 모드에서 OneDrive 루트 폴더를 선택한 뒤 [폴더 생성 및 검증]을 먼저 실행해 주세요."
      }
    },
    "geumcheon-2026"
  );
  assert.match(legacyMessage, /중앙 기록 API/);
  assert.doesNotMatch(legacyMessage, /OneDrive|NAS 운영 루트/);

  const skillUpMessage = formatForProfile(
    { ok: false, error: "OneDrive root unavailable" },
    "skillup-2026"
  );
  assert.match(skillUpMessage, /OneDrive 루트 폴더/);
  assert.match(skillUpMessage, /폴더 생성 및 검증/);
});
