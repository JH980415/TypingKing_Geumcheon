import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  ApiResult,
  BootstrapData,
  EventProfileId,
  GameStartReadiness,
  RecordRow,
  SaveRecordInput,
  StageText,
  StageTextSelection
} from "../../../shared/types";
import { daysInMonth, formatBirthdate, isValidBirthdate } from "../../../shared/utils/date";
import { buildPhoneFull, onlyDigits, validatePhoneParts } from "../../../shared/utils/masking";
import { bestRecordOnly, sortRecords } from "../../../shared/utils/ranking";
import {
  calculateAccuracy,
  calculateCurrentCpm,
  calculateFinalCpm,
  finalizeUserStageTimeMs,
  applyTargetLineBreaks,
  countConvertedTypingUnits,
  countMatchingPrefixTypingUnits,
  countTypeableChars,
  isExactMatch,
  isLineProgressAllowed,
  resumeStageTimerAfterControl,
  splitChars,
  splitTypeableChars,
  stripDisplayLineBreaks
} from "../../../shared/utils/typing";
import {
  parseStageTextRotationState,
  pickRotatingStageText,
  STAGE_TEXT_ROTATION_STORAGE_KEY
} from "../../../shared/utils/stageTextRotation";
import { mergeRuntimeConfigWithEventProfile } from "../../../shared/events/bootstrapData";
import { resolveEventAssetUrl } from "../../../shared/events/types";
import { AIChallengeGame } from "./AIChallengeGame";
import { StageTextAdmin } from "./StageTextAdmin";
import { storageErrorForDisplay } from "../../shell/src/OneDriveSettingsPanel";

type Props = {
  bootstrap: BootstrapData;
};

type GameMode = "normal" | "ai_challenge";
type DebugModeType = "" | "normal_typing_debug" | "ai_challenge_debug";
type GameControlAction = "home" | "retry";

const GEUMCHEON_GAME_START_STORAGE_FALLBACK =
  "중앙 기록 API 준비가 완료되지 않았습니다.\n관리자 모드에서 [연결·장치 역할·세션 검증]을 실행해 주세요.";
const SKILLUP_GAME_START_STORAGE_FALLBACK =
  "기록 저장 폴더 설정이 완료되지 않았습니다.\n관리자 모드에서 OneDrive 루트 폴더를 선택한 뒤 [폴더 생성 및 검증]을 먼저 실행해 주세요.";

export function formatGameStartReadinessFailure(
  result: ApiResult<GameStartReadiness>,
  eventProfileId: EventProfileId = "geumcheon-2026"
): string {
  const fallback =
    eventProfileId === "geumcheon-2026"
      ? GEUMCHEON_GAME_START_STORAGE_FALLBACK
      : SKILLUP_GAME_START_STORAGE_FALLBACK;
  return storageErrorForDisplay(result.data?.message || result.error, fallback);
}

export function resolveTypingScreenBackground(
  screen: "start" | "game" | "ai" | "result",
  assets: BootstrapData["eventProfile"]["assets"]
): string {
  return screen === "start" ? assets.startBackground : assets.playBackground;
}

type Participant = {
  name: string;
  phone1: string;
  phone2: string;
  phone3: string;
  birthYear: string;
  birthMonth: string;
  birthDay: string;
  privacyAgreedAt: string;
};

type GameResult = {
  row?: RecordRow;
  rankLabel?: string;
  participant: Participant;
  stageTexts: [string, string, string];
  stageTimes: [number, number, number];
  debugModeType: DebugModeType;
  saveError?: string;
};

const PHONE_PREFIXES = ["010"];
const MAIN_CONFIRM_MESSAGE = "진행 중인 게임을 종료하고 메인 화면으로 이동하시겠습니까? 중단 시점까지의 기록이 저장됩니다.";
const RETRY_CONFIRM_MESSAGE = "현재 게임을 처음부터 다시 시작하시겠습니까? 중단 시점까지의 기록이 저장됩니다.";
const MODE_GUIDES: Record<GameMode, { title: string; items: string[] }> = {
  normal: {
    title: "일잘러 타자왕은 누구!? 게임 안내",
    items: [
      "3, 2, 1 카운트 후 START가 표시되면 게임이 시작됩니다.",
      "문장의 줄바꿈은 자동으로 진행되며, 화면에 보이는 문장만 정확히 입력하면 됩니다.",
      "일치하는 글자는 파란색, 틀린 글자는 빨간색으로 표시됩니다.",
      "문장 전체가 100% 일치하면 Enter를 누르지 않아도 다음 스테이지로 이동합니다.",
      "3개의 스테이지를 모두 완료하면 최종 기록이 저장됩니다."
    ]
  },
  ai_challenge: {
    title: "AI 타자왕 금나래를 이겨라! 도전 안내",
    items: [
      "3, 2, 1 카운트 후 START가 표시되면 게임이 시작됩니다.",
      "문장의 줄바꿈은 자동으로 진행되며, 화면에 보이는 문장만 정확히 입력하면 됩니다.",
      "일치하는 글자는 파란색, 틀린 글자는 빨간색으로 표시됩니다.",
      "문장 전체가 100% 일치하면 Enter를 누르지 않아도 다음 스테이지로 이동합니다.",
      "금나래보다 먼저 정확도 100%로 문장을 완성하면 승리합니다."
    ]
  }
};

function sameGameConfig(a: BootstrapData["config"], b: BootstrapData["config"]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function TypingGameApp({ bootstrap }: Props) {
  const { assetBaseUrl } = bootstrap;
  const [config, setConfig] = useState(bootstrap.config);
  const isPracticeApp = bootstrap.variantPolicy.sessionKind === "practice";
  const forcedGameMode: GameMode | null = bootstrap.variantPolicy.gameModes.length === 1
    ? bootstrap.variantPolicy.gameModes[0]
    : null;
  const [screen, setScreen] = useState<"start" | "game" | "ai" | "result">("start");
  const [gameMode, setGameMode] = useState<GameMode>(forcedGameMode ?? "normal");
  const [debugModeType, setDebugModeType] = useState<DebugModeType>("");
  const [aiRunId, setAiRunId] = useState(0);
  const [name, setName] = useState("");
  const [phone1, setPhone1] = useState("010");
  const [phone2, setPhone2] = useState("");
  const [phone3, setPhone3] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [birthMonth, setBirthMonth] = useState("");
  const [birthDay, setBirthDay] = useState("");
  const [privacyAgreed, setPrivacyAgreed] = useState(false);
  const [privacyAgreedAt, setPrivacyAgreedAt] = useState("");
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [startFormKey, setStartFormKey] = useState(0);
  const [pendingGameAction, setPendingGameAction] = useState<GameControlAction | null>(null);
  const [gameControlSaving, setGameControlSaving] = useState(false);
  const [formMessage, setFormMessage] = useState("");
  const [blockingModalMessage, setBlockingModalMessage] = useState("");
  const [toast, setToast] = useState("");
  const [stageTexts, setStageTexts] = useState<[string, string, string] | null>(null);
  const [stageTextSelections, setStageTextSelections] = useState<readonly [StageTextSelection, StageTextSelection, StageTextSelection] | null>(null);
  const [stageIndex, setStageIndex] = useState(0);
  const [input, setInput] = useState("");
  const [composing, setComposing] = useState(false);
  const [gameCountdown, setGameCountdown] = useState("");
  const [gameRunning, setGameRunning] = useState(false);
  const [stageTimes, setStageTimes] = useState<number[]>([]);
  const [result, setResult] = useState<GameResult | null>(null);
  const [resultAutoHomeSeconds, setResultAutoHomeSeconds] = useState(10);
  const [tick, setTick] = useState(0);
  const stageStartRef = useRef(0);
  const totalStartRef = useRef(0);
  const stageCompleteRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const gameControlPausedAtRef = useRef(0);
  const gameControlWasRunningRef = useRef(false);
  const gameControlSavingRef = useRef(false);

  useEffect(() => {
    // 게임 중 회차가 원격으로 바뀌어도 현재 참가자의 기록은 시작했던 회차에 저장한다.
    // 최신 회차 동기화는 메인 화면에서만 수행하고 다음 게임 시작 전에 다시 검증한다.
    if (screen !== "start") return;
    let alive = true;
    async function refreshSettings() {
      const result = await window.typingKing.getOneDriveSettings();
      if (alive && result.ok && result.data) {
        const refreshed = mergeRuntimeConfigWithEventProfile(
          result.data,
          bootstrap.eventProfile,
          bootstrap.variantPolicy.sessionKind
        );
        setConfig((current) => (sameGameConfig(current, refreshed) ? current : refreshed));
      }
    }
    void refreshSettings();
    const timer = window.setInterval(refreshSettings, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [screen]);

  useEffect(() => {
    if (phone1 !== "010") setPhone1("010");
  }, [phone1]);

  useEffect(() => {
    if (screen !== "result" || !result) return;
    const endAt = Date.now() + 10000;
    setResultAutoHomeSeconds(10);
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      setResultAutoHomeSeconds(remaining);
      if (remaining <= 0) {
        window.clearInterval(timer);
        resetAll();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [screen, result]);

  const years = useMemo(() => {
    const end =
      config.birthYearEndMode === "fixed" && config.birthYearEnd
        ? config.birthYearEnd
        : new Date().getFullYear();
    const values: number[] = [];
    for (let year = end; year >= config.birthYearStart; year -= 1) values.push(year);
    return values;
  }, [config.birthYearEnd, config.birthYearEndMode, config.birthYearStart]);

  const dayOptions = useMemo(() => {
    if (!birthYear || !birthMonth) return Array.from({ length: 31 }, (_, index) => index + 1);
    return Array.from(
      { length: daysInMonth(Number(birthYear), Number(birthMonth)) },
      (_, index) => index + 1
    );
  }, [birthMonth, birthYear]);

  const validationMessage = useMemo(() => {
    if (!name.trim()) return "이름을 입력해 주세요.";
    const phoneError = validatePhoneParts(phone1, phone2, phone3);
    if (phoneError) return phoneError;
    if (!birthYear) return "생년월일의 연도를 선택해 주세요.";
    if (!birthMonth) return "생년월일의 월을 선택해 주세요.";
    if (!birthDay) return "생년월일의 일을 선택해 주세요.";
    if (!isValidBirthdate(birthYear, birthMonth, birthDay)) {
      const candidate = new Date(Number(birthYear), Number(birthMonth) - 1, Number(birthDay));
      return candidate > new Date()
        ? "생년월일은 오늘 이후 날짜를 선택할 수 없습니다."
        : "존재하지 않는 생년월일입니다.";
    }
    if (!privacyAgreed) return "개인정보 수집·이용에 동의해야 참여할 수 있습니다.";
    if (!config.privacyConsentText.trim()) {
      return "개인정보 수집·이용 문안이 설정되어 있지 않습니다. 관리자에게 문의해 주세요.";
    }
    if (!gameMode) return "게임 모드를 선택해 주세요.";
    if (gameMode === "ai_challenge" && !config.aiChallenge.enabled) {
      return "AI 챌린지 모드를 불러오지 못했습니다. 관리자에게 문의해 주세요.";
    }
    return "";
  }, [birthDay, birthMonth, birthYear, config.aiChallenge.enabled, config.privacyConsentText, gameMode, name, phone1, phone2, phone3, privacyAgreed]);

  const canStart = validationMessage === "";
  const currentTarget = stageTexts?.[stageIndex] ?? "";
  const stageElapsed = screen === "game" && gameRunning ? Math.max(0, performance.now() - stageStartRef.current) : 0;
  const totalElapsed =
    screen === "game"
      ? stageTimes.reduce((sum, value) => sum + value, 0) + stageElapsed
      : stageTimes.reduce((sum, value) => sum + value, 0);
  const accuracy = calculateAccuracy(input, currentTarget);
  const currentCpm = calculateCurrentCpm(input, stageElapsed, currentTarget);

  useEffect(() => {
    if (screen !== "game") return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 100);
    return () => window.clearInterval(timer);
  }, [screen]);

  useEffect(() => {
    if (screen !== "game" || !stageTexts) return;
    const seconds = Math.max(1, Math.floor(config.aiChallenge.countdownSeconds || 3));
    let current = seconds;
    let clearStartTimer = 0;
    stageCompleteRef.current = false;
    setInput("");
    setGameRunning(false);
    setGameCountdown(String(current));

    const timer = window.setInterval(() => {
      current -= 1;
      if (current > 0) {
        setGameCountdown(String(current));
        return;
      }
      window.clearInterval(timer);
      setGameCountdown("START");
      stageStartRef.current = performance.now();
      if (stageIndex === 0) totalStartRef.current = stageStartRef.current;
      setGameRunning(true);
      queueTypingInputFocus();
      clearStartTimer = window.setTimeout(() => setGameCountdown(""), 520);
    }, 1000);

    return () => {
      window.clearInterval(timer);
      if (clearStartTimer) window.clearTimeout(clearStartTimer);
    };
  }, [config.aiChallenge.countdownSeconds, screen, stageIndex, stageTexts]);

  useEffect(() => {
    if (screen === "game" && gameRunning) queueTypingInputFocus();
  }, [gameRunning, screen, stageIndex]);

  useEffect(() => {
    if (
      screen !== "game" ||
      !gameRunning ||
      composing ||
      stageCompleteRef.current ||
      !currentTarget ||
      !isExactMatch(input, currentTarget)
    ) {
      return;
    }
    stageCompleteRef.current = true;
    void completeStage();
  }, [composing, currentTarget, gameRunning, input, screen]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function asset(path: string) {
    return `${assetBaseUrl}/${path}`;
  }

  function profileAsset(path: string) {
    return resolveEventAssetUrl(assetBaseUrl, bootstrap.eventProfile, path);
  }

  const screenBackground = profileAsset(resolveTypingScreenBackground(screen, bootstrap.eventProfile.assets));

  function updateDigits(next: string, setter: (value: string) => void, max: number) {
    if (/\D/.test(next)) setFormMessage("휴대폰번호는 숫자만 입력할 수 있습니다.");
    setter(onlyDigits(next).slice(0, max));
  }

  function focusTypingInput() {
    const element = inputRef.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    const cursorPosition = element.value.length;
    try {
      element.setSelectionRange(cursorPosition, cursorPosition);
    } catch {
      // IME composition can briefly reject cursor movement; the focus retry still keeps typing active.
    }
  }

  function queueTypingInputFocus() {
    const run = () => {
      focusTypingInput();
      window.setTimeout(focusTypingInput, 0);
      window.setTimeout(focusTypingInput, 60);
      window.setTimeout(focusTypingInput, 160);
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(run);
      return;
    }
    window.setTimeout(run, 0);
  }

  async function startGame(requestedMode: GameMode = forcedGameMode ?? gameMode, requestedDebugMode: DebugModeType = "") {
    const isDebug = requestedDebugMode !== "";
    const modeToStart = forcedGameMode ?? requestedMode;
    if (!isDebug) {
      setFormMessage(validationMessage);
      if (!canStart) return;
    } else {
      setFormMessage("");
      setGameMode(modeToStart);
      setName("디버그");
      setPhone1("010");
      setPhone2("0000");
      setPhone3("0000");
      setBirthYear("2000");
      setBirthMonth("1");
      setBirthDay("1");
      setPrivacyAgreed(true);
      setPrivacyAgreedAt(new Date().toISOString());
    }

    if (modeToStart === "ai_challenge" && !config.aiChallenge.enabled) {
      setFormMessage("AI 챌린지 모드를 불러오지 못했습니다. 관리자에게 문의해 주세요.");
      return;
    }

    const storageReady = await window.typingKing.checkGameStartReadiness(modeToStart);
    if (!storageReady.ok || !storageReady.data?.ready) {
      const message = formatGameStartReadinessFailure(storageReady, bootstrap.eventProfile.profileId);
      setFormMessage(message);
      if (message.includes("회차로 변경해 주세요")) setBlockingModalMessage(message);
      return;
    }

    if (bootstrap.eventProfile.profileId === "geumcheon-2026") {
      const drawn = await window.typingKing.drawStageTexts({
        sessionKind: bootstrap.variantPolicy.sessionKind,
        gameMode: "ai_challenge"
      });
      if (!drawn.ok || !drawn.data) {
        setFormMessage(storageErrorForDisplay(drawn.error, "대회 문구를 불러오지 못했습니다. 관리자에게 문의해 주세요."));
        return;
      }
      setStageTexts(drawn.data.selections.map((selection) => selection.text) as [string, string, string]);
      setStageTextSelections(drawn.data.selections);
      setStageIndex(0);
      setInput("");
      setStageTimes([]);
      setResult(null);
      setDebugModeType(requestedDebugMode);
      setAiRunId((value) => value + 1);
      setScreen("ai");
      return;
    }

    const readiness = await window.typingKing.getStageReadiness(modeToStart);
    if (readiness.ok && readiness.data && readiness.data.length > 0) {
      setFormMessage(readiness.data[0]);
      return;
    }

    const result = await window.typingKing.listStageTexts();
    if (!result.ok || !result.data) {
      setFormMessage(storageErrorForDisplay(result.error, "문구 파일 형식에 오류가 있습니다. 관리자에게 복원을 요청해 주세요."));
      return;
    }

    const selected = pickStageTexts(result.data, modeToStart);
    if (!selected.ok) {
      setFormMessage(selected.error);
      return;
    }

    setStageTexts(selected.texts);
    setStageTextSelections(null);
    setStageIndex(0);
    setInput("");
    setStageTimes([]);
    setResult(null);
    setDebugModeType(requestedDebugMode);
    if (modeToStart === "ai_challenge") {
      setAiRunId((value) => value + 1);
      setScreen("ai");
    } else {
      setScreen("game");
    }
  }

  function pickStageTexts(rows: StageText[], modeToPick: GameMode): { ok: true; texts: [string, string, string] } | { ok: false; error: string } {
    const chosen: string[] = [];
    let rotationState = parseStageTextRotationState(window.localStorage.getItem(STAGE_TEXT_ROTATION_STORAGE_KEY));
    for (let stage = 1; stage <= 3; stage += 1) {
      const active = rows.filter(
        (row) =>
          row.stage_number === String(stage) &&
          row.is_active === "true" &&
          (row.game_mode || "normal") === modeToPick
      );
      if (active.length === 0) return { ok: false, error: `Stage ${stage}에 등록된 활성 문구가 없습니다.` };
      const unused = active.filter((row) => !chosen.includes(row.text));
      const pool = unused.length > 0 ? unused : active;
      const selected = pickRotatingStageText(pool, modeToPick, stage, rotationState);
      rotationState = selected.nextState;
      chosen.push(selected.row.text);
    }
    window.localStorage.setItem(STAGE_TEXT_ROTATION_STORAGE_KEY, JSON.stringify(rotationState));
    return { ok: true, texts: chosen as [string, string, string] };
  }

  function handleInput(next: string) {
    if (!gameRunning) return;
    if (next.includes("\t")) return;
    const nextInput = stripDisplayLineBreaks(next);
    if (countTypeableChars(nextInput) > countTypeableChars(currentTarget)) {
      setToast("제시문보다 더 긴 문장은 입력할 수 없습니다.");
      return;
    }
    if (!isLineProgressAllowed(nextInput, currentTarget)) return;
    setInput(nextInput);
    if (!stageCompleteRef.current && isExactMatch(nextInput, currentTarget)) {
      stageCompleteRef.current = true;
      void completeStage();
    }
  }

  async function completeStage() {
    if (!stageTexts) return;
    setGameRunning(false);
    const elapsed = finalizeUserStageTimeMs(stageStartRef.current, performance.now());
    const nextTimes = [...stageTimes, elapsed];
    if (stageIndex < 2) {
      setStageTimes(nextTimes);
      setStageIndex((value) => value + 1);
      setInput("");
      return;
    }

    const participant: Participant = {
      name: name.trim(),
      phone1,
      phone2,
      phone3,
      birthYear,
      birthMonth,
      birthDay,
      privacyAgreedAt
    };
    const saveInput: SaveRecordInput = {
      participant_name: participant.name,
      phone_part1: phone1,
      phone_part2: phone2,
      phone_part3: phone3,
      birth_year: birthYear,
      birth_month: birthMonth,
      birth_day: birthDay,
      privacy_agreed: true,
      privacy_agreed_at: participant.privacyAgreedAt,
      stageTexts,
      stageTimesMs: nextTimes as [number, number, number],
      is_debug: debugModeType === "normal_typing_debug",
      debug_mode_type: debugModeType === "normal_typing_debug" ? debugModeType : ""
    };

    const saved = await window.typingKing.saveRecord(saveInput);
    const savedRow = saved.ok ? saved.data : undefined;
    setResult({
      row: savedRow,
      rankLabel: await resolveNormalRankLabel(savedRow, debugModeType === "normal_typing_debug"),
      participant,
      stageTexts,
      stageTimes: nextTimes as [number, number, number],
      debugModeType,
      saveError: saved.ok
        ? undefined
        : storageErrorForDisplay(
            saved.error,
            "기록 저장에 실패했습니다. 이 PC에 임시 보관했으며 관리자에게 NAS 연결 확인을 요청해 주세요."
          )
    });
    setStageTimes(nextTimes);
    setScreen("result");
  }

  async function resolveNormalRankLabel(savedRow: RecordRow | undefined, isDebug: boolean): Promise<string> {
    if (!savedRow || isDebug) return "-";
    try {
      const listed = await window.typingKing.listRecords();
      const rows = listed.ok && listed.data ? listed.data : [savedRow];
      const normalRows = rows.filter((row) => {
        const mode = row.game_mode || "normal";
        return mode === "normal" && row.is_debug !== "true" && row.is_test !== "true";
      });
      if (!normalRows.some((row) => row.record_id === savedRow.record_id)) normalRows.push(savedRow);

      const bestRows = sortRecords(bestRecordOnly(normalRows));
      const bestRank = bestRows.findIndex((row) => row.record_id === savedRow.record_id);
      if (bestRank >= 0) return `${bestRank + 1}위`;

      const allRank = sortRecords(normalRows).findIndex((row) => row.record_id === savedRow.record_id);
      return allRank >= 0 ? `${allRank + 1}위` : "-";
    } catch {
      return "-";
    }
  }

  function onGameKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      event.preventDefault();
      setToast("붙여넣기는 사용할 수 없습니다.");
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
    }
  }

  function resetAll() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    inputRef.current = null;
    stageCompleteRef.current = false;
    setScreen("start");
    setStartFormKey((value) => value + 1);
    setName("");
    setPhone1("010");
    setPhone2("");
    setPhone3("");
    setBirthYear("");
    setBirthMonth("");
    setBirthDay("");
    setPrivacyAgreed(false);
    setPrivacyAgreedAt("");
    setGameMode(forcedGameMode ?? "normal");
    setFormMessage("");
    setShowPrivacy(false);
    setAdminOpen(false);
    setToast("");
    setComposing(false);
    setPendingGameAction(null);
    setInput("");
    setGameCountdown("");
    setGameRunning(false);
    setStageTexts(null);
    setStageTextSelections(null);
    setStageTimes([]);
    setResult(null);
    setDebugModeType("");
  }

  function requestGameControl(action: GameControlAction) {
    if (gameControlSavingRef.current) return;
    gameControlPausedAtRef.current = performance.now();
    gameControlWasRunningRef.current = gameRunning;
    if (gameRunning) setGameRunning(false);
    setPendingGameAction(action);
  }

  function cancelGameControl() {
    if (gameControlSavingRef.current) return;
    const controlClosedAt = performance.now();
    setPendingGameAction(null);
    if (screen === "game" && gameControlWasRunningRef.current) {
      stageStartRef.current = resumeStageTimerAfterControl(
        stageStartRef.current,
        gameControlPausedAtRef.current,
        controlClosedAt,
        false
      );
      setGameRunning(true);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  async function saveInterruptedNormalGame(action: GameControlAction) {
    if (!stageTexts) return;
    const currentElapsed = gameControlWasRunningRef.current
      ? finalizeUserStageTimeMs(
          stageStartRef.current,
          gameControlPausedAtRef.current
        )
      : 0;
    const interruptedTimes: [number, number, number] = [0, 0, 0];
    stageTimes.forEach((value, index) => {
      if (index < 3) interruptedTimes[index] = Math.max(0, value);
    });
    interruptedTimes[stageIndex] = currentElapsed;

    const stageCharCounts: [number, number, number] = [0, 0, 0];
    let completedTypingUnits = 0;
    for (let index = 0; index < stageIndex; index += 1) {
      stageCharCounts[index] = countTypeableChars(stageTexts[index]);
      completedTypingUnits += countConvertedTypingUnits(stageTexts[index]);
    }
    stageCharCounts[stageIndex] = countTypeableChars(input);
    const totalTargetChars = stageTexts.reduce((sum, text) => sum + countTypeableChars(text), 0);
    const typedChars = stageCharCounts.reduce((sum, value) => sum + value, 0);
    const participantProgressPercent = totalTargetChars > 0 ? (typedChars / totalTargetChars) * 100 : 0;

    await window.typingKing.saveRecord({
      participant_name: name.trim(),
      phone_part1: phone1,
      phone_part2: phone2,
      phone_part3: phone3,
      birth_year: birthYear,
      birth_month: birthMonth,
      birth_day: birthDay,
      privacy_agreed: true,
      privacy_agreed_at: privacyAgreedAt,
      stageTexts,
      stageTimesMs: interruptedTimes,
      final_accuracy: Math.round(calculateAccuracy(input, currentTarget)),
      is_debug: debugModeType === "normal_typing_debug",
      debug_mode_type: debugModeType === "normal_typing_debug" ? debugModeType : "",
      interruption: {
        action,
        resultStage: stageIndex + 1,
        participantProgressPercent,
        stageCharCounts,
        totalTypingUnits:
          completedTypingUnits + countMatchingPrefixTypingUnits(input, currentTarget)
      }
    });
  }

  async function confirmGameControl() {
    const action = pendingGameAction;
    if (!action || gameControlSavingRef.current) return;
    gameControlSavingRef.current = true;
    setGameControlSaving(true);
    await saveInterruptedNormalGame(action);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    inputRef.current = null;
    stageCompleteRef.current = true;
    setPendingGameAction(null);
    setToast("");
    setGameCountdown("");
    setGameRunning(false);
    gameControlSavingRef.current = false;
    setGameControlSaving(false);
    if (action === "home") {
      resetAll();
      return;
    }
    void startGame("normal", debugModeType === "normal_typing_debug" ? debugModeType : "");
  }

  if (screen === "result" && result) {
    return (
      <main className="app game-app" style={{ backgroundImage: `url("${screenBackground}")` }}>
        <BrandHeader bootstrap={bootstrap} />
        <ResultScreen
          result={result}
          assetBaseUrl={assetBaseUrl}
          autoHomeSeconds={resultAutoHomeSeconds}
          onRetry={() => void startGame("normal", result.debugModeType === "normal_typing_debug" ? "normal_typing_debug" : "")}
          onHome={resetAll}
        />
      </main>
    );
  }

  if (screen === "game" && stageTexts) {
    return (
      <main className="app game-app" style={{ backgroundImage: `url("${screenBackground}")` }}>
        <BrandHeader bootstrap={bootstrap} />
        <section className="game-layout">
          <div className="game-stage">
            <FallbackAssetImage
              src={asset("normal_typing/normal_title_oneline_trimmed.png")}
              fallbackSrc={asset("normal_typing/normal_typing_title.png")}
              alt="일잘러 타자왕은 누구!?"
              className="game-mode-title-image normal-title-image"
              fallback={<h1 className="mode-title-fallback">일잘러 타자왕</h1>}
            />
            <p className="eyebrow">Stage {stageIndex + 1} / 3</p>
            <h1>문장을 정확히 입력하세요</h1>
            <CharacterLine target={currentTarget} input={input} showCursor={gameRunning} />
            <div className="input-capture-panel" onMouseDown={() => inputRef.current?.focus()}>
              <InputEcho target={currentTarget} input={input} showCursor={gameRunning} />
              <textarea
                ref={inputRef}
                className="typing-input hidden-input-capture"
                value={applyTargetLineBreaks(input, currentTarget)}
                disabled={!gameRunning}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => handleInput(event.target.value)}
                onKeyDown={onGameKeyDown}
                onPaste={(event) => {
                  event.preventDefault();
                  setToast("붙여넣기는 사용할 수 없습니다.");
                }}
                onContextMenu={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  setToast("드래그앤드롭 입력은 사용할 수 없습니다.");
                }}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={(event) => {
                  setComposing(false);
                  handleInput(event.currentTarget.value);
                }}
              />
            </div>
            <p className="guide-text">정확도 100%로 문장을 완성하면 자동으로 다음 단계로 이동합니다.</p>
            {gameCountdown && <div className="countdown-overlay">{gameCountdown}</div>}
            {toast && <div className="toast">{toast}</div>}
            <div className="button-row game-control-row">
              <button
                className="secondary-button game-retry-button"
                onClick={() => requestGameControl("retry")}
              >
                다시하기
              </button>
              <button className="primary-button game-main-button" onClick={() => requestGameControl("home")}>
                메인으로 가기
              </button>
            </div>
            {pendingGameAction && (
              <GameControlConfirmModal
                action={pendingGameAction}
                saving={gameControlSaving}
                onCancel={cancelGameControl}
                onConfirm={() => void confirmGameControl()}
              />
            )}
          </div>
          <aside className="metric-stack">
            <Metric label="현재 타수" value={`${currentCpm}`} unit="타/분" />
            <Metric label="현재 정확도" value={formatDisplayNumber(accuracy, 1, true)} unit="%" />
            <Metric label="스테이지 시간" value={formatDisplayMs(stageElapsed)} unit="초" />
            <Metric label="누적 시간" value={formatDisplayMs(totalElapsed)} unit="초" />
          </aside>
        </section>
      </main>
    );
  }

  if (screen === "ai" && stageTexts) {
    const participant = {
      name: name.trim(),
      phone1,
      phone2,
      phone3,
      birthYear,
      birthMonth,
      birthDay,
      privacyAgreedAt
    };
    return (
      <main className="app game-app" style={{ backgroundImage: `url("${screenBackground}")` }}>
        <BrandHeader bootstrap={bootstrap} />
        <AIChallengeGame
          key={aiRunId}
          config={config}
          participant={participant}
          stageTexts={stageTexts}
          stageTextSelections={stageTextSelections ?? undefined}
          assetBaseUrl={assetBaseUrl}
          eventProfile={bootstrap.eventProfile}
          debugModeType={debugModeType}
          onHome={resetAll}
          onRetry={() => void startGame("ai_challenge", debugModeType === "ai_challenge_debug" ? debugModeType : "")}
        />
      </main>
    );
  }

  return (
    <main className="app game-app" style={{ backgroundImage: `url("${screenBackground}")` }}>
      {bootstrap.eventProfile.profileId !== "geumcheon-2026" && <BrandHeader bootstrap={bootstrap} />}
      <section className="start-grid" key={startFormKey}>
        <div className="hero-panel">
          <div className="brand-slogan-row">
            <p className="eyebrow">{bootstrap.eventProfile.profileId === "geumcheon-2026" ? bootstrap.eventProfile.eventNameEn : "Work, Re:design"}</p>
            <span className="brand-subtitle">{bootstrap.eventProfile.profileId === "geumcheon-2026" ? bootstrap.eventProfile.slogan : "일의 본질을 묻다."}</span>
          </div>
          {gameMode === "ai_challenge" ? (
            <>
              <FallbackAssetImage
                src={bootstrap.eventProfile.profileId === "geumcheon-2026"
                  ? profileAsset(bootstrap.eventProfile.assets.eventTitle)
                  : asset("ai_challenge/ai_title_oneline_trimmed.png")}
                fallbackSrc={bootstrap.eventProfile.profileId === "geumcheon-2026"
                    ? profileAsset(bootstrap.eventProfile.assets.eventTitle)
                    : asset("ai_challenge/ai_challenge_title.png")}
                alt={bootstrap.eventProfile.profileId === "geumcheon-2026" ? "AI 타자왕 금나래를 이겨라!" : bootstrap.variantPolicy.displayName}
                className={bootstrap.eventProfile.profileId === "geumcheon-2026"
                  ? "mode-title-image start-ai-title-image ai-title-image geumcheon-main-title-image"
                  : "mode-title-image start-ai-title-image ai-title-image"}
                fallback={<h1>{bootstrap.eventProfile.profileId === "geumcheon-2026" ? "AI 타자왕 금나래를 이겨라!" : bootstrap.variantPolicy.displayName}</h1>}
              />
              <p className="hero-copy">3개의 스테이지에서 금나래보다 먼저 정확하게 입력하세요.</p>
              {bootstrap.eventProfile.profileId === "geumcheon-2026" && (
                <FallbackAssetImage
                  src={profileAsset(bootstrap.eventProfile.assets.aiBossMain)}
                  fallbackSrc={profileAsset(bootstrap.eventProfile.assets.aiBossTyping)}
                  alt="금나래 AI 타자로봇"
                  className="geumcheon-main-robot"
                />
              )}
            </>
          ) : (
            <>
              <FallbackAssetImage
                src={asset("normal_typing/normal_title_oneline_trimmed.png")}
                fallbackSrc={asset("normal_typing/normal_typing_title.png")}
                alt="일잘러 타자왕은 누구!?"
                className="mode-title-image start-normal-title-image normal-title-image"
                fallback={<h1>일잘러 타자왕은 누구!?</h1>}
              />
              <p className="hero-copy">3개의 문장을 빠르고 정확하게 완성해 순위에 도전하세요.</p>
            </>
          )}
          <section className="hero-guide-card">
            <h2>{bootstrap.eventProfile.profileId === "geumcheon-2026" ? `${bootstrap.eventProfile.gameName} 도전 안내` : MODE_GUIDES[gameMode].title}</h2>
            <ol className="hero-guide-list">
              {MODE_GUIDES[gameMode].items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          </section>
        </div>
        <form className="entry-panel" onSubmit={(event) => event.preventDefault()}>
          <div className="field">
            <span>게임 모드</span>
            {isPracticeApp && (
              <p className="practice-mode-note">
                지금은 자유 연습회차입니다. <small>※ 공식 순위 및 사은품 집계 제외</small>
              </p>
            )}
            <div className={forcedGameMode === null ? "mode-selector" : "mode-selector single-mode-selector"}>
              {(forcedGameMode === "normal" || forcedGameMode === null) && (
              <button
                type="button"
                className={!isPracticeApp || gameMode === "normal" ? "mode-card active" : "mode-card"}
                onClick={() => setGameMode("normal")}
              >
                <FallbackAssetImage
                  src={asset("normal_typing/normal_title_compact.png")}
                  fallbackSrc={asset("normal_typing/normal_typing_title.png")}
                  alt=""
                  className="mode-card-art"
                />
                <strong>일잘러 타자왕은 누구!?</strong>
                <small>3개 스테이지 기록 경쟁</small>
              </button>
              )}
              {(forcedGameMode === "ai_challenge" || forcedGameMode === null) && (
              <button
                type="button"
                className={!isPracticeApp || gameMode === "ai_challenge" ? "mode-card active" : "mode-card"}
                onClick={() => setGameMode("ai_challenge")}
              >
                <FallbackAssetImage
                  src={bootstrap.eventProfile.profileId === "geumcheon-2026"
                    ? profileAsset(bootstrap.eventProfile.assets.eventTitle)
                    : asset("ai_challenge/ai_title_compact.png")}
                  fallbackSrc={bootstrap.eventProfile.profileId === "geumcheon-2026"
                    ? profileAsset(bootstrap.eventProfile.assets.eventTitle)
                    : asset("ai_challenge/ai_challenge_title.png")}
                  alt=""
                  className="mode-card-art"
                />
                <strong>{bootstrap.eventProfile.profileId === "geumcheon-2026" ? "AI 타자왕 금나래를 이겨라!" : bootstrap.variantPolicy.displayName}</strong>
                <small>{bootstrap.eventProfile.profileId === "geumcheon-2026" ? "금나래와 1:1 대결" : "가상 AI 챌린저와 1:1 대결"}</small>
              </button>
              )}
            </div>
          </div>
          <label className="field">
            <span>이름</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="참여자 이름" />
          </label>
          <div className="field">
            <span>휴대폰번호</span>
            <div className="phone-row">
              <select value={phone1 || "010"} onChange={(event) => setPhone1(event.target.value)}>
                {PHONE_PREFIXES.map((prefix) => (
                  <option key={prefix} value={prefix}>{prefix}</option>
                ))}
              </select>
              <b>-</b>
              <input
                value={phone2}
                inputMode="numeric"
                maxLength={4}
                onChange={(event) => updateDigits(event.target.value, setPhone2, 4)}
              />
              <b>-</b>
              <input
                value={phone3}
                inputMode="numeric"
                maxLength={4}
                onChange={(event) => updateDigits(event.target.value, setPhone3, 4)}
              />
            </div>
          </div>
          <div className="field">
            <span>생년월일</span>
            <div className="birth-row">
              <select value={birthYear} onChange={(event) => setBirthYear(event.target.value)}>
                <option value="">년</option>
                {years.map((year) => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </select>
              <select value={birthMonth} onChange={(event) => setBirthMonth(event.target.value)}>
                <option value="">월</option>
                {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
                  <option key={month} value={month}>{month}월</option>
                ))}
              </select>
              <select value={birthDay} onChange={(event) => setBirthDay(event.target.value)}>
                <option value="">일</option>
                {dayOptions.map((day) => (
                  <option key={day} value={day}>{day}일</option>
                ))}
              </select>
            </div>
          </div>

          <label className="check-line">
            <input
              type="checkbox"
              checked={privacyAgreed}
              onChange={(event) => {
                setPrivacyAgreed(event.target.checked);
                setPrivacyAgreedAt(event.target.checked ? new Date().toISOString() : "");
              }}
            />
            개인정보 수집·이용에 동의합니다.
          </label>
          <button type="button" className="text-button" onClick={() => setShowPrivacy(true)}>
            동의 내용 보기
          </button>

          <p className={canStart ? "notice-text" : "error-text"}>{formMessage || validationMessage}</p>
          <div className="button-row split">
            <button className="primary-button large" disabled={!canStart} onClick={() => void startGame()}>
              시작
            </button>
            <button type="button" className="secondary-button" onClick={() => setAdminOpen(true)}>
              관리자 모드
            </button>
          </div>
        </form>
      </section>

      {showPrivacy && (
        <div className="modal-backdrop">
          <section className="modal">
            <header className="modal-header">
              <h2>개인정보 수집·이용 동의</h2>
              <button className="icon-button" onClick={() => setShowPrivacy(false)} aria-label="닫기">×</button>
            </header>
            <pre className="privacy-text">{config.privacyConsentText}</pre>
            <button className="primary-button" onClick={() => setShowPrivacy(false)}>확인</button>
          </section>
        </div>
      )}
      {blockingModalMessage && (
        <div className="modal-backdrop">
          <section className="modal">
            <header className="modal-header">
              <h2>회차 변경 필요</h2>
              <button className="icon-button" onClick={() => setBlockingModalMessage("")} aria-label="닫기">×</button>
            </header>
            <p className="notice-text modal-notice">{blockingModalMessage}</p>
            <button className="primary-button" onClick={() => setBlockingModalMessage("")}>확인</button>
          </section>
        </div>
      )}
      {adminOpen && (
        <StageTextAdmin
          onClose={() => setAdminOpen(false)}
          onStartDebug={(mode) => {
            setAdminOpen(false);
            const debugMode = forcedGameMode ?? gameMode;
            void startGame(debugMode, debugMode === "ai_challenge" ? "ai_challenge_debug" : "normal_typing_debug");
          }}
          allowedMode={forcedGameMode ?? gameMode}
          isPractice={isPracticeApp}
          eventProfileId={bootstrap.eventProfile.profileId}
          deviceProfile={bootstrap.deviceProfile}
          sessionKind={bootstrap.variantPolicy.sessionKind}
        />
      )}
      {bootstrap.notices.map((notice) => (
        <div className="system-notice" key={notice}>{notice}</div>
      ))}
    </main>
  );
}

function GameControlConfirmModal({
  action,
  saving,
  onCancel,
  onConfirm
}: {
  action: GameControlAction;
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop game-confirm-backdrop">
      <section className="modal game-confirm-modal">
        <h2>{action === "home" ? "메인으로 이동" : "다시하기"}</h2>
        <p>{action === "home" ? MAIN_CONFIRM_MESSAGE : RETRY_CONFIRM_MESSAGE}</p>
        <div className="button-row">
          <button className="primary-button" onClick={onConfirm} disabled={saving}>{saving ? "기록 저장 중..." : "확인"}</button>
          <button className="secondary-button" onClick={onCancel} disabled={saving}>취소</button>
        </div>
      </section>
    </div>
  );
}

function BrandHeader({ bootstrap }: { bootstrap: BootstrapData }) {
  const [logoLoaded, setLogoLoaded] = useState(false);
  const configuredPath = bootstrap.eventProfile.assets.eventTitle;
  const relativePath = configuredPath.replace(/^assets\//, "");
  const titleUrl = bootstrap.eventProfile.profileId === "geumcheon-2026"
    ? `${bootstrap.assetBaseUrl}/../events/${bootstrap.eventProfile.profileId}/assets/${relativePath}`
    : `${bootstrap.assetBaseUrl}/${relativePath}`;
  return (
    <header className="brand-header">
      <img
        src={titleUrl}
        alt={bootstrap.eventProfile.eventName}
        onLoad={() => setLogoLoaded(true)}
        onError={(event) => {
          event.currentTarget.style.display = "none";
          setLogoLoaded(false);
        }}
      />
      <div className="brand-title-fallback" style={{ display: logoLoaded ? "none" : undefined }}>
        <strong>{bootstrap.eventProfile.profileId === "geumcheon-2026" ? bootstrap.eventProfile.gameName : "2026"}</strong>
        <span>{bootstrap.eventProfile.profileId === "geumcheon-2026" ? bootstrap.eventProfile.eventName : "일잘러 페스타"}</span>
      </div>
    </header>
  );
}

function FallbackAssetImage({
  src,
  fallbackSrc,
  alt,
  className,
  fallback = null
}: {
  src: string;
  fallbackSrc: string;
  alt: string;
  className: string;
  fallback?: ReactNode;
}) {
  const [fallbackStep, setFallbackStep] = useState(0);
  if (fallbackStep > 1) return fallback ? <>{fallback}</> : null;
  return (
    <img
      src={fallbackStep === 0 ? src : fallbackSrc}
      alt={alt}
      className={className}
      draggable={false}
      onError={() => setFallbackStep((step) => step + 1)}
    />
  );
}

function CharacterLine({ target, input, showCursor = false }: { target: string; input: string; showCursor?: boolean }) {
  const inputChars = splitTypeableChars(input);
  let inputIndex = 0;
  return (
    <div className="target-line" aria-label="제시문">
      {target.replace(/\r\n/g, "\n").split("\n").flatMap((line, lineIndex, lines) => {
        const chars = splitTypeableChars(line).flatMap((char) => {
          const typed = inputChars[inputIndex];
          const state = typed == null ? "pending" : typed === char ? "correct" : "wrong";
          const charIndex = inputIndex;
          const nodes = [
            showCursor && charIndex === inputChars.length ? (
              <TypingCursor key={`cursor-${lineIndex}-${charIndex}`} />
            ) : null,
            <span key={`${lineIndex}-${char}-${charIndex}`} className={state}>
              {char === " " ? "\u00A0" : char}
            </span>
          ];
          inputIndex += 1;
          return nodes;
        });
        if (lineIndex < lines.length - 1) {
          chars.push(<span key={`line-${lineIndex}`} className="line-break" aria-hidden="true" />);
        }
        return chars;
      })}
      {showCursor && inputChars.length >= countTypeableChars(target) && <TypingCursor />}
    </div>
  );
}

function InputEcho({ target, input, showCursor = false }: { target: string; input: string; showCursor?: boolean }) {
  const targetChars = splitTypeableChars(target);
  let inputIndex = 0;
  const formattedInput = splitChars(applyTargetLineBreaks(input, target));
  return (
    <div className="input-echo" aria-label="입력 표시">
      {formattedInput.map((char, index) => {
        if (char === "\n") return <span key={`line-${index}`} className="line-break" aria-hidden="true" />;
        const targetChar = targetChars[inputIndex];
        inputIndex += 1;
        return (
          <span key={`${char}-${index}`} className={targetChar === char ? "correct" : "wrong"}>
            {char === " " ? "\u00A0" : char}
          </span>
        );
      })}
      {showCursor && <TypingCursor />}
    </div>
  );
}

function TypingCursor() {
  return (
    <span className="typing-cursor-anchor" aria-hidden="true">
      <span className="typing-cursor" />
    </span>
  );
}

function Metric({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{unit}</em>
    </div>
  );
}

function formatDisplayNumber(value: string | number | null | undefined, digits = 1, fixed = false): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  const factor = 10 ** digits;
  const truncated = Math.trunc(numeric * factor) / factor;
  return fixed ? truncated.toFixed(digits) : String(truncated);
}

function formatDisplayMs(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  return formatDisplayNumber(safe / 1000, 2, true);
}

function formatRecordDisplay(ms: number, charCount: number): string {
  const chars = Number.isFinite(charCount) ? Math.max(0, Math.trunc(charCount)) : 0;
  return `${formatDisplayMs(ms)}초, ${chars.toLocaleString("ko-KR")}글자`;
}

function ResultScreen({
  result,
  assetBaseUrl,
  autoHomeSeconds,
  onRetry,
  onHome
}: {
  result: GameResult;
  assetBaseUrl: string;
  autoHomeSeconds: number;
  onRetry: () => void;
  onHome: () => void;
}) {
  const totalChars = result.stageTexts.reduce((sum, text) => sum + countTypeableChars(text), 0);
  const totalMs = result.stageTimes.reduce((sum, time) => sum + time, 0);
  const totalTypingUnits = result.stageTexts.reduce((sum, text) => sum + countConvertedTypingUnits(text), 0);
  const finalCpm = result.row ? result.row.final_cpm : String(calculateFinalCpm(totalTypingUnits, totalMs));
  const phoneFull = buildPhoneFull(result.participant.phone1, result.participant.phone2, result.participant.phone3);
  const birthdate = formatBirthdate(result.participant.birthYear, result.participant.birthMonth, result.participant.birthDay);
  const stageCharCounts = result.stageTexts.map((text) => countTypeableChars(text));

  return (
    <section className="result-panel">
      <FallbackAssetImage
        src={`${assetBaseUrl}/normal_typing/normal_title_oneline_trimmed.png`}
        fallbackSrc={`${assetBaseUrl}/normal_typing/normal_typing_title.png`}
        alt="일잘러 타자왕은 누구!?"
        className="result-title-image normal-title-image"
      />
      <p className="eyebrow">2026 일잘러 페스타 타자왕 결과</p>
      <h1>{result.participant.name}님의 기록</h1>
      {result.saveError && <p className="error-text">{result.saveError}</p>}
      {result.debugModeType && (
        <p className="notice-text debug-result-note">디버그 모드 기록은 리더보드에 반영되지 않습니다.</p>
      )}
      <p className="notice-text auto-home-notice">{autoHomeSeconds}초뒤 메인화면으로 이동</p>
      <div className="result-grid">
        <div className="result-row result-row-3">
        <div className="result-tile">
          <span>휴대폰번호</span>
          <strong>{phoneFull.replace(/-(\d{3,4})-/, "-****-")}</strong>
        </div>
        <div className="result-tile">
          <span>생년월일</span>
          <strong>{birthdate.replace(/-\d{2}-\d{2}$/, "-**-**")}</strong>
        </div>
        <div className="result-tile">
          <span>순위</span>
          <strong>{result.rankLabel ?? "-"}</strong>
        </div>
        </div>
        <div className="result-row result-row-4">
        <div className="result-tile">
          <span>스테이지1</span>
          <strong>{formatRecordDisplay(result.stageTimes[0], stageCharCounts[0])}</strong>
        </div>
        <div className="result-tile">
          <span>스테이지2</span>
          <strong>{formatRecordDisplay(result.stageTimes[1], stageCharCounts[1])}</strong>
        </div>
        <div className="result-tile">
          <span>스테이지3</span>
          <strong>{formatRecordDisplay(result.stageTimes[2], stageCharCounts[2])}</strong>
        </div>
        <div className="result-tile highlight-result">
          <span>최종기록</span>
          <strong>{formatRecordDisplay(totalMs, totalChars)}</strong>
        </div>
        </div>
        <div className="result-row result-row-3">
        <div className="result-tile">
          <span>총 입력 글자수</span>
          <strong>{totalChars.toLocaleString("ko-KR")}글자</strong>
        </div>
        <div className="result-tile">
          <span>최종 타수</span>
          <strong>{formatDisplayNumber(finalCpm, 2)}타/분</strong>
        </div>
        <div className="result-tile">
          <span>정확도</span>
          <strong>100%</strong>
        </div>
        </div>
      </div>
      <div className="button-row">
        <button className="primary-button large" onClick={onRetry}>다시 도전</button>
        <button className="secondary-button large" onClick={onHome}>처음으로</button>
      </div>
    </section>
  );
}
