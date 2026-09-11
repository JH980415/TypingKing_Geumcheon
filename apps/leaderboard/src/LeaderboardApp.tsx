import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppConfig, BootstrapData, CsvBackupStatus, LeaderboardSyncStatus, RecordListSearch, RecordRow } from "../../../shared/types";
import {
  bestRecordOnly,
  compareCanonicalAiDisplayOrder,
  compareLegacyAiRecords,
  isInterruptedRecord,
  rankCanonicalAiAttempts,
  sortRecords
} from "../../../shared/utils/ranking";
import { isCanonicalAiAttemptPubliclyRankable } from "../../../shared/utils/geumcheonAiAttempt";
import { calculateFinalCpm, countConvertedTypingUnits, countTypeableChars } from "../../../shared/utils/typing";
import { resolveEventAssetUrl } from "../../../shared/events/types";
import { OneDriveSettingsPanel, storageErrorForDisplay } from "../../shell/src/OneDriveSettingsPanel";

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

type RankedAiLeaderboardEntry = AiLeaderboardEntry & {
  rank: number;
};

type AiLeaderboardCandidate = {
  entry: AiLeaderboardEntry;
  attempt?: NonNullable<RecordRow["canonicalAttempt"]>;
};

const SLOW_STATUS_REFRESH_MS = 8000;

type LeaderboardOperation =
  | "refresh"
  | "authorize"
  | "edit"
  | "hide"
  | "clear"
  | "export"
  | "backup"
  | "restore";

const LEADERBOARD_OPERATION_ERRORS: Record<LeaderboardOperation, string> = {
  refresh: "NAS 기록을 읽을 수 없습니다. NAS 연결과 조회 전용 권한을 확인해 주세요.",
  authorize: "관리자 비밀번호가 올바르지 않습니다.",
  edit: "기록 수정 중 오류가 발생했습니다. 관리자 권한과 NAS 운영 저장소 상태를 확인해 주세요.",
  hide: "기록 숨기기 중 오류가 발생했습니다. 관리자 권한과 NAS 운영 저장소 상태를 확인해 주세요.",
  clear: "리더보드 표시 초기화 중 오류가 발생했습니다. 관리자 권한과 NAS 운영 저장소 상태를 확인해 주세요.",
  export: "CSV 내보내기 중 오류가 발생했습니다. 선택한 저장 위치를 확인해 주세요.",
  backup: "현재 회차 CSV 백업 중 오류가 발생했습니다. NAS 운영 저장소 상태를 확인해 주세요.",
  restore: "백업 파일 복원에 실패했습니다. 관리자 권한과 NAS 운영 저장소 상태를 확인해 주세요."
};

export function formatLeaderboardOperationError(error: string | undefined, operation: LeaderboardOperation): string {
  return storageErrorForDisplay(error, LEADERBOARD_OPERATION_ERRORS[operation]);
}

export function supportsLegacyLeaderboardStorageTools(profileId: string): boolean {
  return profileId !== "geumcheon-2026";
}

export function readLeaderboardDayRound(storage: Pick<Storage, "getItem">, variant: string): boolean {
  try {
    return storage.getItem(`typingking:geumcheon-2026:${variant}:show-day-round`) === "true";
  } catch {
    return false;
  }
}

export function saveLeaderboardDayRound(storage: Pick<Storage, "setItem">, variant: string, visible: boolean): void {
  storage.setItem(`typingking:geumcheon-2026:${variant}:show-day-round`, String(visible));
}

export function resolveLeaderboardHighlight(current: string, rowId: string | null): string {
  return rowId === null || current === rowId ? "" : rowId;
}

export function LeaderboardApp({ bootstrap }: Props) {
  const { assetBaseUrl } = bootstrap;
  const [config, setConfig] = useState<AppConfig>(bootstrap.config);
  const leaderboardVariant = bootstrap.variant;
  const isPracticeBoard = bootstrap.variantPolicy.sessionKind === "practice";
  const isGeumcheonOfficialBoard = bootstrap.eventProfile.profileId === "geumcheon-2026" && !isPracticeBoard;
  const isGeumcheonPracticeBoard = bootstrap.eventProfile.profileId === "geumcheon-2026" && isPracticeBoard;
  const isGeumcheonBoard = isGeumcheonOfficialBoard || isGeumcheonPracticeBoard;
  const supportsLegacyStorageTools = supportsLegacyLeaderboardStorageTools(bootstrap.eventProfile.profileId);
  const showNormalLeaderboard = bootstrap.variantPolicy.gameModes.includes("normal");
  const showAiLeaderboard = bootstrap.variantPolicy.gameModes.includes("ai_challenge");
  const isDualPracticeBoard = isPracticeBoard && showNormalLeaderboard && showAiLeaderboard;
  const eventAsset = (configuredPath: string) => {
    return resolveEventAssetUrl(assetBaseUrl, bootstrap.eventProfile, configuredPath);
  };
  const [snapshot, setSnapshot] = useState<{ rows: RecordRow[]; matchingRecordIds: string[] | null }>({ rows: [], matchingRecordIds: null });
  const records = snapshot.rows;
  const [message, setMessage] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [lastSuccessfulReadAt, setLastSuccessfulReadAt] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [searchField, setSearchField] = useState<RecordListSearch["field"]>("name");
  const [appliedSearch, setAppliedSearch] = useState<RecordListSearch | null>(null);
  const appliedSearchRef = useRef<RecordListSearch | null>(null);
  const [searchInputError, setSearchInputError] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const composingRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const requestInFlightRef = useRef<number | null>(null);
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
  const [highlightedId, setHighlightedId] = useState("");
  const [showDayRound, setShowDayRound] = useState(() => {
    if (!isGeumcheonBoard || typeof window === "undefined") return false;
    try { return readLeaderboardDayRound(window.localStorage, leaderboardVariant); } catch { return false; }
  });
  const [dayRoundDraft, setDayRoundDraft] = useState(showDayRound);
  const visualSelectedId = isGeumcheonBoard ? highlightedId : selectedId;
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
    return () => {
      window.clearInterval(interval);
      requestGenerationRef.current += 1;
      requestInFlightRef.current = null;
    };
  }, [config.leaderboardRefreshSeconds]);

  const normalRecords = useMemo(() => {
    const source = records.filter(
      (record) =>
        (includeTest || record.is_test !== "true") &&
        (includeDebug || record.is_debug !== "true") &&
        record.game_mode !== "ai_challenge"
    ).map(normalizeFinalCpmForLeaderboard);
    const ranked = viewMode === "best" ? bestRecordOnly(source) : sortRecords(source);
    if (isGeumcheonOfficialBoard) {
      const matches = snapshot.matchingRecordIds === null ? null : new Set(snapshot.matchingRecordIds);
      return matches === null ? ranked : ranked.filter((record) => matches.has(record.record_id));
    }
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
  }, [authorized, includeDebug, includeTest, isGeumcheonOfficialBoard, records, snapshot.matchingRecordIds, search, viewMode]);

  const aiRecords = useMemo(() => {
    const source = records.filter(
      (record) =>
        (includeTest || record.is_test !== "true") &&
        (includeDebug || record.is_debug !== "true") &&
        record.game_mode === "ai_challenge"
    );
    const ranked = source
      .map(normalizeFinalCpmForLeaderboard)
      .map((record) => ({ record, display: buildAiLeaderboardDisplayV2(record) }));
    const visibleRanked = selectGeumcheonAiLeaderboardEntriesForMode(ranked, {
      isGeumcheonOfficialBoard,
      isGeumcheonPracticeBoard,
      viewMode
    });
    if (isGeumcheonOfficialBoard) {
      const matches = snapshot.matchingRecordIds === null ? null : new Set(snapshot.matchingRecordIds);
      return matches === null ? visibleRanked : visibleRanked.filter(({ record }) => matches.has(record.record_id));
    }
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
  }, [authorized, includeDebug, includeTest, isGeumcheonOfficialBoard, isGeumcheonPracticeBoard, records, snapshot.matchingRecordIds, search, viewMode]);

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

  function applySearch(next: RecordListSearch | null) {
    appliedSearchRef.current = next;
    setAppliedSearch(next);
    setSearchInputError("");
    void refresh(false);
  }

  function submitSearch() {
    if (composingRef.current) return;
    const term = search.trim();
    if (searchField === "contact" && term && (/[^0-9\s-]/.test(term) || !/[0-9]/.test(term))) {
      setSearchInputError("연락처는 숫자, 하이픈, 공백만 입력해 주세요.");
      return;
    }
    applySearch(term ? { field: searchField, term } : null);
  }

  async function refresh(silent: boolean): Promise<boolean> {
    if (silent && requestInFlightRef.current !== null) return false;
    let recordsRefreshed = false;
    const generation = ++requestGenerationRef.current;
    requestInFlightRef.current = generation;
    const requestedSearch = appliedSearchRef.current;
    if (isGeumcheonOfficialBoard) setSearchLoading(true);
    try {
      const now = Date.now();
      const shouldRefreshSlowStatus =
        !silent || adminOpenRef.current || now - lastSlowStatusRefreshAtRef.current >= SLOW_STATUS_REFRESH_MS;
      const [settingsResult, result, statusResult, backupResult] = await Promise.all([
        supportsLegacyStorageTools
          ? window.typingKing.getOneDriveSettings()
          : Promise.resolve(null),
        isGeumcheonOfficialBoard
          ? window.typingKing.listRecords({ search: requestedSearch })
          : window.typingKing.listRecords(),
        shouldRefreshSlowStatus && supportsLegacyStorageTools
          ? window.typingKing.getLeaderboardSyncStatus()
          : Promise.resolve(null),
        shouldRefreshSlowStatus && supportsLegacyStorageTools
          ? window.typingKing.getCsvBackupStatus()
          : Promise.resolve(null)
      ]);
      if (generation !== requestGenerationRef.current) return false;
      if (shouldRefreshSlowStatus) lastSlowStatusRefreshAtRef.current = now;
      if (settingsResult?.ok && settingsResult.data) {
        setConfig((current) => (sameLeaderboardConfig(current, settingsResult.data!) ? current : settingsResult.data!));
      }
      if (result.ok && result.data && (!isGeumcheonOfficialBoard || !requestedSearch || Array.isArray(result.matchingRecordIds))) {
        // Search IDs and all row fields are one fresh snapshot, including edits hidden by display masking.
        setSnapshot((current) => !isGeumcheonOfficialBoard && sameRecordSnapshot(current.rows, result.data!)
          ? current : { rows: result.data!, matchingRecordIds: isGeumcheonOfficialBoard ? result.matchingRecordIds ?? null : null });
        setRefreshError("");
        setLastSuccessfulReadAt(Date.now());
        recordsRefreshed = true;
      } else if (isGeumcheonOfficialBoard || !silent || result.code === "LOCKED") {
        setRefreshError(formatLeaderboardOperationError(result.error, "refresh"));
      }
      if (statusResult && statusResult.ok && statusResult.data) setSyncStatus(statusResult.data);
      if (backupResult && backupResult.ok && backupResult.data) setBackupStatus(backupResult.data);
      return recordsRefreshed;
    } catch {
      if (generation === requestGenerationRef.current) setRefreshError(formatLeaderboardOperationError(undefined, "refresh"));
      return false;
    } finally {
      if (generation === requestGenerationRef.current) {
        requestInFlightRef.current = null;
        setSearchLoading(false);
      }
    }
  }

  async function authorize() {
    const result = await window.typingKing.validateAdmin(password, adminName);
    if (result.ok) {
      setAuthorized(true);
      setMessage("관리자 모드에 진입했습니다.");
      if (supportsLegacyStorageTools) await loadBackups();
    } else {
      setMessage(formatLeaderboardOperationError(result.error, "authorize"));
    }
  }

  function closeAdmin() {
    setAdminOpen(false);
    setAuthorized(false);
    setPassword("");
    setMessage("");
    setEdit(null);
    setSelectedId("");
    setHighlightedId("");
    setDayRoundDraft(showDayRound);
  }

  function beginEdit(record: RecordRow) {
    const next = resolveLeaderboardRowClick({ selectedId, highlightedId, edit }, record, isGeumcheonBoard);
    setHighlightedId(next.highlightedId);
    setSelectedId(next.selectedId);
    setEdit(next.edit);
  }

  function saveDisplaySettings() {
    try {
      saveLeaderboardDayRound(window.localStorage, leaderboardVariant, dayRoundDraft);
      setShowDayRound(dayRoundDraft);
      setMessage("표시 설정을 저장했습니다.");
    } catch {
      setMessage("표시 설정을 저장하지 못했습니다. 다시 시도해 주세요.");
    }
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
    const submittedEdit = edit;
    const result = await window.typingKing.updateRecord(selectedId, submittedEdit, adminName || "admin");
    setMessage(
      result.ok
        ? "기록을 수정했습니다. 원본 기록은 보존되고, 수정된 기록이 리더보드에 새로 표시됩니다."
        : formatLeaderboardOperationError(result.error, "edit")
    );
    if (result.ok) {
      if (isGeumcheonOfficialBoard) {
        const refreshed = await refresh(false);
        if (refreshed) setEdit((current) => current === submittedEdit ? null : current);
      } else {
        setEdit(null);
        await refresh(false);
      }
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
        : formatLeaderboardOperationError(result.error, "hide")
    );
    if (result.ok) {
      setSelectedId("");
      setEdit(null);
      await refresh(false);
      if (supportsLegacyStorageTools) await loadBackups();
    }
  }

  async function clearAll() {
    if (!confirm("현재 회차 기록을 리더보드 표시에서 초기화하시겠습니까? 원본 기록은 삭제되지 않습니다.")) return;
    const result = await window.typingKing.clearRecords(adminName || "admin");
    setMessage(
      result.ok
        ? "현재 회차의 원본 기록은 삭제되지 않고 리더보드 표시에서만 숨겨집니다."
        : formatLeaderboardOperationError(result.error, "clear")
    );
    if (result.ok) {
      setSelectedId("");
      setEdit(null);
      await refresh(false);
      if (supportsLegacyStorageTools) await loadBackups();
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
        ? "CSV 파일을 내보냈습니다. 선택한 저장 위치에서 확인해 주세요."
        : formatLeaderboardOperationError(result.error, "export")
    );
    if (result.ok && supportsLegacyStorageTools) {
      const statusResult = await window.typingKing.getLeaderboardSyncStatus();
      if (statusResult.ok && statusResult.data) setSyncStatus(statusResult.data);
    }
  }

  async function exportSessionBackup() {
    const result = await window.typingKing.exportCurrentSessionBackup();
    setMessage(
      result.ok && result.data
        ? result.data.message
        : formatLeaderboardOperationError(result.error, "backup")
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
    setMessage(result.ok ? "백업에서 복원했습니다." : formatLeaderboardOperationError(result.error, "restore"));
    if (result.ok) await refresh(false);
  }

  return (
    <main className={isGeumcheonBoard ? "app leaderboard-app r7-geumcheon-leaderboard" : "app leaderboard-app"}
      onClickCapture={isGeumcheonBoard ? (event) => {
        if (!(event.target instanceof Element) || !event.target.closest("[data-leaderboard-record]")) {
          setHighlightedId(resolveLeaderboardHighlight(highlightedId, null));
        }
      } : undefined}
      style={{ backgroundImage: `url("${eventAsset(bootstrap.eventProfile.assets.leaderboardBackground)}")` }}>
      <header className="leaderboard-header">
        <div>
          {isGeumcheonBoard && <AssetImage
            src={eventAsset(bootstrap.eventProfile.assets.eventTitle)}
            alt={bootstrap.eventProfile.gameName}
            className="geumcheon-leaderboard-logo"
            fallback={<span>{bootstrap.eventProfile.gameName}</span>}
          />}
          {bootstrap.eventProfile.profileId !== "geumcheon-2026" && (
            <p className="eyebrow">2026 일잘러 페스타</p>
          )}
          <h1 className="visually-hidden">
            {bootstrap.variantPolicy.displayName}
          </h1>
        </div>
        {isGeumcheonOfficialBoard ? <div className="leader-actions uiv3-search-controls">
          <div className="uiv3-search-primary">
            <select aria-label="검색 구분" value={searchField} onChange={(event) => {
              setSearchField(event.target.value as RecordListSearch["field"]);
              setSearch("");
              composingRef.current = false;
              applySearch(null);
            }}>
              <option value="name">성명</option>
              <option value="contact">연락처</option>
            </select>
            <input className="search-input" aria-label="검색어" value={search}
              placeholder={searchField === "name" ? "성명을 입력하세요" : "연락처 일부를 입력하세요"}
              onChange={(event) => setSearch(event.target.value)}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !composingRef.current) {
                  event.preventDefault();
                  submitSearch();
                }
              }} />
            <button className="secondary-button" onClick={submitSearch}>검색</button>
          </div>
          <div className="uiv3-search-secondary">
            <button className="secondary-button" onClick={() => void refresh(false)}>새로고침</button>
            <button className="primary-button" onClick={() => setAdminOpen(true)}>관리자</button>
          </div>
        </div> : <div className="leader-actions">
          <input
            className="search-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="기록 검색"
          />
          <button className="secondary-button" onClick={() => void refresh(false)}>새로고침</button>
          <button className="primary-button" onClick={() => setAdminOpen(true)}>관리자</button>
        </div>}
      </header>

      <section className={isPracticeBoard ? "leaderboard-board split-board practice-board" : "leaderboard-board split-board"}>
        {(searchInputError || refreshError) && <div className="leaderboard-alert" role="alert">{searchInputError || refreshError}</div>}
        <div className={isDualPracticeBoard ? "dual-leaderboards" : "dual-leaderboards single-leaderboard"}>
          {showNormalLeaderboard && (
            <div className="ranking-table compact-ranking">
              <SessionSummary
                config={config}
                participantCount={normalPlayCount}
                geumcheon={isGeumcheonBoard}
                showDayRound={showDayRound}
                forcePractice={isPracticeBoard}
                compactPractice={isPracticeBoard}
                lastSuccessfulReadAt={lastSuccessfulReadAt}
                readFailed={Boolean(refreshError)}
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
                  <span>{isGeumcheonBoard ? "도전자명" : "참여자명"}</span>
                  <span>휴대폰번호</span>
                  <span>{isPracticeBoard ? "기록" : "최종 기록"}</span>
                  <span>{isPracticeBoard ? "타수" : "최종 타수"}</span>
                  <span>{isPracticeBoard ? "글자" : "클리어 기록"}</span>
                </div>
                {normalRecords.map((record, index) => (
                  <button
                    className={visualSelectedId === record.record_id ? "ranking-row normal-row selected" : "ranking-row normal-row"}
                    data-leaderboard-record={record.record_id}
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
            <div className="ranking-table compact-ranking ai-ranking" aria-busy={isGeumcheonOfficialBoard && searchLoading}>
              <SessionSummary
                config={config}
                participantCount={aiPlayCount}
                geumcheon={isGeumcheonBoard}
                showDayRound={showDayRound}
                forcePractice={isPracticeBoard}
                compactPractice={isPracticeBoard}
                lastSuccessfulReadAt={lastSuccessfulReadAt}
                readFailed={Boolean(refreshError)}
              />
              {!isGeumcheonBoard && <h2 className="leaderboard-mode-title leaderboard-ai-title">
                <AssetImage
                  src={bootstrap.eventProfile.profileId === "geumcheon-2026"
                    ? eventAsset(bootstrap.eventProfile.assets.eventTitle)
                    : `${assetBaseUrl}/ai_challenge/ai_title_oneline_trimmed.png`}
                  fallbackSrc={bootstrap.eventProfile.profileId === "geumcheon-2026"
                    ? undefined
                    : `${assetBaseUrl}/ai_challenge/ai_challenge_title.png`}
                    alt={bootstrap.variantPolicy.displayName}
                  className="leaderboard-mode-title-img leaderboard-ai-title-img"
                    fallback={<span>{bootstrap.eventProfile.gameName}</span>}
                />
              </h2>}
              <div className="ranking-body">
                <div className="ranking-head ai-head">
                  <span>순위</span>
                  <span>{isGeumcheonBoard ? "도전자명" : "참여자명"}</span>
                  <span>휴대폰번호</span>
                  <span>결과</span>
                  <span>{isPracticeBoard ? "스테이지" : "종료 지점"}</span>
                  <span>{isGeumcheonBoard ? (isPracticeBoard ? "도전자" : "도전자 기록") : (isPracticeBoard ? "참여자" : "참여자 기록")}</span>
                  <span>{isPracticeBoard ? "금나래" : "금나래 기록"}</span>
                  <span>{isPracticeBoard ? "시간" : "총 대결시간"}</span>
                </div>
                {aiRecords.map(({ record, display, rank }) => (
                  <button
                    className={visualSelectedId === record.record_id ? "ranking-row ai-row selected" : "ranking-row ai-row"}
                    data-leaderboard-record={record.record_id}
                    key={record.record_id}
                    onClick={() => beginEdit(record)}
                  >
                    <span className="rank-number">{rank}위</span>
                    <span>{maskParticipantName(record.participant_name)}</span>
                    <span>{record.phone_masked}</span>
                    <span className={display.resultLabel === "참여자 승리" ? "result-win" : "result-lose"}>{isGeumcheonBoard
                      ? display.resultLabel === "참여자 승리" ? "도전자 승리" : display.resultLabel === "금나래 승리" ? "AI 금나래 승리" : display.resultLabel
                      : display.resultLabel}</span>
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
                {isGeumcheonOfficialBoard && appliedSearch && !searchLoading && !refreshError && !searchInputError && aiRecords.length === 0
                  && <div className="ranking-empty" role="status">검색 결과가 없습니다.</div>}
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
                  eventProfileId={bootstrap.eventProfile.profileId}
                  deviceProfile={bootstrap.deviceProfile}
                  sessionKind={bootstrap.variantPolicy.sessionKind}
                  onSettingsChange={(nextConfig) => {
                    setConfig(nextConfig);
                    void refresh(false);
                  }}
                />

                {supportsLegacyStorageTools && syncStatus && (
                  <SyncStatusCard status={syncStatus} isPracticeSession={config.isPracticeSession || isPracticeBoard} />
                )}
                {supportsLegacyStorageTools && backupStatus && (
                  <BackupStatusCard status={backupStatus} showAi={showAiLeaderboard} />
                )}

                <div className="admin-toolbar">
                  {isGeumcheonOfficialBoard && <>
                    <label className="check-line compact">
                      <input type="checkbox" checked={dayRoundDraft} onChange={(event) => setDayRoundDraft(event.target.checked)} />
                      일차·회차 표시
                    </label>
                    <button className="secondary-button" onClick={saveDisplaySettings}>표시 설정 저장</button>
                  </>}
                  <button aria-pressed={viewMode === "best"} className={viewMode === "best" ? "stage-pill active" : "stage-pill"} onClick={() => setViewMode("best")}>
                    최고기록만 보기
                  </button>
                  <button aria-pressed={viewMode === "all"} className={viewMode === "all" ? "stage-pill active" : "stage-pill"} onClick={() => setViewMode("all")}>
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
                          className={visualSelectedId === record.record_id ? "selected" : ""}
                          data-leaderboard-record={record.record_id}
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
                          <span>{isGeumcheonBoard ? "도전자 이름" : "참여자 이름"}</span>
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
                      {supportsLegacyStorageTools && (
                        <button className="important-action" onClick={() => void exportSessionBackup()}>
                          현재 회차 CSV 백업
                        </button>
                      )}
                      <button onClick={() => void exportCsv("all")}>전체 기록 CSV</button>
                      <button className="danger-mini" onClick={clearAll}>현재 회차 표시 초기화</button>
                    </div>
                    {supportsLegacyStorageTools && (
                      <>
                        <h3>백업 파일</h3>
                        <div className="backup-list">
                          {backups.map((name) => (
                            <button key={name} onClick={() => void restore(name)}>{name}</button>
                          ))}
                          {backups.length === 0 && <p className="notice-text">백업 파일이 없습니다.</p>}
                        </div>
                      </>
                    )}
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

type LeaderboardRowState = { selectedId: string; highlightedId: string; edit: EditState | null };
type LeaderboardEditableRecord = Pick<RecordRow, "record_id" | keyof EditState>;

export function resolveLeaderboardRowClick(
  state: LeaderboardRowState,
  record: LeaderboardEditableRecord,
  geumcheon: boolean
): LeaderboardRowState {
  const highlightedId = geumcheon ? resolveLeaderboardHighlight(state.highlightedId, record.record_id) : state.highlightedId;
  if (geumcheon && state.selectedId === record.record_id && state.edit !== null) {
    return { ...state, highlightedId };
  }
  return { ...resolveLeaderboardEditSelection(geumcheon ? "" : state.selectedId, record), highlightedId };
}

export function resolveLeaderboardEditSelection(
  selectedId: string,
  record: LeaderboardEditableRecord
): { selectedId: string; edit: EditState | null } {
  if (selectedId === record.record_id) {
    return { selectedId: "", edit: null };
  }

  return {
    selectedId: record.record_id,
    edit: {
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
    }
  };
}

export function selectGeumcheonAiLeaderboardEntriesForMode(
  entries: AiLeaderboardEntry[],
  mode: {
    isGeumcheonOfficialBoard: boolean;
    isGeumcheonPracticeBoard: boolean;
    viewMode?: "all" | "best";
  }
): RankedAiLeaderboardEntry[] {
  const viewMode = mode.viewMode ?? "all";
  if (!mode.isGeumcheonOfficialBoard && !mode.isGeumcheonPracticeBoard) {
    const visibleEntries = viewMode === "best"
      ? selectBestAiLeaderboardEntries(entries)
      : entries;
    return [...visibleEntries]
      .sort((left, right) => compareLegacyAiRecords(left.record, right.record))
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
  }

  const canonicalEntries = entries.flatMap((entry) => {
    const attempt = entry.record.canonicalAttempt;
    if (!attempt || !isCanonicalAiAttemptPubliclyRankable(attempt, {
      recordId: entry.record.record_id
    })) {
      return [];
    }
    return [{ entry, attempt }];
  });
  const legacyEntries = entries
    .filter((entry) => entry.record.canonicalAttempt == null);
  const visibleEntries: AiLeaderboardCandidate[] = [
    ...canonicalEntries,
    ...legacyEntries.map((entry) => ({ entry }))
  ];
  const selectedEntries: AiLeaderboardCandidate[] = viewMode === "best"
    ? selectBestAiLeaderboardEntries(
      visibleEntries
    )
    : visibleEntries;
  const selectedCanonical = selectedEntries.filter(
    (entry): entry is { entry: AiLeaderboardEntry; attempt: NonNullable<RecordRow["canonicalAttempt"]> } => entry.attempt != null
  );
  const entryByAttempt = new Map(
    selectedCanonical.map(({ entry, attempt }) => [attempt, entry])
  );
  const rankedCanonical = rankCanonicalAiAttempts(
    selectedCanonical.map(({ attempt }) => attempt)
  ).map(({ rank, record: attempt }) => ({
    ...entryByAttempt.get(attempt)!,
    rank
  }));
  const rankedLegacy = selectedEntries
    .filter((entry): entry is { entry: AiLeaderboardEntry } => entry.attempt == null)
    .map(({ entry }) => entry)
    .sort((left, right) => compareLegacyAiRecords(left.record, right.record))
    .map((entry, index) => ({
      ...entry,
      rank: rankedCanonical.length + index + 1
    }));
  return [...rankedCanonical, ...rankedLegacy];
}

function selectBestAiLeaderboardEntries<T extends AiLeaderboardEntry | AiLeaderboardCandidate>(entries: T[]): T[] {
  const bestByParticipant = new Map<string, T>();
  for (const entry of entries) {
    const record = "record" in entry ? entry.record : entry.entry.record;
    const key = aiLeaderboardParticipantKey(record);
    const current = bestByParticipant.get(key);
    if (!current || compareAiLeaderboardEntries(entry, current) < 0) {
      bestByParticipant.set(key, entry);
    }
  }
  return [...bestByParticipant.values()];
}

let aiLeaderboardFallbackKeySalt: string | null = null;

export function aiLeaderboardParticipantKey(record: RecordRow): string {
  const canonicalKey = record.participantKey?.trim();
  if (canonicalKey) return canonicalKey;

  const participantName = record.participant_name.normalize("NFC").trim().toLowerCase();
  const phone = digitsOnly(record.phone_full || `${record.phone_part1}${record.phone_part2}${record.phone_part3}`);
  const birthdate = digitsOnly(record.birthdate || `${record.birth_year}${record.birth_month}${record.birth_day}`);
  const identity = phone && birthdate
    ? `name-phone-birth\u0000${participantName}\u0000${phone}\u0000${birthdate}`
    : `record-id\u0000${record.record_id}`;
  return `legacy-sha256:${sha256Hex(`${fallbackKeySalt()}\u0000${identity}`)}`;
}

function fallbackKeySalt(): string {
  if (aiLeaderboardFallbackKeySalt) return aiLeaderboardFallbackKeySalt;
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  aiLeaderboardFallbackKeySalt = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return aiLeaderboardFallbackKeySalt;
}

function digitsOnly(value: string): string {
  return value.normalize("NFC").replace(/\D/g, "");
}

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function sha256Hex(value: string): string {
  const source = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;

  const view = new DataView(bytes.buffer);
  const bitLength = source.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15];
      const word2 = words[index - 2];
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function compareAiLeaderboardEntries(
  left: AiLeaderboardEntry | AiLeaderboardCandidate,
  right: AiLeaderboardEntry | AiLeaderboardCandidate
): number {
  const leftEntry = "record" in left ? left : left.entry;
  const rightEntry = "record" in right ? right : right.entry;
  const leftAttempt = "record" in left ? left.record.canonicalAttempt : left.attempt;
  const rightAttempt = "record" in right ? right.record.canonicalAttempt : right.attempt;
  if (leftAttempt && rightAttempt) return compareCanonicalAiDisplayOrder(leftAttempt, rightAttempt);
  if (leftAttempt) return -1;
  if (rightAttempt) return 1;
  return compareLegacyAiRecords(leftEntry.record, rightEntry.record);
}

function enrichRecordForExport(record: RecordRow): RecordRow {
  return enrichAiRecordForExportV2(normalizeFinalCpmForLeaderboard(record));
}

export function buildAiLeaderboardDisplayV2(record: RecordRow): AiLeaderboardDisplay {
  const resultLabel = normalizeAiResultLabelV2(record);
  const resultStage = getAiResultStageV2(record, resultLabel);
  const stageResults = normalizeStageResultsV2(record, resultLabel, resultStage);
  const participantProgresses = buildParticipantProgressesV2(record, stageResults, resultStage);
  const aiProgresses = buildAiProgressesV2(record, stageResults, resultStage);
  const rawParticipantProgress =
    parseFiniteNumber(record.participant_progress_percent) ?? averageProgressV2(participantProgresses);
  const rawAiProgress = parseFiniteNumber(record.ai_progress_percent) ?? averageProgressV2(aiProgresses);
  const participantProgressPercent = resultLabel === "참여자 승리" ? 100 : rawParticipantProgress;
  const aiProgressPercent = resultLabel === "금나래 승리" ? 100 : rawAiProgress;
  const duelTimeMs = parseFiniteNumber(record.duel_time_ms) ?? estimateDuelTimeMsV2(record, stageResults, resultStage);
  // 저장된 평균 타수는 0(=입력 없음)도 유효값으로 존중한다. firstFiniteNumber는 0을 "없음"으로
  // 취급해 잘못된 보정값(final_cpm 기반)을 만들어 진행률 0%인데 평균 타수가 표시되는 모순을 유발했다.
  const participantAvgCpm =
    parseFiniteNumber(record.participant_avg_cpm) ??
    computeAverageCpmFromProgressV2(record, participantProgresses, stageResults, resultStage, "participant");
  const aiAvgCpm =
    parseFiniteNumber(record.ai_avg_cpm) ??
    computeAverageCpmFromProgressV2(record, aiProgresses, stageResults, resultStage, "ai");
  const participantTimeMs =
    parseFiniteNumber(record.participant_result_time_ms) ??
    estimateParticipantFinishTimeV2(record, resultLabel, resultStage, participantAvgCpm);
  const aiTimeMs = parseFiniteNumber(record.ai_result_time_ms) ?? estimateAiFinishTimeV2(record, resultStage);

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
    duelRecordText: formatLeaderboardMs(duelTimeMs),
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

function normalizeAiResultLabelV2(record: RecordRow): "참여자 승리" | "금나래 승리" | "중단 패배" {
  if (record.challenge_result_label.includes("중단") || isInterruptedRecord(record)) return "중단 패배";
  if (/금나래 승리|AI 승리|참여자 패배/.test(record.challenge_result_label)) return "금나래 승리";
  if (/참여자 승리|금나래 패배|AI 패배/.test(record.challenge_result_label)) return "참여자 승리";
  if (record.challenge_result_label.includes("승리")) return "참여자 승리";
  if (record.challenge_result_label.includes("패배")) return "금나래 승리";
  return record.ai_challenge_status === "SUCCESS" || record.final_vs_ai_result === "USER_WIN"
    ? "참여자 승리"
    : "금나래 승리";
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
  const storedStageCounts = [record.stage1_char_count, record.stage2_char_count, record.stage3_char_count];
  const limit = Math.max(1, Math.min(3, resultStage || 1));
  return storedStageCounts
    .slice(0, limit)
    .reduce((sum, value, index) => sum + (parseFiniteNumber(value) ?? countTypeableChars(stageTexts[index] ?? "")), 0);
}

export function maskParticipantName(name: string): string {
  const chars = Array.from(String(name ?? "").trim());
  if (chars.length === 0) return "";
  if (chars.length === 1) return chars[0];
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${"*".repeat(chars.length - 2)}${chars.at(-1)}`;
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

export function SessionSummary({
  config,
  participantCount = 0,
  forcePractice = false,
  compactPractice = false,
  geumcheon = false,
  showDayRound = false,
  lastSuccessfulReadAt = null,
  readFailed = false
}: {
  config: AppConfig;
  participantCount?: number;
  forcePractice?: boolean;
  compactPractice?: boolean;
  geumcheon?: boolean;
  showDayRound?: boolean;
  lastSuccessfulReadAt?: number | null;
  readFailed?: boolean;
}) {
  const day = Number(config.dayNo) || 1;
  const round = Number(config.roundNo) || 1;
  const count = Number.isFinite(participantCount) ? participantCount : 0;
  const isPractice = forcePractice || Boolean(config.isPracticeSession);
  if (geumcheon && !isPractice) {
    return <div className="leaderboard-session">
      <div className="session-top">
        <span className="session-count">현재 참여 기록 {count}건</span>
        <span className="leaderboard-public-read-status"
          data-public-read-state={readFailed ? "error" : lastSuccessfulReadAt === null ? "pending" : "connected"}
          data-last-read-at={lastSuccessfulReadAt ?? ""}>
          <span className="public-read-connection">{readFailed ? "조회 오류" : lastSuccessfulReadAt === null ? "연결 확인 중" : "연결 정상"}</span>
          <span>마지막 조회 시각 <time>{lastSuccessfulReadAt === null ? "--:--:--" : new Date(lastSuccessfulReadAt).toLocaleTimeString("ko-KR", { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></span>
        </span>
      </div>
      {showDayRound && <div className="session-badges">
        <strong className="session-day">{day}일차</strong>
        <strong className="session-round">{round}회차</strong>
      </div>}
    </div>;
  }
  return (
    <div
      className={isPractice ? "leaderboard-session practice-session" : "leaderboard-session"}
      aria-label={
        isPractice
          ? `현재 세션 연습 기록 ${count}건 자유 연습회차`
          : `현재 세션 공식 도전 기록 ${count}건 ${day}일차 ${round}회차`
      }
    >
      <div className="session-top">
        <span className="session-label">현재 세션</span>
        <span className="session-count">{isPractice ? `연습 기록 ${count}건` : `공식 도전 기록 ${count}건`}</span>
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
      {status.error && (
        <p className="sync-status-error">{formatLeaderboardOperationError(status.error, "refresh")}</p>
      )}
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
