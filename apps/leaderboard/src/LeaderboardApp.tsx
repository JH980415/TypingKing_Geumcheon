import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppConfig, BootstrapData, CsvBackupStatus, LeaderboardSyncStatus, RecordRow } from "../../../shared/types";
import { bestRecordOnly, isInterruptedRecord, sortRecords } from "../../../shared/utils/ranking";
import { calculateFinalCpm, countConvertedTypingUnits, countTypeableChars } from "../../../shared/utils/typing";
import { OneDriveSettingsPanel } from "../../shell/src/OneDriveSettingsPanel";

type Props = {
  bootstrap: BootstrapData;
};

type EditState = {
  participant_name: string;
  phone_part1: string;
  phone_part2: string;
  phone_part3: string;
  birth_year: string;
  birth_month: string;
  birth_day: string;
  stage1_time_ms: string;
  stage2_time_ms: string;
  stage3_time_ms: string;
  memo: string;
  is_test: string;
};

type AiLeaderboardDisplay = {
  participantTimeMs: number | null;
  aiTimeMs: number | null;
  participantAvgCpm: number | null;
  aiAvgCpm: number | null;
  resultLabel: string;
  participantTimeText: string;
  aiTimeText: string;
  participantCpmText: string;
  aiCpmText: string;
  resultStage: number;
  resultStageText: string;
  participantProgressPercent: number | null;
  aiProgressPercent: number | null;
  duelTimeMs: number | null;
  duelTimeText: string;
  duelRecordText: string;
  participantProgressText: string;
  aiProgressText: string;
};

type AiLeaderboardEntry = {
  record: RecordRow;
  display: AiLeaderboardDisplay;
};

let leaderboardRefreshInFlight = false;
const SLOW_STATUS_REFRESH_MS = 8000;

export function LeaderboardApp({ bootstrap }: Props) {
  const { assetBaseUrl } = bootstrap;
  const [config, setConfig] = useState<AppConfig>(bootstrap.config);
  const leaderboardVariant = bootstrap.variant;
  const isPracticeBoard = bootstrap.variantPolicy.sessionKind === "practice";
  const isGeumcheonOfficialBoard = bootstrap.eventProfile.profileId === "geumcheon-2026" && !isPracticeBoard;
  const isGeumcheonPracticeBoard = bootstrap.eventProfile.profileId === "geumcheon-2026" && isPracticeBoard;
  const showNormalLeaderboard = bootstrap.variantPolicy.gameModes.includes("normal");
  const showAiLeaderboard = bootstrap.variantPolicy.gameModes.includes("ai_challenge");
  const isDualPracticeBoard = isPracticeBoard && showNormalLeaderboard && showAiLeaderboard;
  const eventAsset = (configuredPath: string) => {
    const relativePath = configuredPath.replace(/^assets\//, "");
    return bootstrap.eventProfile.profileId === "geumcheon-2026" &&
      (configuredPath === bootstrap.eventProfile.assets.eventTitle || configuredPath === bootstrap.eventProfile.assets.pageBackground)
      ? `${assetBaseUrl}/../events/${bootstrap.eventProfile.profileId}/assets/${relativePath}`
      : `${assetBaseUrl}/${relativePath}`;
  };
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [message, setMessage] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [search, setSearch] = useState("");
  const [adminOpen, setAdminOpen] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [password, setPassword] = useState("");
  const [adminName, setAdminName] = useState("admin");
  const [viewMode, setViewMode] = useState<"best" | "all">(
    config.leaderboardMode === "all_records" ? "all" : "best"
  );
  const [includeTest, setIncludeTest] = useState(false);
  const [includeDebug, setIncludeDebug] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [edit, setEdit] = useState<EditState | null>(null);
  const [backups, setBackups] = useState<string[]>([]);
  const [syncStatus, setSyncStatus] = useState<LeaderboardSyncStatus | null>(null);
  const [backupStatus, setBackupStatus] = useState<CsvBackupStatus | null>(null);
  const lastSlowStatusRefreshAtRef = useRef(0);
  const adminOpenRef = useRef(false);

  useEffect(() => {
    adminOpenRef.current = adminOpen;
  }, [adminOpen]);

  useEffect(() => {
    void refresh(false);
    const refreshSeconds = Math.min(2, Math.max(1, Number(config.leaderboardRefreshSeconds) || 2));
    const interval = window.setInterval(
      () => void refresh(true),
      refreshSeconds * 1000
    );
    return () => window.clearInterval(interval);
  }, [config.leaderboardRefreshSeconds]);

  const normalRecords = useMemo(() => {
    const source = records.filter(
      (record) =>
        (includeTest || record.is_test !== "true") &&
        (includeDebug || record.is_debug !== "true") &&
        record.game_mode !== "ai_challenge"
    ).map(normalizeFinalCpmForLeaderboard);
    const ranked = viewMode === "best" ? bestRecordOnly(source) : sortRecords(source);
    const needle = search.trim().toLowerCase();
    if (!needle) return ranked;
    return ranked.filter((record) =>
      [
        authorized ? record.participant_name : maskParticipantName(record.participant_name),
        authorized ? record.phone_full : record.phone_masked,
        record.display_total_sec,
        record.memo
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [authorized, includeDebug, includeTest, records, search, viewMode]);

  const aiRecords = useMemo(() => {
    const source = records.filter(
      (record) =>
        (includeTest || record.is_test !== "true") &&
        (includeDebug || record.is_debug !== "true") &&
        record.game_mode === "ai_challenge"
    );
    const ranked = source
      .map(normalizeFinalCpmForLeaderboard)
      .map((record) => ({ record, display: buildAiLeaderboardDisplayV2(record) }))
      .sort(sortAiEntriesV2);
    const visibleRanked = selectGeumcheonAiLeaderboardEntriesForMode(ranked, {
      isGeumcheonOfficialBoard,
      isGeumcheonPracticeBoard
    });
    const needle = search.trim().toLowerCase();
    if (!needle) return visibleRanked;
    return visibleRanked.filter(({ record, display }) =>
      [
        authorized ? record.participant_name : maskParticipantName(record.participant_name),
        authorized ? record.phone_full : record.phone_masked,
        display.resultLabel,
        display.resultStageText,
        display.participantProgressText,
        display.participantCpmText,
        display.aiProgressText,
        display.aiCpmText,
        display.duelTimeText,
        record.memo
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [authorized, includeDebug, includeTest, isGeumcheonOfficialBoard, isGeumcheonPracticeBoard, records, search]);

  const selected = records.find((record) => record.record_id === selectedId);

  // "참가 중"은 행사장 요청 기준상 고유 인원이 아니라 현재 리더보드 모드의 실제 플레이 기록 수로 센다.
  // readRecords/listRecords 단계에서 admin_actions 숨김 처리가 끝난 뒤의 records를 사용하므로 숨긴 기록은 제외된다.
  const normalPlayCount = useMemo(
    () => countVisiblePlays(records, "normal", includeTest, includeDebug),
    [records, includeTest, includeDebug]
  );
  const aiPlayCount = useMemo(
    () => countVisiblePlays(records, "ai_challenge", includeTest, includeDebug),
    [records, includeTest, includeDebug]
  );
  const adminSelectableRecords = useMemo(
    () => [
      ...(showNormalLeaderboard ? normalRecords : []),
      ...(showAiLeaderboard ? aiRecords.map(({ record }) => record) : [])
    ].slice(0, 120),
    [aiRecords, normalRecords, showAiLeaderboard, showNormalLeaderboard]
  );

  async function refresh(silent: boolean) {
    if (leaderboardRefreshInFlight) return;
    leaderboardRefreshInFlight = true;
    try {
      const now = Date.now();
      const shouldRefreshSlowStatus =
        !silent || adminOpenRef.current || now - lastSlowStatusRefreshAtRef.current >= SLOW_STATUS_REFRESH_MS;
      const [settingsResult, result, statusResult, backupResult] = await Promise.all([
        window.typingKing.getOneDriveSettings(),
        window.typingKing.listRecords(),
        shouldRefreshSlowStatus ? window.typingKing.getLeaderboardSyncStatus() : Promise.resolve(null),
        shouldRefreshSlowStatus ? window.typingKing.getCsvBackupStatus() : Promise.resolve(null)
      ]);
      if (shouldRefreshSlowStatus) lastSlowStatusRefreshAtRef.current = now;
      if (settingsResult.ok && settingsResult.data) {
        setConfig((current) => (sameLeaderboardConfig(current, settingsResult.data!) ? current : settingsResult.data!));
      }
      if (result.ok && result.data) {
        setRecords((current) => (sameRecordSnapshot(current, result.data!) ? current : result.data!));
        setRefreshError("");
      } else if (!silent || result.code === "LOCKED") {
        setRefreshError(result.error || "기록 파일을 읽을 수 없습니다. 파일이 열려 있거나 손상되었을 수 있습니다.");
      }
      if (statusResult && statusResult.ok && statusResult.data) setSyncStatus(statusResult.data);
      if (backupResult && backupResult.ok && backupResult.data) setBackupStatus(backupResult.data);
    } finally {
      leaderboardRefreshInFlight = false;
    }
  }

  async function authorize() {
    const result = await window.typingKing.validateAdmin(password, adminName);
    if (result.ok) {
      setAuthorized(true);
      setMessage("관리자 모드에 진입했습니다.");
      await loadBackups();
    } else {
      setMessage(result.error || "관리자 비밀번호가 올바르지 않습니다.");
    }
  }

  function closeAdmin() {
    setAdminOpen(false);
    setAuthorized(false);
    setPassword("");
    setMessage("");
    setEdit(null);
    setSelectedId("");
  }

  function beginEdit(record: RecordRow) {
    setSelectedId(record.record_id);
    setEdit({
      participant_name: record.participant_name,
      phone_part1: record.phone_part1,
      phone_part2: record.phone_part2,
      phone_part3: record.phone_part3,
      birth_year: record.birth_year,
      birth_month: record.birth_month,
      birth_day: record.birth_day,
      stage1_time_ms: record.stage1_time_ms,
      stage2_time_ms: record.stage2_time_ms,
      stage3_time_ms: record.stage3_time_ms,
      memo: record.memo,
      is_test: record.is_test
    });
  }

  async function saveEdit() {
    if (!selectedId || !edit) {
      setMessage("수정 또는 삭제할 기록을 선택해 주세요.");
      return;
    }
    if (!edit.participant_name.trim()) {
      setMessage("수정할 값을 입력해 주세요.");
      return;
    }
    if (![edit.stage1_time_ms, edit.stage2_time_ms, edit.stage3_time_ms].every((value) => /^\d+(\.\d+)?$/.test(value))) {
      setMessage("시간 기록은 숫자만 입력할 수 있습니다.");
      return;
    }
    const result = await window.typingKing.updateRecord(selectedId, edit, adminName || "admin");
    setMessage(
      result.ok
        ? "기록을 수정했습니다. 원본 기록은 보존되고, 수정된 기록이 리더보드에 새로 표시됩니다."
        : result.error || "기록 수정 중 오류가 발생했습니다. 백업 파일을 확인해 주세요."
    );
    if (result.ok) {
      setEdit(null);
      await refresh(false);
    }
  }

  async function removeSelected() {
    if (!selectedId) {
      setMessage("수정 또는 삭제할 기록을 선택해 주세요.");
      return;
    }
    if (!confirm("선택한 기록을 리더보드에서 숨기시겠습니까? 원본 기록은 삭제되지 않습니다.")) return;
    const result = await window.typingKing.deleteRecord(selectedId, adminName || "admin");
    setMessage(
      result.ok
        ? "원본 기록은 삭제되지 않고 리더보드에서만 숨겨집니다."
        : result.error || "기록 숨기기 중 오류가 발생했습니다. OneDrive 상태를 확인해 주세요."
    );
    if (result.ok) {
      setSelectedId("");
      setEdit(null);
      await refresh(false);
      await loadBackups();
    }
  }

  async function clearAll() {
    if (!confirm("현재 회차 기록을 리더보드 표시에서 초기화하시겠습니까? 원본 기록은 삭제되지 않습니다.")) return;
    const result = await window.typingKing.clearRecords(adminName || "admin");
    setMessage(
      result.ok
        ? "현재 회차의 원본 기록은 삭제되지 않고 리더보드 표시에서만 숨겨집니다."
        : result.error || "리더보드 표시 초기화 중 오류가 발생했습니다. OneDrive 상태를 확인해 주세요."
    );
    if (result.ok) {
      setSelectedId("");
      setEdit(null);
      await refresh(false);
      await loadBackups();
    }
  }

  async function exportCsv(scope: "all" | "filtered" | "leaderboard") {
    const variantMode = isDualPracticeBoard ? null : showAiLeaderboard ? "ai_challenge" : "normal";
    const exportSource = (includeDebug ? records : records.filter((record) => record.is_debug !== "true"))
      .filter((record) => variantMode == null || (record.game_mode || "normal") === variantMode);
    // 연습 보드는 일반+AI를 함께 표시하므로 내보내기도 두 보드(일반 순위 → AI 순위)를 합쳐 내보낸다.
    const rows = scope === "all"
      ? exportSource.map((record) => enrichRecordForExport(record))
      : isDualPracticeBoard
        ? [
            ...normalRecords.map((record) => enrichRecordForExport(record)),
            ...aiRecords.map(({ record, display }) => enrichAiRecordForExportV2(normalizeFinalCpmForLeaderboard(record), display))
          ]
        : showAiLeaderboard
          ? aiRecords.map(({ record, display }) => enrichAiRecordForExportV2(normalizeFinalCpmForLeaderboard(record), display))
          : normalRecords.map((record) => enrichRecordForExport(record));
    const result = await window.typingKing.exportRecords(rows, scope);
    setMessage(
      result.ok
        ? `CSV 파일을 내보냈습니다.\n${result.data}`
        : result.error || "CSV 내보내기 중 오류가 발생했습니다.\n저장 위치를 확인해 주세요."
    );
    if (result.ok) {
      const statusResult = await window.typingKing.getLeaderboardSyncStatus();
      if (statusResult.ok && statusResult.data) setSyncStatus(statusResult.data);
    }
  }

  async function exportSessionBackup() {
    const result = await window.typingKing.exportCurrentSessionBackup();
    setMessage(
      result.ok && result.data
        ? result.data.message
        : result.error || "현재 회차 CSV 백업 중 오류가 발생했습니다.\n저장 위치를 확인해 주세요."
    );
    await refresh(false);
  }

  async function loadBackups() {
    const result = await window.typingKing.listBackups();
    if (result.ok && result.data) setBackups(result.data);
  }

  async function restore(name: string) {
    if (!confirm("선택한 백업에서 복원하시겠습니까? 현재 기록은 먼저 백업됩니다.")) return;
    const result = await window.typingKing.restoreBackup(name, adminName || "admin");
    setMessage(result.ok ? "백업에서 복원했습니다." : result.error || "백업 파일 복원에 실패했습니다.");
    if (result.ok) await refresh(false);
  }

  return (
    <main className="app leaderboard-app" style={{ backgroundImage: `url("${eventAsset(bootstrap.eventProfile.assets.pageBackground)}")` }}>
      <header className="leaderboard-header">
        <div>
          {bootstrap.eventProfile.profileId === "geumcheon-2026" && (
            <img className="geumcheon-header-title" src={eventAsset(bootstrap.eventProfile.assets.eventTitle)} alt={bootstrap.eventProfile.eventName} />
          )}
          <p className="eyebrow">{bootstrap.eventProfile.profileId === "geumcheon-2026" ? bootstrap.eventProfile.eventName : "2026 일잘러 페스타"}</p>
          <h1 className="visually-hidden">
            {bootstrap.variantPolicy.displayName}
          </h1>
        </div>
        <div className="leader-actions">
          <input
            className="search-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="기록 검색"
          />
          <button className="secondary-button" onClick={() => void refresh(false)}>새로고침</button>
          <button className="primary-button" onClick={() => setAdminOpen(true)}>관리자</button>
        </div>
      </header>

      <section className={isPracticeBoard ? "leaderboard-board split-board practice-board" : "leaderboard-board split-board"}>
        {refreshError && <div className="leaderboard-alert">{refreshError}</div>}
        <div className={isDualPracticeBoard ? "dual-leaderboards" : "dual-leaderboards single-leaderboard"}>
          {showNormalLeaderboard && (
            <div className="ranking-table compact-ranking">
              <SessionSummary
                config={config}
                participantCount={normalPlayCount}
                forcePractice={isPracticeBoard}
                compactPractice={isPracticeBoard}
              />
              <h2 className="leaderboard-mode-title">
                <AssetImage
                  src={`${assetBaseUrl}/normal_typing/normal_title_oneline_trimmed.png`}
                  fallbackSrc={`${assetBaseUrl}/normal_typing/normal_typing_title.png`}
                  alt="일잘러 타자왕은 누구!?"
                  className="leaderboard-mode-title-img"
                  fallback={<span>일잘러 타자왕은 누구!?</span>}
                />
              </h2>
              <div className="ranking-body">
                <div className="ranking-head normal-head">
                  <span>순위</span>
                  <span>참여자명</span>
                  <span>휴대폰번호</span>
                  <span>{isPracticeBoard ? "기록" : "최종 기록"}</span>
                  <span>{isPracticeBoard ? "타수" : "최종 타수"}</span>
                  <span>{isPracticeBoard ? "글자" : "클리어 기록"}</span>
                </div>
                {normalRecords.map((record, index) => (
                  <button
                    className={selectedId === record.record_id ? "ranking-row normal-row selected" : "ranking-row normal-row"}
                    key={record.record_id}
                    onClick={() => beginEdit(record)}
                  >
                    <span className="rank-number">{index + 1}위</span>
                    <span>{maskParticipantName(record.participant_name)}</span>
                    <span>{record.phone_masked}</span>
                    <span className="time-cell">{formatNormalLeaderboardRecord(record)}</span>
                    <span>{formatLeaderboardCpm(firstFiniteNumber(record.final_cpm))}</span>
                    <span>{formatNormalLeaderboardRecord(record)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {showAiLeaderboard && (
            <div className="ranking-table compact-ranking ai-ranking">
              <SessionSummary
                config={config}
                participantCount={aiPlayCount}
                forcePractice={isPracticeBoard}
                compactPractice={isPracticeBoard}
              />
              <h2 className="leaderboard-mode-title leaderboard-ai-title">
                <AssetImage
                  src={`${assetBaseUrl}/ai_challenge/ai_title_oneline_trimmed.png`}
                  fallbackSrc={`${assetBaseUrl}/ai_challenge/ai_challenge_title.png`}
                    alt={bootstrap.variantPolicy.displayName}
                  className="leaderboard-mode-title-img leaderboard-ai-title-img"
                    fallback={<span>{bootstrap.eventProfile.gameName}</span>}
                />
              </h2>
              <div className="ranking-body">
                <div className="ranking-head ai-head">
                  <span>순위</span>
                  <span>참여자명</span>
                  <span>휴대폰번호</span>
                  <span>결과</span>
                  <span>{isPracticeBoard ? "스테이지" : "종료 스테이지"}</span>
                  <span>{isPracticeBoard ? "참여자" : "참여자 점수"}</span>
                  <span>{isPracticeBoard ? "AI" : "AI 점수"}</span>
                  <span>{isPracticeBoard ? "시간" : "대결 시간"}</span>
                </div>
                {aiRecords.map(({ record, display }, index) => (
                  <button
                    className={selectedId === record.record_id ? "ranking-row ai-row selected" : "ranking-row ai-row"}
                    key={record.record_id}
                    onClick={() => beginEdit(record)}
                  >
                    <span className="rank-number">{index + 1}위</span>
                    <span>{maskParticipantName(record.participant_name)}</span>
                    <span>{record.phone_masked}</span>
                    <span className={display.resultLabel === "참여자 승리" ? "result-win" : "result-lose"}>{display.resultLabel}</span>
                    <span>{display.resultStageText}</span>
                    <span className="status-cell">
                      <strong>{display.participantProgressText}</strong>
                      <em>{display.participantCpmText}</em>
                    </span>
                    <span className="status-cell">
                      <strong>{display.aiProgressText}</strong>
                      <em>{display.aiCpmText}</em>
                    </span>
                    <span className="time-cell">{display.duelRecordText}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {isPracticeBoard && (
          <div className="practice-leaderboard-footer">
            <strong>지금은 자유 연습회차입니다.</strong>
            <span>공식 시상 회차 전, 부담 없이 연습해보세요!</span>
            <small>※ 공식 순위 및 사은품 집계 제외</small>
          </div>
        )}
      </section>

      {adminOpen && (
        <div className="modal-backdrop">
          <section className="modal admin-modal wide">
            <header className="modal-header">
              <div>
                <p className="eyebrow">관리자 콘솔</p>
                <h2>리더보드 관리자</h2>
              </div>
              <button className="icon-button" onClick={closeAdmin} aria-label="닫기">×</button>
            </header>

            {!authorized ? (
              <div className="admin-login-grid">
                <label className="field">
                  <span>관리자 이름</span>
                  <input value={adminName} onChange={(event) => setAdminName(event.target.value)} />
                </label>
                <label className="field">
                  <span>관리자 비밀번호</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void authorize();
                    }}
                  />
                </label>
                <button className="primary-button" onClick={authorize}>진입</button>
              </div>
            ) : (
              <>
                <OneDriveSettingsPanel
                  isPractice={isPracticeBoard}
                  role="leaderboard"
                  onSettingsChange={(nextConfig) => {
                    setConfig(nextConfig);
                    void refresh(false);
                  }}
                />

                {syncStatus && <SyncStatusCard status={syncStatus} isPracticeSession={config.isPracticeSession || isPracticeBoard} />}
                {backupStatus && <BackupStatusCard status={backupStatus} showAi={showAiLeaderboard} />}

                <div className="admin-toolbar">
                  <button className={viewMode === "best" ? "stage-pill active" : "stage-pill"} onClick={() => setViewMode("best")}>
                    최고기록만 보기
                  </button>
                  <button className={viewMode === "all" ? "stage-pill active" : "stage-pill"} onClick={() => setViewMode("all")}>
                    전체기록 보기
                  </button>
                  <label className="check-line compact">
                    <input checked={includeTest} type="checkbox" onChange={(event) => setIncludeTest(event.target.checked)} />
                    테스트 기록 포함
                  </label>
                  <label className="check-line compact">
                    <input checked={includeDebug} type="checkbox" onChange={(event) => setIncludeDebug(event.target.checked)} />
                    디버그 기록 포함
                  </label>
                </div>

                <div className="admin-split">
                  <section className="admin-edit-panel">
                    <h3>기록 수정</h3>
                    <div className="admin-record-picker" aria-label="수정할 기록 선택">
                      {adminSelectableRecords.map((record, index) => (
                        <button
                          className={selectedId === record.record_id ? "selected" : ""}
                          key={record.record_id}
                          onClick={() => beginEdit(record)}
                          type="button"
                        >
                          <strong>{index + 1}위</strong>
                          <span>{record.game_mode === "ai_challenge" ? "AI" : "일잘러"}</span>
                          <span>{maskParticipantName(record.participant_name)}</span>
                          <em>{record.phone_masked}</em>
                        </button>
                      ))}
                      {adminSelectableRecords.length === 0 && <p className="notice-text">선택할 기록이 없습니다.</p>}
                    </div>
                    {!edit && <p className="notice-text">수정하거나 숨길 기록을 위 목록 또는 표에서 선택해 주세요.</p>}
                    {edit && (
                      <div className="edit-grid">
                        <p className="admin-action-note">
                          원본 기록은 보존되고, 수정된 기록이 리더보드에 새로 표시됩니다.
                        </p>
                        <label className="field">
                          <span>참여자 이름</span>
                          <input value={edit.participant_name} onChange={(event) => setEdit({ ...edit, participant_name: event.target.value })} />
                        </label>
                        <label className="field">
                          <span>휴대폰 앞자리</span>
                          <input value={edit.phone_part1} onChange={(event) => setEdit({ ...edit, phone_part1: digits(event.target.value, 3) })} />
                        </label>
                        <label className="field">
                          <span>휴대폰 가운데</span>
                          <input value={edit.phone_part2} onChange={(event) => setEdit({ ...edit, phone_part2: digits(event.target.value, 4) })} />
                        </label>
                        <label className="field">
                          <span>휴대폰 끝자리</span>
                          <input value={edit.phone_part3} onChange={(event) => setEdit({ ...edit, phone_part3: digits(event.target.value, 4) })} />
                        </label>
                        <label className="field">
                          <span>출생연도</span>
                          <input value={edit.birth_year} onChange={(event) => setEdit({ ...edit, birth_year: digits(event.target.value, 4) })} />
                        </label>
                        <label className="field">
                          <span>월</span>
                          <input value={edit.birth_month} onChange={(event) => setEdit({ ...edit, birth_month: digits(event.target.value, 2) })} />
                        </label>
                        <label className="field">
                          <span>일</span>
                          <input value={edit.birth_day} onChange={(event) => setEdit({ ...edit, birth_day: digits(event.target.value, 2) })} />
                        </label>
                        <label className="field">
                          <span>Stage 1 ms</span>
                          <input value={edit.stage1_time_ms} onChange={(event) => setEdit({ ...edit, stage1_time_ms: event.target.value })} />
                        </label>
                        <label className="field">
                          <span>Stage 2 ms</span>
                          <input value={edit.stage2_time_ms} onChange={(event) => setEdit({ ...edit, stage2_time_ms: event.target.value })} />
                        </label>
                        <label className="field">
                          <span>Stage 3 ms</span>
                          <input value={edit.stage3_time_ms} onChange={(event) => setEdit({ ...edit, stage3_time_ms: event.target.value })} />
                        </label>
                        <label className="field wide-field">
                          <span>메모</span>
                          <input value={edit.memo} onChange={(event) => setEdit({ ...edit, memo: event.target.value })} />
                        </label>
                        <label className="check-line compact">
                          <input
                            type="checkbox"
                            checked={edit.is_test === "true"}
                            onChange={(event) => setEdit({ ...edit, is_test: event.target.checked ? "true" : "false" })}
                          />
                          테스트 기록
                        </label>
                      </div>
                    )}
                    <div className="button-row">
                      <button className="primary-button" onClick={saveEdit}>수정 저장</button>
                      <button className="secondary-button" onClick={removeSelected}>리더보드에서 숨기기</button>
                    </div>
                  </section>

                  <section className="admin-edit-panel">
                    <h3>운영 도구</h3>
                    <p className="notice-text">
                      숨기기와 표시 초기화는 원본 JSON을 삭제하지 않고 관리자 조치 파일로만 반영됩니다.
                    </p>
                    <div className="button-grid">
                      <button className="important-action" onClick={() => void exportSessionBackup()}>
                        현재 회차 CSV 백업
                      </button>
                      <button onClick={() => void exportCsv("all")}>전체 기록 CSV</button>
                      <button className="danger-mini" onClick={clearAll}>현재 회차 표시 초기화</button>
                    </div>
                    <h3>백업 파일</h3>
                    <div className="backup-list">
                      {backups.map((name) => (
                        <button key={name} onClick={() => void restore(name)}>{name}</button>
                      ))}
                      {backups.length === 0 && <p className="notice-text">백업 파일이 없습니다.</p>}
                    </div>
                  </section>
                </div>
              </>
            )}
            {message && <p className="notice-text">{message}</p>}
          </section>
        </div>
      )}
    </main>
  );
}
function digits(value: string, max: number): string {
  return value.replace(/\D/g, "").slice(0, max);
}

type AiStageResult = "" | "USER_WIN" | "AI_WIN";

function normalizeFinalCpmForLeaderboard(record: RecordRow): RecordRow {
  const totalTimeMs = firstFiniteNumber(record.total_time_ms);
  if (totalTimeMs == null) return record;
  const typingUnits = [record.stage1_text, record.stage2_text, record.stage3_text]
    .reduce((sum, text) => sum + countConvertedTypingUnits(text), 0);
  if (typingUnits <= 0) return record;
  return {
    ...record,
    final_cpm: String(calculateFinalCpm(typingUnits, totalTimeMs))
  };
}

export function selectGeumcheonAiLeaderboardEntriesForMode(
  entries: AiLeaderboardEntry[],
  _mode: { isGeumcheonOfficialBoard: boolean; isGeumcheonPracticeBoard: boolean }
): AiLeaderboardEntry[] {
  return [...entries].sort(sortAiEntriesV2);
}

function enrichRecordForExport(record: RecordRow): RecordRow {
  return enrichAiRecordForExportV2(normalizeFinalCpmForLeaderboard(record));
}

function sortAiEntriesV2(a: AiLeaderboardEntry, b: AiLeaderboardEntry): number {
  const resultDiff = aiResultRankV2(a.display) - aiResultRankV2(b.display);
  if (resultDiff !== 0) return resultDiff;

  if (a.display.resultLabel === "참여자 승리" && b.display.resultLabel === "참여자 승리") {
    const duelDiff = sortNullableAsc(a.display.duelTimeMs) - sortNullableAsc(b.display.duelTimeMs);
    if (duelDiff !== 0) return duelDiff;
    const cpmDiff = sortNullableDesc(b.display.participantAvgCpm) - sortNullableDesc(a.display.participantAvgCpm);
    if (cpmDiff !== 0) return cpmDiff;
  } else {
    const stageDiff = b.display.resultStage - a.display.resultStage;
    if (stageDiff !== 0) return stageDiff;
    const progressDiff =
      sortNullableDesc(b.display.participantProgressPercent) - sortNullableDesc(a.display.participantProgressPercent);
    if (progressDiff !== 0) return progressDiff;
    const cpmDiff = sortNullableDesc(b.display.participantAvgCpm) - sortNullableDesc(a.display.participantAvgCpm);
    if (cpmDiff !== 0) return cpmDiff;
  }

  const completedDiff = new Date(a.record.completed_at).getTime() - new Date(b.record.completed_at).getTime();
  if (completedDiff !== 0) return completedDiff;
  return Number(a.record.record_id || 0) - Number(b.record.record_id || 0);
}

function aiResultRankV2(display: AiLeaderboardDisplay): number {
  return display.resultLabel === "참여자 승리" ? 0 : 1;
}

function buildAiLeaderboardDisplayV2(record: RecordRow): AiLeaderboardDisplay {
  const resultLabel = normalizeAiResultLabelV2(record);
  const resultStage = getAiResultStageV2(record, resultLabel);
  const stageResults = normalizeStageResultsV2(record, resultLabel, resultStage);
  const participantProgresses = buildParticipantProgressesV2(record, stageResults, resultStage);
  const aiProgresses = buildAiProgressesV2(record, stageResults, resultStage);
  const rawParticipantProgress =
    parseFiniteNumber(record.participant_progress_percent) ?? averageProgressV2(participantProgresses);
  const rawAiProgress = parseFiniteNumber(record.ai_progress_percent) ?? averageProgressV2(aiProgresses);
  const participantProgressPercent = resultLabel === "참여자 승리" ? 100 : rawParticipantProgress;
  const aiProgressPercent = resultLabel === "참여자 패배" ? 100 : rawAiProgress;
  const duelTimeMs = firstFiniteNumber(record.duel_time_ms) ?? estimateDuelTimeMsV2(record, stageResults, resultStage);
  // 저장된 평균 타수는 0(=입력 없음)도 유효값으로 존중한다. firstFiniteNumber는 0을 "없음"으로
  // 취급해 잘못된 보정값(final_cpm 기반)을 만들어 진행률 0%인데 평균 타수가 표시되는 모순을 유발했다.
  const participantAvgCpm =
    parseFiniteNumber(record.participant_avg_cpm) ??
    computeAverageCpmFromProgressV2(record, participantProgresses, stageResults, resultStage, "participant");
  const aiAvgCpm =
    parseFiniteNumber(record.ai_avg_cpm) ??
    computeAverageCpmFromProgressV2(record, aiProgresses, stageResults, resultStage, "ai");
  const participantTimeMs =
    firstFiniteNumber(record.participant_result_time_ms) ??
    estimateParticipantFinishTimeV2(record, resultLabel, resultStage, participantAvgCpm);
  const aiTimeMs = firstFiniteNumber(record.ai_result_time_ms) ?? estimateAiFinishTimeV2(record, resultStage);

  return {
    participantTimeMs,
    aiTimeMs,
    participantAvgCpm,
    aiAvgCpm,
    resultLabel,
    participantTimeText: formatLeaderboardMs(participantTimeMs),
    aiTimeText: formatLeaderboardMs(aiTimeMs),
    participantCpmText: formatAverageCpmText(participantAvgCpm),
    aiCpmText: formatAverageCpmText(aiAvgCpm),
    resultStage,
    resultStageText: `Stage ${resultStage}`,
    participantProgressPercent,
    aiProgressPercent,
    duelTimeMs,
    duelTimeText: formatLeaderboardMs(duelTimeMs),
    duelRecordText: formatLeaderboardRecord(duelTimeMs, aiDuelVisibleCharCount(record, resultStage)),
    participantProgressText: formatProgressText(participantProgressPercent),
    aiProgressText: formatProgressText(aiProgressPercent)
  };
}

function enrichAiRecordForExportV2(record: RecordRow, knownDisplay?: AiLeaderboardDisplay): RecordRow {
  if (record.game_mode !== "ai_challenge") return record;
  const display = knownDisplay ?? buildAiLeaderboardDisplayV2(record);
  return {
    ...record,
    participant_result_time_ms: display.participantTimeMs == null ? "" : String(Math.round(display.participantTimeMs)),
    ai_result_time_ms: display.aiTimeMs == null ? "" : String(Math.round(display.aiTimeMs)),
    participant_avg_cpm: display.participantAvgCpm == null ? "" : String(Math.round(display.participantAvgCpm)),
    ai_avg_cpm: display.aiAvgCpm == null ? "" : String(Math.round(display.aiAvgCpm)),
    challenge_result_label: display.resultLabel,
    participant_progress_percent:
      display.participantProgressPercent == null ? "" : display.participantProgressPercent.toFixed(1),
    ai_progress_percent: display.aiProgressPercent == null ? "" : display.aiProgressPercent.toFixed(1),
    duel_time_ms: display.duelTimeMs == null ? "" : String(Math.round(display.duelTimeMs)),
    result_stage: String(display.resultStage)
  };
}

function normalizeAiResultLabelV2(record: RecordRow): "참여자 승리" | "참여자 패배" | "중단 패배" {
  if (record.challenge_result_label.includes("중단") || isInterruptedRecord(record)) return "중단 패배";
  if (record.challenge_result_label.includes("승리")) return "참여자 승리";
  if (record.challenge_result_label.includes("패배")) return "참여자 패배";
  return record.ai_challenge_status === "SUCCESS" || record.final_vs_ai_result === "USER_WIN"
    ? "참여자 승리"
    : "참여자 패배";
}

function getAiResultStageV2(record: RecordRow, resultLabel: string): number {
  const storedStage = parseFiniteNumber(record.result_stage);
  if (storedStage != null && storedStage > 0) return clampStage(Math.round(storedStage));
  if (resultLabel === "참여자 승리") return 3;
  const failedStage = parseFiniteNumber(record.ai_failed_stage);
  if (failedStage != null && failedStage > 0) return clampStage(Math.round(failedStage));
  const results = [record.stage1_vs_ai_result, record.stage2_vs_ai_result, record.stage3_vs_ai_result];
  const aiWinIndex = results.findIndex((result) => result === "AI_WIN");
  if (aiWinIndex >= 0) return clampStage(aiWinIndex + 1);
  return clampStage(lastCompletedAiStage(record) || 1);
}

function normalizeStageResultsV2(record: RecordRow, resultLabel: string, resultStage: number): AiStageResult[] {
  const rawResults = [record.stage1_vs_ai_result, record.stage2_vs_ai_result, record.stage3_vs_ai_result];
  return rawResults.map((result, index) => {
    const stage = index + 1;
    if (stage > resultStage) return "";
    if (result === "USER_WIN" || result === "AI_WIN") return result;
    if (stage < resultStage) return "USER_WIN";
    return resultLabel === "참여자 승리" ? "USER_WIN" : "AI_WIN";
  });
}

function buildParticipantProgressesV2(record: RecordRow, stageResults: AiStageResult[], resultStage: number): number[] {
  const charCounts = stageCharCountsV2(record);
  const stageTimes = participantStageTimesV2(record);
  const fallbackCpm = firstFiniteNumber(record.participant_avg_cpm) ?? firstFiniteNumber(record.final_cpm);
  return stageResults.map((result, index) => {
    const stage = index + 1;
    if (stage > resultStage || result === "") return 0;
    if (result === "USER_WIN") return 100;
    return progressFromCpmAndTimeV2(fallbackCpm, stageTimes[index], charCounts[index]);
  });
}

function buildAiProgressesV2(record: RecordRow, stageResults: AiStageResult[], resultStage: number): number[] {
  const charCounts = stageCharCountsV2(record);
  const userTimes = participantStageTimesV2(record);
  const aiTimes = aiStageTimesV2(record);
  const aiCpms = aiStageCpmsV2(record);
  return stageResults.map((result, index) => {
    const stage = index + 1;
    if (stage > resultStage || result === "") return 0;
    if (result === "AI_WIN") return 100;
    const fromTimeRatio = progressFromTimeRatioV2(userTimes[index], aiTimes[index]);
    if (fromTimeRatio != null) return fromTimeRatio;
    return progressFromCpmAndTimeV2(aiCpms[index], userTimes[index], charCounts[index]);
  });
}

function computeAverageCpmFromProgressV2(
  record: RecordRow,
  progresses: number[],
  stageResults: AiStageResult[],
  resultStage: number,
  target: "participant" | "ai"
): number | null {
  const charCounts = stageCharCountsV2(record);
  const userTimes = participantStageTimesV2(record);
  const aiTimes = aiStageTimesV2(record);
  let typedChars = 0;
  let elapsedMs = 0;
  for (let index = 0; index < resultStage; index += 1) {
    const progress = clampPercent(progresses[index] ?? 0);
    typedChars += charCounts[index] * (progress / 100);
    if (target === "participant") {
      elapsedMs += userTimes[index] ?? 0;
    } else {
      elapsedMs += stageResults[index] === "AI_WIN" ? aiTimes[index] ?? 0 : userTimes[index] ?? 0;
    }
  }
  if (typedChars <= 0 || elapsedMs <= 0) return null;
  return (typedChars / elapsedMs) * 60000;
}

function estimateDuelTimeMsV2(record: RecordRow, stageResults: AiStageResult[], resultStage: number): number | null {
  const userTimes = participantStageTimesV2(record);
  const aiTimes = aiStageTimesV2(record);
  let total = 0;
  for (let index = 0; index < resultStage; index += 1) {
    const stageTime = stageResults[index] === "AI_WIN" ? aiTimes[index] : userTimes[index];
    if (stageTime == null) return firstFiniteNumber(record.total_time_ms);
    total += stageTime;
  }
  return total > 0 ? total : firstFiniteNumber(record.total_time_ms);
}

function estimateParticipantFinishTimeV2(
  record: RecordRow,
  resultLabel: string,
  resultStage: number,
  participantAvgCpm: number | null
): number | null {
  if (resultLabel === "참여자 승리") return firstFiniteNumber(record.total_time_ms);
  const userTimes = participantStageTimesV2(record);
  const charCounts = stageCharCountsV2(record);
  const completedBefore = userTimes
    .slice(0, Math.max(0, resultStage - 1))
    .reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const estimatedLosing = estimateStageTimeByCharCountV2(charCounts[resultStage - 1], participantAvgCpm);
  return estimatedLosing == null ? firstFiniteNumber(record.total_time_ms) : completedBefore + estimatedLosing;
}

function estimateAiFinishTimeV2(record: RecordRow, resultStage: number): number | null {
  const aiTimes = aiStageTimesV2(record).slice(0, resultStage);
  if (aiTimes.some((value) => value == null)) return firstFiniteNumber(record.ai_total_time_ms);
  return aiTimes.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function progressFromTimeRatioV2(userTime: number | null, aiTime: number | null): number | null {
  if (userTime == null || aiTime == null || aiTime <= 0) return null;
  return clampPercent((userTime / aiTime) * 100);
}

function progressFromCpmAndTimeV2(cpm: number | null, timeMs: number | null, charCount: number): number {
  if (cpm == null || timeMs == null || cpm <= 0 || timeMs <= 0 || charCount <= 0) return 0;
  return clampPercent(((cpm * timeMs) / 60000 / charCount) * 100);
}

function estimateStageTimeByCharCountV2(charCount: number, cpm: number | null): number | null {
  if (charCount <= 0 || cpm == null || cpm <= 0) return null;
  return (charCount / cpm) * 60000;
}

function participantStageTimesV2(record: RecordRow): Array<number | null> {
  return [record.stage1_time_ms, record.stage2_time_ms, record.stage3_time_ms].map(firstFiniteNumber);
}

function aiStageTimesV2(record: RecordRow): Array<number | null> {
  return [record.ai_stage1_time_ms, record.ai_stage2_time_ms, record.ai_stage3_time_ms].map(firstFiniteNumber);
}

function aiStageCpmsV2(record: RecordRow): Array<number | null> {
  return [record.ai_stage1_cpm, record.ai_stage2_cpm, record.ai_stage3_cpm].map(firstFiniteNumber);
}

function stageCharCountsV2(record: RecordRow): number[] {
  const textFallbacks = [record.stage1_text, record.stage2_text, record.stage3_text];
  return textFallbacks.map((text) => countConvertedTypingUnits(text ?? ""));
}

function averageProgressV2(values: number[]): number {
  return Math.round((values.reduce((sum, value) => sum + clampPercent(value), 0) / 3) * 10) / 10;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function parseFiniteNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatProgressText(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "진행률 산정불가";
  return `진행률 ${formatTruncatedDecimal(clampPercent(value), 2, true)}%`;
}

function formatAverageCpmText(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "평균 산정불가";
  return `평균 ${formatTruncatedDecimal(value, 2)}타`;
}

function lastCompletedAiStage(record: RecordRow): number {
  return [record.ai_stage1_time_ms, record.ai_stage2_time_ms, record.ai_stage3_time_ms]
    .map(firstFiniteNumber)
    .filter((value) => value != null && value > 0)
    .length;
}

function clampStage(stage: number): number {
  if (stage < 1) return 1;
  if (stage > 3) return 3;
  return stage;
}

function firstFiniteNumber(value: string | number | null | undefined): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function sortNullableAsc(value: number | null): number {
  return value == null ? Number.MAX_SAFE_INTEGER : value;
}

function sortNullableDesc(value: number | null): number {
  return value == null ? -1 : value;
}

function formatLeaderboardMs(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "산정불가";
  return `${formatTruncatedDecimal(value / 1000, 2, true)}초`;
}

function formatLeaderboardRecord(value: string | number | null | undefined, charCount: number): string {
  const ms = parseFiniteNumber(value);
  if (ms == null || !Number.isFinite(ms)) return "산정불가";
  const chars = Number.isFinite(charCount) ? Math.max(0, Math.trunc(charCount)) : 0;
  return `${formatTruncatedDecimal(ms / 1000, 2, true)}초, ${chars.toLocaleString("ko-KR")}글자`;
}

function formatNormalLeaderboardRecord(record: RecordRow): string {
  const formatted = formatLeaderboardRecord(record.total_time_ms, recordVisibleCharCount(record));
  return isInterruptedRecord(record) ? `중단 · ${formatted}` : formatted;
}

function formatLeaderboardCpm(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "산정불가";
  return `${formatTruncatedDecimal(value, 2)}타`;
}

function formatTruncatedDecimal(value: number, digits: number, fixed = false): string {
  if (!Number.isFinite(value)) return "0";
  const factor = 10 ** digits;
  const truncated = Math.trunc(value * factor) / factor;
  return fixed ? truncated.toFixed(digits) : String(truncated);
}

function recordVisibleCharCount(record: RecordRow): number {
  const stored = parseFiniteNumber(record.total_char_count);
  if (stored != null) return stored;
  return [record.stage1_text, record.stage2_text, record.stage3_text]
    .reduce((sum, text) => sum + countTypeableChars(text ?? ""), 0);
}

function aiDuelVisibleCharCount(record: RecordRow, resultStage: number): number {
  const stageTexts = [record.stage1_text, record.stage2_text, record.stage3_text];
  const limit = Math.max(1, Math.min(3, resultStage || 1));
  return stageTexts
    .slice(0, limit)
    .reduce((sum, text) => sum + countTypeableChars(text ?? ""), 0);
}

function maskParticipantName(name: string): string {
  const chars = Array.from(String(name ?? "").trim());
  if (chars.length === 0) return "";
  return chars.map((char, index) => (index % 2 === 0 ? char : "*")).join("");
}

function sameLeaderboardConfig(a: AppConfig, b: AppConfig): boolean {
  return (
    a.oneDriveRoot === b.oneDriveRoot &&
    a.recordBaseFolderName === b.recordBaseFolderName &&
    a.dayNo === b.dayNo &&
    a.roundNo === b.roundNo &&
    a.isPracticeSession === b.isPracticeSession &&
    a.sessionName === b.sessionName &&
    a.setupComplete === b.setupComplete &&
    a.leaderboardRefreshSeconds === b.leaderboardRefreshSeconds &&
    a.leaderboardMode === b.leaderboardMode
  );
}
function sameRecordSnapshot(a: RecordRow[], b: RecordRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (
      left.record_id !== right.record_id ||
      left.game_mode !== right.game_mode ||
      left.participant_name !== right.participant_name ||
      left.phone_masked !== right.phone_masked ||
      left.total_time_ms !== right.total_time_ms ||
      left.final_cpm !== right.final_cpm ||
      left.challenge_result_label !== right.challenge_result_label ||
      left.participant_progress_percent !== right.participant_progress_percent ||
      left.ai_progress_percent !== right.ai_progress_percent ||
      left.participant_avg_cpm !== right.participant_avg_cpm ||
      left.ai_avg_cpm !== right.ai_avg_cpm ||
      left.duel_time_ms !== right.duel_time_ms ||
      left.attemptNumber !== right.attemptNumber ||
      left.rankingEligible !== right.rankingEligible ||
      left.participantKey !== right.participantKey ||
      left.serverReceivedAt !== right.serverReceivedAt ||
      left.completionStatus !== right.completionStatus ||
      left.totalTypingUnits !== right.totalTypingUnits ||
      left.totalUserTimeMs !== right.totalUserTimeMs ||
      left.fairness?.totalUserTimeMs !== right.fairness?.totalUserTimeMs ||
      left.memo !== right.memo ||
      left.is_test !== right.is_test ||
      left.is_debug !== right.is_debug
    ) {
      return false;
    }
  }
  return true;
}

function SessionSummary({
  config,
  participantCount = 0,
  forcePractice = false,
  compactPractice = false
}: {
  config: AppConfig;
  participantCount?: number;
  forcePractice?: boolean;
  compactPractice?: boolean;
}) {
  const day = Number(config.dayNo) || 1;
  const round = Number(config.roundNo) || 1;
  const count = Number.isFinite(participantCount) ? participantCount : 0;
  const isPractice = forcePractice || Boolean(config.isPracticeSession);
  return (
    <div
      className={isPractice ? "leaderboard-session practice-session" : "leaderboard-session"}
      aria-label={
        isPractice
          ? `현재 세션 ${count}명 참가 중 자유 연습회차`
          : `현재 세션 ${count}명 참가 중 ${day}일차 ${round}회차`
      }
    >
      <div className="session-top">
        <span className="session-label">현재 세션</span>
        <span className="session-count">{count}명 참가 중</span>
      </div>
      {isPractice && compactPractice ? (
        <span className="practice-mini-label">자유 연습회차</span>
      ) : isPractice ? (
        <div className="practice-session-copy">
          <strong>지금은 자유 연습회차입니다.</strong>
          <span>공식 시상 회차 전, 부담 없이 연습해보세요!</span>
          <small>※ 공식 순위 및 사은품 집계 제외</small>
        </div>
      ) : (
        <div className="session-badges">
          <strong className="session-day">{day}일차</strong>
          <strong className="session-round">{round}회차</strong>
        </div>
      )}
    </div>
  );
}

function countVisiblePlays(
  records: RecordRow[],
  mode: "normal" | "ai_challenge",
  includeTest: boolean,
  includeDebug: boolean
): number {
  return records.filter((record) => {
    if (!includeTest && record.is_test === "true") return false;
    if (!includeDebug && record.is_debug === "true") return false;
    const recordMode = record.game_mode === "ai_challenge" ? "ai_challenge" : "normal";
    return recordMode === mode;
  }).length;
}

function SyncStatusCard({ status, isPracticeSession }: { status: LeaderboardSyncStatus; isPracticeSession?: boolean }) {
  const stateClass = status.status === "오류" ? "error" : status.status === "주의" ? "warn" : "";
  return (
    <section className="sync-status-card">
      <h3>리더보드 동기화 상태</h3>
      <div className="sync-status-grid">
        <div>
          <span>현재 세션</span>
          <strong>{isPracticeSession ? "자유 연습회차" : `${status.dayNo}일차 ${status.roundNo}회차`}</strong>
        </div>
        <div>
          <span>마지막 읽기</span>
          <strong>{formatStatusTime(status.lastReadAt)}</strong>
        </div>
        <div>
          <span>원본 파일</span>
          <strong>{status.sourceFileCount}건</strong>
        </div>
        <div>
          <span>반영 기록</span>
          <strong>{status.reflectedRecordCount}건</strong>
        </div>
        <div>
          <span>무시된 파일</span>
          <strong>{status.ignoredFileCount}건</strong>
        </div>
        <div>
          <span>상태</span>
          <strong className={`sync-state ${stateClass}`}>{status.status}</strong>
        </div>
      </div>
      {status.error && <p className="sync-status-error">{status.error}</p>}
    </section>
  );
}

function BackupStatusCard({ status, showAi }: { status: CsvBackupStatus; showAi: boolean }) {
  const current = showAi ? status.ai : status.normal;
  const other = showAi ? status.normal : status.ai;
  const label = showAi ? "AI 타자왕" : "일반 타자왕";
  const otherLabel = showAi ? "일반 타자왕" : "AI 타자왕";
  return (
    <section className="backup-status-card">
      <h3>CSV 백업 상태</h3>
      <div className="backup-status-grid">
        <div>
          <span>{label}</span>
          <strong className={current.complete ? "backup-complete" : current.required ? "backup-missing" : ""}>
            {current.required ? (current.complete ? "완료" : "미완료") : "기록 없음"}
          </strong>
        </div>
        <div>
          <span>현재 기록</span>
          <strong>{current.recordCount}건</strong>
        </div>
        <div>
          <span>백업 기록</span>
          <strong>{current.backedUpRecordCount ?? 0}건</strong>
        </div>
        <div>
          <span>{otherLabel}</span>
          <strong className={other.complete ? "backup-complete" : other.required ? "backup-missing" : ""}>
            {other.required ? (other.complete ? "완료" : "미완료") : "기록 없음"}
          </strong>
        </div>
      </div>
      {current.staleReason && <p className="backup-status-note">{current.staleReason}</p>}
    </section>
  );
}

function formatStatusTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString("ko-KR", { hour12: false });
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
