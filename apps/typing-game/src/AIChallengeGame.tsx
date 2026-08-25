import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppConfig, RecordRow, SaveRecordInput } from "../../../shared/types";
import { formatBirthdate } from "../../../shared/utils/date";
import { buildPhoneFull } from "../../../shared/utils/masking";
import {
  calculateAccuracy,
  calculateCurrentCpm,
  calculateFinalCpm,
  applyTargetLineBreaks,
  countConvertedTypingUnits,
  countMatchingPrefixTypingUnits,
  countTypeableChars,
  getTextPrefixByTypingUnits,
  isExactMatch,
  isLineProgressAllowed,
  splitChars,
  splitTypeableChars,
  stripDisplayLineBreaks
} from "../../../shared/utils/typing";

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

type StageBattle = {
  stage: number;
  text: string;
  userTimeMs: number;
  userCpm: number;
  userAccuracy: number;
  aiTimeMs: number;
  aiElapsedMs: number;
  aiCpm: number;
  aiTypedUnits: number;
  aiTypedChars: number;
  result: "USER_WIN" | "AI_WIN";
  userInput: string;
};

type AiSpeedSegment = {
  startMs: number;
  endMs: number;
  startUnits: number;
  endUnits: number;
  cpm: number | null;
};

type AiPlan = {
  segments: AiSpeedSegment[];
  inputDoneMs: number;
  enterDoneMs: number;
  averageCpm: number;
};

type Props = {
  config: AppConfig;
  participant: Participant;
  stageTexts: [string, string, string];
  assetBaseUrl: string;
  debugModeType?: "" | "normal_typing_debug" | "ai_challenge_debug";
  onHome: () => void;
  onRetry: () => void;
};

const MAIN_CONFIRM_MESSAGE = "진행 중인 게임을 종료하고 메인 화면으로 이동하시겠습니까? 중단 시점까지 참여자 패배 기록으로 저장됩니다.";
const RETRY_CONFIRM_MESSAGE = "현재 게임을 처음부터 다시 시작하시겠습니까? 중단 시점까지 참여자 패배 기록으로 저장됩니다.";
type ChallengeControlAction = "home" | "retry";

export function AIChallengeGame({ config, participant, stageTexts, assetBaseUrl, debugModeType = "", onHome, onRetry }: Props) {
  const [stageIndex, setStageIndex] = useState(0);
  const [countdown, setCountdown] = useState<string>(String(config.aiChallenge.countdownSeconds));
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [composing, setComposing] = useState(false);
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState("");
  const [aiPlan, setAiPlan] = useState<AiPlan | null>(null);
  const [battles, setBattles] = useState<StageBattle[]>([]);
  const [modalBattle, setModalBattle] = useState<StageBattle | null>(null);
  const [pendingControlAction, setPendingControlAction] = useState<ChallengeControlAction | null>(null);
  const [controlSaving, setControlSaving] = useState(false);
  const [savedRow, setSavedRow] = useState<RecordRow | null>(null);
  const [saveError, setSaveError] = useState("");
  const [autoHomeSeconds, setAutoHomeSeconds] = useState(10);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const inputValueRef = useRef("");
  const stageStartRef = useRef(0);
  const finishedRef = useRef(false);
  const countdownIntervalRef = useRef(0);
  const countdownClearRef = useRef(0);
  const controlPausedAtRef = useRef(0);
  const controlWasRunningRef = useRef(false);
  const controlSavingRef = useRef(false);

  const target = stageTexts[stageIndex];
  const targetLength = countTypeableChars(target);
  const targetTypingUnits = countConvertedTypingUnits(target);
  const elapsedMs = running ? performance.now() - stageStartRef.current : 0;
  const aiTimeMs = aiPlan?.enterDoneMs ?? 0;
  const aiSnapshot = getAiSnapshot(aiPlan, elapsedMs, targetTypingUnits);
  const aiTypedUnits = running ? aiSnapshot.typedUnits : 0;
  const aiInput = getTextPrefixByTypingUnits(target, aiTypedUnits);
  const aiProgress = targetLength === 0 ? 0 : Math.min(100, (countTypeableChars(aiInput) / targetLength) * 100);
  const userProgress = targetLength === 0 ? 0 : Math.min(100, (countTypeableChars(input) / targetLength) * 100);
  const userAccuracy = calculateAccuracy(input, target);
  const userCpm = calculateCurrentCpm(input, elapsedMs, target);
  const aiObservedCpm = running ? calculateCurrentCpm(aiInput, elapsedMs, target) : null;

  const resultReady =
    !modalBattle &&
    battles.length === 3 &&
    battles.every((battle) => battle.result === "USER_WIN") &&
    (savedRow != null || saveError !== "");

  useEffect(() => {
    beginStage(stageIndex);
    return () => clearCountdownTimers();
  }, [stageIndex]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setTick((value) => value + 1);
      const nowElapsed = performance.now() - stageStartRef.current;
      if (!finishedRef.current && nowElapsed >= aiTimeMs) {
        void finishStage("AI_WIN", aiTimeMs);
      }
    }, 80);
    return () => window.clearInterval(timer);
  }, [aiTimeMs, running]);

  useEffect(() => {
    if (running) queueChallengeInputFocus();
  }, [running, stageIndex]);

  useEffect(() => {
    if (!running || composing || finishedRef.current || !isExactMatch(input, target)) return;
    const userTime = performance.now() - stageStartRef.current;
    void finishStage(userTime <= aiTimeMs ? "USER_WIN" : "AI_WIN", userTime);
  }, [aiTimeMs, composing, input, running, target]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!resultReady) return;
    const endAt = Date.now() + 10000;
    setAutoHomeSeconds(10);
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      setAutoHomeSeconds(remaining);
      if (remaining <= 0) {
        window.clearInterval(timer);
        leaveChallenge("home");
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resultReady]);

  function clearCountdownTimers() {
    if (countdownIntervalRef.current) {
      window.clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = 0;
    }
    if (countdownClearRef.current) {
      window.clearTimeout(countdownClearRef.current);
      countdownClearRef.current = 0;
    }
  }

  function focusChallengeInput() {
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

  function queueChallengeInputFocus() {
    const run = () => {
      focusChallengeInput();
      window.setTimeout(focusChallengeInput, 0);
      window.setTimeout(focusChallengeInput, 60);
      window.setTimeout(focusChallengeInput, 160);
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(run);
      return;
    }
    window.setTimeout(run, 0);
  }

  function beginStage(nextStageIndex: number) {
    clearCountdownTimers();
    const nextTargetUnits = countConvertedTypingUnits(stageTexts[nextStageIndex]);
    setAiPlan(createAiPlan(nextStageIndex + 1, nextTargetUnits, config, debugModeType === "ai_challenge_debug"));
    setInput("");
    inputValueRef.current = "";
    setRunning(false);
    setModalBattle(null);
    finishedRef.current = false;
    const seconds = Math.max(1, Math.floor(config.aiChallenge.countdownSeconds || 3));
    let current = seconds;
    setCountdown(String(current));
    countdownIntervalRef.current = window.setInterval(() => {
      current -= 1;
      if (current > 0) {
        setCountdown(String(current));
        return;
      }
      if (current === 0) {
        window.clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = 0;
        setCountdown("START");
        stageStartRef.current = performance.now();
        setRunning(true);
        queueChallengeInputFocus();
        countdownClearRef.current = window.setTimeout(() => {
          setCountdown("");
          countdownClearRef.current = 0;
        }, 520);
        return;
      }
    }, 1000);
  }

  function requestChallengeControl(action: ChallengeControlAction) {
    if (controlSavingRef.current) return;
    controlPausedAtRef.current = performance.now();
    controlWasRunningRef.current = running;
    if (running) setRunning(false);
    setPendingControlAction(action);
  }

  function cancelChallengeControl() {
    if (controlSavingRef.current) return;
    const pausedMs = performance.now() - controlPausedAtRef.current;
    setPendingControlAction(null);
    if (controlWasRunningRef.current) {
      stageStartRef.current += pausedMs;
      setRunning(true);
      queueChallengeInputFocus();
    }
  }

  async function saveInterruptedChallenge(action: ChallengeControlAction) {
    if (savedRow != null || saveError !== "") return;
    const currentElapsed = controlWasRunningRef.current
      ? Math.max(0, controlPausedAtRef.current - stageStartRef.current)
      : 0;
    const currentInput = inputValueRef.current;
    const currentAiSnapshot = getAiSnapshot(aiPlan, currentElapsed, targetTypingUnits);
    const currentAiInput = getTextPrefixByTypingUnits(target, currentAiSnapshot.typedUnits);
    const interruptedBattle: StageBattle = {
      stage: stageIndex + 1,
      text: target,
      userTimeMs: currentElapsed,
      userCpm: calculateCurrentCpm(currentInput, currentElapsed, target),
      userAccuracy: calculateAccuracy(currentInput, target),
      aiTimeMs: currentElapsed,
      aiElapsedMs: currentElapsed,
      aiCpm: calculateFinalCpm(currentAiSnapshot.typedUnits, currentElapsed),
      aiTypedUnits: currentAiSnapshot.typedUnits,
      aiTypedChars: countTypeableChars(currentAiInput),
      result: "AI_WIN",
      userInput: currentInput
    };
    const battleRows = battles.some((battle) => battle.stage === interruptedBattle.stage)
      ? battles
      : [...battles, interruptedBattle];
    await saveChallenge(battleRows, "FAILED", String(stageIndex + 1), action);
  }

  async function confirmChallengeControl() {
    if (!pendingControlAction || controlSavingRef.current) return;
    const action = pendingControlAction;
    controlSavingRef.current = true;
    setControlSaving(true);
    await saveInterruptedChallenge(action);
    setPendingControlAction(null);
    controlSavingRef.current = false;
    setControlSaving(false);
    leaveChallenge(action);
  }

  function leaveChallenge(action: ChallengeControlAction) {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    inputRef.current = null;
    inputValueRef.current = "";
    finishedRef.current = true;
    clearCountdownTimers();
    setToast("");
    setCountdown("");
    setRunning(false);
    setModalBattle(null);
    if (action === "home") {
      onHome();
      return;
    }
    onRetry();
  }

  function handleInput(next: string) {
    if (!running) return;
    if (next.includes("\t")) return;
    const nextInput = stripDisplayLineBreaks(next);
    if (countTypeableChars(nextInput) > targetLength) {
      setToast("제시문보다 더 긴 문장은 입력할 수 없습니다.");
      return;
    }
    if (!isLineProgressAllowed(nextInput, target)) return;
    inputValueRef.current = nextInput;
    setInput(nextInput);
    if (!finishedRef.current && isExactMatch(nextInput, target)) {
      const userTime = performance.now() - stageStartRef.current;
      void finishStage(userTime <= aiTimeMs ? "USER_WIN" : "AI_WIN", userTime);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
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

  async function finishStage(result: "USER_WIN" | "AI_WIN", userElapsedMs: number) {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setRunning(false);
    const userInput = inputValueRef.current;
    const aiElapsedMs = result === "AI_WIN" ? aiTimeMs : userElapsedMs;
    const aiTypedUnitsAtFinish = result === "AI_WIN"
      ? targetTypingUnits
      : getAiSnapshot(aiPlan, userElapsedMs, targetTypingUnits).typedUnits;
    const aiInputAtFinish = getTextPrefixByTypingUnits(target, aiTypedUnitsAtFinish);
    const stageBattle: StageBattle = {
      stage: stageIndex + 1,
      text: target,
      userTimeMs: userElapsedMs,
      userCpm: calculateCurrentCpm(userInput, userElapsedMs, target),
      userAccuracy: calculateAccuracy(userInput, target),
      aiTimeMs,
      aiElapsedMs,
      aiCpm: calculateFinalCpm(aiTypedUnitsAtFinish, aiElapsedMs),
      aiTypedUnits: aiTypedUnitsAtFinish,
      aiTypedChars: countTypeableChars(aiInputAtFinish),
      result,
      userInput
    };
    const nextBattles = [...battles, stageBattle];
    setBattles(nextBattles);
    if (result === "USER_WIN") {
      if (stageIndex === 2) {
        const saved = await saveChallenge(nextBattles, "SUCCESS", "");
        setSavedRow(saved.row ?? null);
        setSaveError(saved.error ?? "");
      }
      setModalBattle(stageBattle);
      return;
    }
    setModalBattle(stageBattle);
    const saved = await saveChallenge(nextBattles, "FAILED", String(stageIndex + 1));
    setSavedRow(saved.row ?? null);
    setSaveError(saved.error ?? "");
  }

  async function continueAfterWin() {
    if (!modalBattle) return;
    if (stageIndex < 2) {
      setStageIndex((value) => value + 1);
      return;
    }
    const finalBattles = battles.some((battle) => battle.stage === modalBattle.stage)
      ? battles
      : [...battles, modalBattle];
    if (savedRow == null && saveError === "") {
      const saved = await saveChallenge(finalBattles, "SUCCESS", "");
      setSavedRow(saved.row ?? null);
      setSaveError(saved.error ?? "");
    }
    setModalBattle(null);
  }

  async function saveChallenge(
    battleRows: StageBattle[],
    status: "SUCCESS" | "FAILED",
    failedStage: string,
    interruptionAction?: ChallengeControlAction
  ): Promise<{ row?: RecordRow; error?: string }> {
    const userTimes: [number, number, number] = [0, 0, 0];
    const aiTimes: [number | null, number | null, number | null] = [null, null, null];
    const aiCpms: [number | null, number | null, number | null] = [null, null, null];
    const results: ["" | "USER_WIN" | "AI_WIN", "" | "USER_WIN" | "AI_WIN", "" | "USER_WIN" | "AI_WIN"] = ["", "", ""];
    const diffs: [number | null, number | null, number | null] = [null, null, null];
    battleRows.forEach((battle) => {
      const index = battle.stage - 1;
      userTimes[index] = battle.userTimeMs;
      aiTimes[index] = battle.aiTimeMs;
      aiCpms[index] = battle.aiCpm;
      results[index] = battle.result;
      diffs[index] = battle.userTimeMs - battle.aiTimeMs;
    });
    const userTotal = userTimes.reduce((sum, value) => sum + value, 0);
    const aiTotal = aiTimes.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const lastAccuracy = battleRows.at(-1)?.userAccuracy ?? 0;
    const aiDisplay = buildChallengeDisplayMetrics(battleRows, status, failedStage, Boolean(interruptionAction));
    const stageCharCounts = battleRows.reduce<[number, number, number]>((counts, battle) => {
      counts[battle.stage - 1] = battleUserCharCount(battle);
      return counts;
    }, [0, 0, 0]);
    const interruptedTypingUnits = battleRows.reduce((sum, battle) => {
      return sum + (battle.result === "USER_WIN"
        ? countConvertedTypingUnits(battle.text)
        : countMatchingPrefixTypingUnits(battle.userInput, battle.text));
    }, 0);
    const saveInput: SaveRecordInput = {
      participant_name: participant.name,
      phone_part1: participant.phone1,
      phone_part2: participant.phone2,
      phone_part3: participant.phone3,
      birth_year: participant.birthYear,
      birth_month: participant.birthMonth,
      birth_day: participant.birthDay,
      privacy_agreed: true,
      privacy_agreed_at: participant.privacyAgreedAt,
      stageTexts,
      stageTimesMs: userTimes,
      game_mode: "ai_challenge",
      final_accuracy: status === "SUCCESS" ? 100 : Math.round(lastAccuracy),
      ai: {
        status,
        failedStage,
        stageCpms: aiCpms,
        stageTimesMs: aiTimes,
        stageResults: results,
        finalResult: status === "SUCCESS" ? "USER_WIN" : "AI_WIN",
        stageDiffsMs: diffs,
        finalDiffMs: userTotal - aiTotal,
        display: aiDisplay
      },
      is_debug: debugModeType === "ai_challenge_debug",
      debug_mode_type: debugModeType === "ai_challenge_debug" ? debugModeType : "",
      interruption: interruptionAction
        ? {
            action: interruptionAction,
            resultStage: Number(failedStage) || stageIndex + 1,
            participantProgressPercent: aiDisplay.participantProgressPercent,
            stageCharCounts,
            totalTypingUnits: interruptedTypingUnits
          }
        : undefined
    };
    const saved = await window.typingKing.saveRecord(saveInput);
    if (saved.ok && saved.data) return { row: saved.data };
    return { error: saved.error || "기록 저장에 실패했습니다. 복구 파일에 임시 저장합니다." };
  }

  if (resultReady) {
    return (
      <section className="challenge-result-panel">
        <AiTitle assetBaseUrl={assetBaseUrl} className="challenge-result-title" />
        <p className="eyebrow">AI 챌린지 성공</p>
        <h1>인간 승리. AI보다 빠르고 정확하게 완주했습니다.</h1>
        {debugModeType === "ai_challenge_debug" && (
          <p className="notice-text debug-result-note">디버그 모드 기록은 리더보드에 반영되지 않습니다.</p>
        )}
        <AssetImage
          src={`${assetBaseUrl}/ai_challenge/ai_boss_defeat.png`}
          alt="패배한 AI"
          className="challenge-result-art"
        />
        {saveError && <p className="error-text">{saveError}</p>}
        <p className="notice-text auto-home-notice">{autoHomeSeconds}초뒤 메인화면으로 이동</p>
        <ChallengeSummary battles={battles} row={savedRow} participant={participant} assetBaseUrl={assetBaseUrl} />
        <div className="button-row">
          <button className="primary-button large" onClick={() => leaveChallenge("retry")}>다시 도전하기</button>
          <button className="secondary-button large" onClick={() => leaveChallenge("home")}>메인화면으로 가기</button>
        </div>
      </section>
    );
  }

  return (
    <section className="challenge-screen">
      <header className="challenge-top challenge-top-repositioned">
        <div className="challenge-title-side">
          <AiTitle assetBaseUrl={assetBaseUrl} className="challenge-title-image" />
        </div>
        <div className="challenge-stage-center">
          <StageBadges assetBaseUrl={assetBaseUrl} currentStage={stageIndex + 1} completedStages={battles.map((battle) => battle.stage)} />
          <p className="eyebrow">AI 타자왕을 이겨라</p>
        </div>
        <strong>{countdown || (running ? "대결 중" : "결과 확인")}</strong>
        <div className="button-row game-control-row challenge-game-controls">
          <button className="secondary-button game-retry-button" onClick={() => requestChallengeControl("retry")}>
            다시하기
          </button>
          <button className="primary-button game-main-button" onClick={() => requestChallengeControl("home")}>
            메인으로 가기
          </button>
        </div>
      </header>
      <div className="challenge-boss-float">
        <AssetImage
          src={`${assetBaseUrl}/ai_challenge/ai_boss_typing.png`}
          alt="타자를 입력하는 AI"
          className={aiProgress > userProgress ? "ai-boss-typing is-ahead" : "ai-boss-typing"}
        />
      </div>
      <div className="challenge-layout">
        <DuelPanel
          title="참여자"
          target={target}
          input={input}
          cpm={userCpm}
          accuracy={userAccuracy}
          progress={userProgress}
          elapsedMs={elapsedMs}
          active
        >
          <div className="duel-input-layer">
            <div className="duel-input-highlight" aria-hidden="true">
              <ColorChars target={target} input={input} includePending={false} showCursor={running} />
            </div>
            <textarea
              ref={inputRef}
              className="typing-input challenge-input layered-input"
              value={applyTargetLineBreaks(input, target)}
              disabled={!running}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => handleInput(event.target.value)}
              onKeyDown={onKeyDown}
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
        </DuelPanel>

        <div className="versus-column">
          {!countdown && (
            <AssetImage
              src={`${assetBaseUrl}/ai_challenge/vs_badge.png`}
              alt="VS"
              className="vs-badge"
              fallback={<span className="vs-fallback">VS</span>}
            />
          )}
        </div>

        <DuelPanel
          title="AI 타자왕"
          target={target}
          input={aiInput}
          cpm={aiObservedCpm}
          accuracy={Math.min(100, aiProgress)}
          progress={aiProgress}
          elapsedMs={running ? Math.min(elapsedMs, aiTimeMs) : 0}
          active={false}
        >
          <div className="ai-typing-line">
            {aiInput ? <ColorChars target={target} input={aiInput} includePending={false} /> : "AI 입력 대기 중"}
          </div>
        </DuelPanel>
      </div>
      {countdown && <div className="countdown-overlay">{countdown}</div>}
      {toast && <div className="toast">{toast}</div>}
      {pendingControlAction && (
        <ChallengeControlConfirmModal
          action={pendingControlAction}
          saving={controlSaving}
          onCancel={cancelChallengeControl}
          onConfirm={() => void confirmChallengeControl()}
        />
      )}
      <p className="challenge-guide">문장 전체가 100% 일치하면 자동으로 완료됩니다. AI보다 먼저 완성하세요.</p>
      {modalBattle && (
        <BattlePopup
          battle={modalBattle}
          isFinalWin={modalBattle.result === "USER_WIN" && modalBattle.stage === 3}
          onNext={continueAfterWin}
          onRetry={() => leaveChallenge("retry")}
          onHome={() => leaveChallenge("home")}
          saveError={saveError}
          assetBaseUrl={assetBaseUrl}
          isDebug={debugModeType === "ai_challenge_debug"}
        />
      )}
    </section>
  );
}

function DuelPanel({
  title,
  target,
  input,
  cpm,
  accuracy,
  progress,
  elapsedMs,
  active,
  media,
  children
}: {
  title: string;
  target: string;
  input: string;
  cpm: number | null;
  accuracy: number;
  progress: number;
  elapsedMs: number;
  active: boolean;
  media?: ReactNode;
  children: ReactNode;
}) {
  const cpmText = cpm == null ? "대기 중" : formatDisplayNumber(cpm, 1);
  const denseCopy = target
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => splitTypeableChars(line).length > 24);
  const panelClass = `${active ? "duel-panel user-duel" : "duel-panel ai-duel"}${denseCopy ? " dense-copy" : ""}`;
  return (
    <article className={panelClass}>
      <header className={media ? "duel-panel-header has-media" : "duel-panel-header"}>
        <h2>{title}</h2>
        {media && <div className="duel-header-media">{media}</div>}
        <span>{formatDisplayNumber(progress, 1, true)}%</span>
      </header>
      <DuelTarget target={target} input={input} showCursor={active} />
      {children}
      <div className="duel-progress">
        <i style={{ width: `${Math.min(100, progress)}%` }} />
      </div>
      <div className="duel-metrics">
        <span>타수 <strong>{cpmText}</strong>{cpm == null ? "" : "타/분"}</span>
        <span>정확도 <strong>{formatDisplayNumber(accuracy, 1, true)}</strong>%</span>
        <span>시간 <strong>{formatDisplayMs(elapsedMs)}</strong>초</span>
      </div>
    </article>
  );
}

function DuelTarget({ target, input, showCursor }: { target: string; input: string; showCursor: boolean }) {
  return (
    <div className="duel-target">
      <ColorChars target={target} input={input} includePending showCursor={showCursor} />
    </div>
  );
}

function ColorChars({
  target,
  input,
  includePending = false,
  showCursor = false
}: {
  target: string;
  input: string;
  includePending?: boolean;
  showCursor?: boolean;
}) {
  const targetChars = splitTypeableChars(target);
  const inputChars = splitTypeableChars(input);
  if (includePending) {
    let inputIndex = 0;
    return (
      <>
        {target.replace(/\r\n/g, "\n").split("\n").flatMap((line, lineIndex, lines) => {
          const chars = splitTypeableChars(line).flatMap((char) => {
            const typed = inputChars[inputIndex];
            const state = typed == null ? "pending" : typed === char ? "correct" : "wrong";
            const charIndex = inputIndex;
            const nodes = [
              showCursor && charIndex === inputChars.length
                ? <TypingCursor key={`cursor-${inputIndex}`} />
                : null,
                <span key={`${lineIndex}-${char}-${inputIndex}`} className={state}>
                  {char === " " ? "\u00A0" : char}
                </span>
            ];
            inputIndex += 1;
            return nodes;
          });
          if (showCursor && inputIndex === inputChars.length && line.length === 0) {
            chars.push(<TypingCursor key={`cursor-empty-${lineIndex}`} />);
          }
          if (lineIndex < lines.length - 1) {
            chars.push(<span key={`line-${lineIndex}`} className="line-break" aria-hidden="true" />);
          }
          return chars;
        })}
        {showCursor && inputChars.length >= targetChars.length && <TypingCursor />}
      </>
    );
  }

  let inputIndex = 0;
  return (
    <>
      {splitChars(applyTargetLineBreaks(input, target)).map((char, index) => {
        if (char === "\n") return <span key={`line-${index}`} className="line-break" aria-hidden="true" />;
        const targetChar = targetChars[inputIndex];
        inputIndex += 1;
        const state = targetChar === char ? "correct" : "wrong";
        return (
          <span key={`${char}-${index}`} className={state}>
            {char === " " ? "\u00A0" : char}
          </span>
        );
      })}
      {showCursor && <TypingCursor />}
    </>
  );
}

function TypingCursor() {
  return (
    <span className="typing-cursor-anchor" aria-hidden="true">
      <span className="typing-cursor" />
    </span>
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

function buildChallengeDisplayMetrics(
  battleRows: StageBattle[],
  status: "SUCCESS" | "FAILED",
  failedStage: string,
  interrupted = false
) {
  const resultStage = status === "SUCCESS"
    ? 3
    : Number(failedStage) || battleRows.at(-1)?.stage || 1;
  const relevantBattles = battleRows.filter((battle) => battle.stage <= resultStage);
  const participantProgresses = [0, 0, 0];
  const aiProgresses = [0, 0, 0];
  let participantTypedChars = 0;
  let participantElapsedMs = 0;
  let aiTypedChars = 0;
  let aiElapsedMs = 0;
  let duelTimeMs = 0;
  relevantBattles.forEach((battle) => {
    const stageIndex = battle.stage - 1;
    const charCount = countTypeableChars(battle.text);
    const typingUnitCount = countConvertedTypingUnits(battle.text);
    const stageAiTypedChars = battle.result === "AI_WIN" && !interrupted
      ? charCount
      : Math.min(charCount, battle.aiTypedChars);
    const stageAiTypedUnits = battle.result === "AI_WIN" && !interrupted
      ? typingUnitCount
      : Math.min(typingUnitCount, battle.aiTypedUnits);
    const userProgress = charCount > 0
      ? Math.min(100, (countTypeableChars(battle.userInput) / charCount) * 100)
      : 100;
    const aiProgress = battle.result === "AI_WIN" && !interrupted
      ? 100
      : charCount > 0
        ? Math.min(100, (stageAiTypedChars / charCount) * 100)
        : 0;
    participantProgresses[stageIndex] = battle.result === "USER_WIN" ? 100 : userProgress;
    aiProgresses[stageIndex] = aiProgress;
    participantTypedChars += battle.result === "USER_WIN"
      ? typingUnitCount
      : countMatchingPrefixTypingUnits(battle.userInput, battle.text);
    participantElapsedMs += battle.userTimeMs;
    aiTypedChars += stageAiTypedUnits;
    aiElapsedMs += battle.aiElapsedMs;
    duelTimeMs += battle.result === "AI_WIN" && !interrupted ? battle.aiTimeMs : battle.userTimeMs;
  });
  const participantTimes = relevantBattles.map((battle) => {
    if (!interrupted && status === "FAILED" && battle.stage === resultStage && battle.result === "AI_WIN") {
      return estimateStageTimeMs(battle.text, battle.userCpm);
    }
    return Number.isFinite(battle.userTimeMs) ? battle.userTimeMs : null;
  });
  const aiTimes = relevantBattles.map((battle) => Number.isFinite(battle.aiElapsedMs) ? battle.aiElapsedMs : null);
  const participantProgressPercent = status === "SUCCESS" ? 100 : averageProgress(participantProgresses);
  const aiProgressPercent = status === "FAILED" && !interrupted ? 100 : averageProgress(aiProgresses);
  return {
    participantResultTimeMs: sumNullable(participantTimes),
    aiResultTimeMs: sumNullable(aiTimes),
    participantAvgCpm: participantElapsedMs > 0
      ? Math.round((participantTypedChars / participantElapsedMs) * 60000)
      : averagePositive(relevantBattles.map((battle) => battle.userCpm)),
    aiAvgCpm: aiElapsedMs > 0
      ? Math.round((aiTypedChars / aiElapsedMs) * 60000)
      : averagePositive(relevantBattles.map((battle) => battle.aiCpm)),
    resultLabel: status === "SUCCESS" ? "참여자 승리" : interrupted ? "중단 패배" : "참여자 패배",
    participantProgressPercent,
    aiProgressPercent,
    duelTimeMs,
    resultStage
  };
}

function estimateStageTimeMs(text: string, cpm: number): number | null {
  if (!Number.isFinite(cpm) || cpm <= 0) return null;
  return (countConvertedTypingUnits(text) / cpm) * 60000;
}

function sumNullable(values: Array<number | null>): number | null {
  if (values.length === 0 || values.some((value) => value == null || !Number.isFinite(value))) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function averagePositive(values: number[]): number | null {
  const positive = values.filter((value) => Number.isFinite(value) && value > 0);
  if (positive.length === 0) return null;
  return positive.reduce((sum, value) => sum + value, 0) / positive.length;
}

function averageProgress(values: number[]): number {
  const average = values.reduce((sum, value) => sum + Math.max(0, Math.min(100, value)), 0) / 3;
  return Math.round(average * 10) / 10;
}

function battleUserCharCount(battle: StageBattle): number {
  return battle.result === "USER_WIN"
    ? countTypeableChars(battle.text)
    : countTypeableChars(battle.userInput);
}

function battleAiCharCount(battle: StageBattle): number {
  const targetChars = countTypeableChars(battle.text);
  return battle.result === "AI_WIN" ? targetChars : Math.min(targetChars, battle.aiTypedChars);
}

function BattlePopup({
  battle,
  isFinalWin,
  onNext,
  onRetry,
  onHome,
  saveError,
  assetBaseUrl,
  isDebug
}: {
  battle: StageBattle;
  isFinalWin: boolean;
  onNext: () => void;
  onRetry: () => void;
  onHome: () => void;
  saveError: string;
  assetBaseUrl: string;
  isDebug: boolean;
}) {
  const userWin = battle.result === "USER_WIN";
  const [autoHomeSeconds, setAutoHomeSeconds] = useState(10);
  useEffect(() => {
    if (userWin) return;
    const endAt = Date.now() + 10000;
    setAutoHomeSeconds(10);
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      setAutoHomeSeconds(remaining);
      if (remaining <= 0) {
        window.clearInterval(timer);
        onHome();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [onHome, userWin]);

  return (
    <div className="modal-backdrop">
      <section className="modal challenge-modal">
        <div className="challenge-modal-lead">
          <AssetImage
            src={`${assetBaseUrl}/ai_challenge/${userWin ? "ai_boss_defeat.png" : "ai_boss_victory.png"}`}
            alt={userWin ? "패배한 AI" : "승리한 AI"}
            className="challenge-modal-art"
          />
          <div>
            <StageBadges assetBaseUrl={assetBaseUrl} currentStage={battle.stage} completedStages={userWin ? [battle.stage] : []} compact />
            <p className="eyebrow">Stage {battle.stage}</p>
            <h2>{userWin ? "승리했습니다. AI보다 빠르게 입력했습니다." : "아쉽습니다. AI가 먼저 입력을 완료했습니다."}</h2>
          </div>
        </div>
        <div className="battle-stats">
          <span>사용자 기록 <strong>{formatRecordDisplay(battle.userTimeMs, battleUserCharCount(battle))}</strong></span>
          <span>AI 기록 <strong>{formatRecordDisplay(battle.aiElapsedMs, battleAiCharCount(battle))}</strong></span>
          <span>{userWin ? "사용자 타수" : "사용자 현재 타수"} <strong>{formatDisplayNumber(battle.userCpm, 2)}타/분</strong></span>
          <span>AI 평균 타수 <strong>{formatDisplayNumber(battle.aiCpm, 2)}타/분</strong></span>
        </div>
        {isDebug && <p className="notice-text debug-result-note">디버그 모드 기록은 리더보드에 반영되지 않습니다.</p>}
        {saveError && <p className="error-text">{saveError}</p>}
        {!userWin && <p className="notice-text auto-home-notice">{autoHomeSeconds}초뒤 메인화면으로 이동</p>}
        <div className="button-row">
          {userWin ? (
            <button className="primary-button" onClick={onNext}>
              {isFinalWin ? "최종 결과 보기" : "다음 스테이지"}
            </button>
          ) : (
            <button className="primary-button" onClick={onRetry}>다시 도전하기</button>
          )}
          <button className="secondary-button" onClick={onHome}>메인화면으로 가기</button>
        </div>
      </section>
    </div>
  );
}

function ChallengeControlConfirmModal({
  action,
  saving,
  onCancel,
  onConfirm
}: {
  action: ChallengeControlAction;
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

function ChallengeSummary({
  battles,
  row,
  participant,
  assetBaseUrl
}: {
  battles: StageBattle[];
  row: RecordRow | null;
  participant: Participant;
  assetBaseUrl: string;
}) {
  const phone = buildPhoneFull(participant.phone1, participant.phone2, participant.phone3);
  const birth = formatBirthdate(participant.birthYear, participant.birthMonth, participant.birthDay);
  const userTotal = battles.reduce((sum, battle) => sum + battle.userTimeMs, 0);
  const aiTotal = battles.reduce((sum, battle) => sum + battle.aiElapsedMs, 0);
  const userCharTotal = battles.reduce((sum, battle) => sum + battleUserCharCount(battle), 0);
  const aiCharTotal = battles.reduce((sum, battle) => sum + battleAiCharCount(battle), 0);
  const totalTypingUnits = battles.reduce((sum, battle) => sum + countConvertedTypingUnits(battle.text), 0);
  return (
    <div className="challenge-summary">
      <div className="summary-identity">
        <span>참여자 <strong>{participant.name}</strong></span>
        <span>휴대폰번호 <strong>{phone.replace(/-(\d{3,4})-/, "-****-")}</strong></span>
        <span>생년월일 <strong>{birth.replace(/-\d{2}-\d{2}$/, "-**-**")}</strong></span>
      </div>
      {battles.map((battle) => (
        <div key={battle.stage}>
          <StageBadge assetBaseUrl={assetBaseUrl} stage={battle.stage} state="complete" compact />
          <strong>
            사용자 {formatRecordDisplay(battle.userTimeMs, battleUserCharCount(battle))} / AI {formatRecordDisplay(battle.aiElapsedMs, battleAiCharCount(battle))} / AI 평균 {formatDisplayNumber(battle.aiCpm, 2)}타
          </strong>
        </div>
      ))}
      <div className="highlight-result">
        <span>사용자 총 기록</span>
        <strong>{formatRecordDisplay(userTotal, userCharTotal)}</strong>
      </div>
      <div>
        <span>AI 총 기록</span>
        <strong>{formatRecordDisplay(aiTotal, aiCharTotal)}</strong>
      </div>
      <div>
        <span>사용자 최종 타수</span>
        <strong>{formatDisplayNumber(row?.final_cpm ?? calculateFinalCpm(totalTypingUnits, userTotal), 2)}타/분</strong>
      </div>
      <div>
        <span>최종 시간 차이</span>
        <strong>{formatDisplayMs(Math.abs(userTotal - aiTotal))}초</strong>
      </div>
    </div>
  );
}

function AiTitle({
  assetBaseUrl,
  className
}: {
  assetBaseUrl: string;
  className: string;
}) {
  return (
    <AssetImage
      src={`${assetBaseUrl}/ai_challenge/ai_title_oneline_trimmed.png`}
      fallbackSrc={`${assetBaseUrl}/ai_challenge/ai_challenge_title.png`}
      alt="AI 타자왕을 이겨라!"
      className={className}
      fallback={<div className="ai-title-fallback">AI 타자왕을 이겨라!</div>}
    />
  );
}

function StageBadges({
  assetBaseUrl,
  currentStage,
  completedStages,
  compact = false
}: {
  assetBaseUrl: string;
  currentStage: number;
  completedStages: number[];
  compact?: boolean;
}) {
  return (
    <div className={compact ? "stage-badge-row compact-badges" : "stage-badge-row"}>
      {[1, 2, 3].map((stage) => (
        <StageBadge
          key={stage}
          assetBaseUrl={assetBaseUrl}
          stage={stage}
          state={completedStages.includes(stage) ? "complete" : stage === currentStage ? "current" : "locked"}
          compact={compact}
        />
      ))}
    </div>
  );
}

function StageBadge({
  assetBaseUrl,
  stage,
  state,
  compact = false
}: {
  assetBaseUrl: string;
  stage: number;
  state: "current" | "complete" | "locked";
  compact?: boolean;
}) {
  return (
    <span className={`stage-badge ${state}${compact ? " compact" : ""}`}>
      <AssetImage
        src={`${assetBaseUrl}/ai_challenge/stage_badge_${stage}.png`}
        alt={`Stage ${stage}`}
        className="stage-badge-img"
        fallback={<span className="stage-badge-fallback">Stage {stage}</span>}
      />
      {state === "complete" && <i>✓</i>}
    </span>
  );
}

function AssetImage({
  src,
  fallbackSrc,
  alt,
  className,
  fallback
}: {
  src: string;
  fallbackSrc?: string;
  alt: string;
  className: string;
  fallback?: ReactNode;
}) {
  const [fallbackStep, setFallbackStep] = useState(0);
  if (fallbackStep > 0 && !fallbackSrc) return fallback ? <>{fallback}</> : null;
  if (fallbackStep > 1) return fallback ? <>{fallback}</> : null;
  return (
    <img
      src={fallbackStep === 0 ? src : fallbackSrc ?? src}
      alt={alt}
      className={className}
      draggable={false}
      onError={() => setFallbackStep((step) => step + 1)}
    />
  );
}

function createAiPlan(stage: number, targetTypingUnits: number, config: AppConfig, fixedDebugSpeed = false): AiPlan {
  const intervalMs = Math.max(100, Math.floor(config.aiChallenge.aiSpeedChangeIntervalMs ?? 500));
  const enterDelayMs = Math.max(0, Math.floor(config.aiChallenge.aiEnterDelayMs ?? 0));
  const segments: AiSpeedSegment[] = [];
  let elapsedMs = 0;
  let typedUnits = 0;

  if (targetTypingUnits <= 0) {
    return {
      segments,
      inputDoneMs: 0,
      enterDoneMs: enterDelayMs,
      averageCpm: 0
    };
  }

  while (typedUnits < targetTypingUnits && segments.length < 10000) {
    const cpm = createAiCpm(stage, config, fixedDebugSpeed);
    const unitsPerMs = cpm / 60000;
    const remainingUnits = targetTypingUnits - typedUnits;
    const fullIntervalUnits = unitsPerMs * intervalMs;
    const durationMs = fullIntervalUnits >= remainingUnits
      ? remainingUnits / unitsPerMs
      : intervalMs;
    const nextUnits = Math.min(targetTypingUnits, typedUnits + unitsPerMs * durationMs);

    segments.push({
      startMs: elapsedMs,
      endMs: elapsedMs + durationMs,
      startUnits: typedUnits,
      endUnits: nextUnits,
      cpm
    });

    elapsedMs += durationMs;
    typedUnits = nextUnits;
  }

  return {
    segments,
    inputDoneMs: elapsedMs,
    enterDoneMs: elapsedMs + enterDelayMs,
    averageCpm: calculateFinalCpm(targetTypingUnits, elapsedMs)
  };
}

function getAiSnapshot(
  plan: AiPlan | null,
  elapsedMs: number,
  targetTypingUnits: number
): { typedUnits: number; cpm: number } {
  if (!plan || plan.segments.length === 0 || targetTypingUnits <= 0) return { typedUnits: 0, cpm: 0 };
  const first = plan.segments[0];
  const last = plan.segments[plan.segments.length - 1];
  if (elapsedMs <= 0) return { typedUnits: 0, cpm: first.cpm ?? 0 };
  if (elapsedMs >= plan.inputDoneMs) return { typedUnits: targetTypingUnits, cpm: last.cpm ?? 0 };

  const segment =
    plan.segments.find((item) => elapsedMs >= item.startMs && elapsedMs < item.endMs) ?? last;
  const segmentElapsedMs = Math.max(0, elapsedMs - segment.startMs);
  const segmentCpm = segment.cpm ?? 0;
  const typed = segment.startUnits + (segmentCpm / 60000) * segmentElapsedMs;
  return {
    typedUnits: Math.min(targetTypingUnits, typed),
    cpm: segmentCpm
  };
}

function createAiCpm(stage: number, config: AppConfig, fixedDebugSpeed = false): number {
  if (fixedDebugSpeed) return 100;
  const key = `stage${stage}` as "stage1" | "stage2" | "stage3";
  const range = config.aiChallenge.stageSpeedRanges[key];
  const min = Math.max(1, Math.floor(range.min));
  const max = Math.max(min + 1, Math.floor(range.max));
  return min + Math.floor(Math.random() * (max - min + 1));
}
