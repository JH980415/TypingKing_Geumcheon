import { useEffect, useMemo, useRef, useState } from "react";
import type { DeviceProfile, EventProfileId, SessionKind, StageText } from "../../../shared/types";
import {
  formatQueuedRecordFlushMessage,
  OneDriveSettingsPanel,
  storageErrorForDisplay
} from "../../shell/src/OneDriveSettingsPanel";

type Props = {
  onClose: () => void;
  onStartDebug: (mode: TextMode) => void;
  onTransitionBusyChange?: (busy: boolean) => void;
  allowedMode?: TextMode;
  isPractice?: boolean;
  eventProfileId?: EventProfileId;
  deviceProfile?: DeviceProfile;
  sessionKind?: SessionKind;
};

type TextMode = "normal" | "ai_challenge";

const MODE_LABELS: Record<TextMode, string> = {
  normal: "일잘러 타자왕",
  ai_challenge: "AI 타자왕"
};

function modeOf(row: StageText): TextMode {
  return row.game_mode === "ai_challenge" ? "ai_challenge" : "normal";
}

export function formatStageTextPublishSuccess(count: number): string {
  return `문구 설정을 NAS 운영 저장소에 공유했습니다.\n다른 PC는 잠시 후 자동으로 갱신됩니다.\n저장 문구: ${count}건`;
}

export function stageTextEditingAllowed(profileId: EventProfileId | undefined, practice: boolean): boolean {
  return !practice && profileId !== "geumcheon-2026";
}

export function StageTextAdmin({
  onClose,
  onStartDebug,
  onTransitionBusyChange,
  allowedMode = "normal",
  isPractice = false,
  eventProfileId,
  deviceProfile,
  sessionKind
}: Props) {
  const canEditStageTexts = stageTextEditingAllowed(eventProfileId, isPractice);
  const [transitionBusy, setTransitionBusy] = useState(false);
  const transitionBusyRef = useRef(false);
  function handleTransitionBusyChange(busy: boolean) {
    transitionBusyRef.current = busy;
    setTransitionBusy(busy);
    onTransitionBusyChange?.(busy);
  }
  function closeAdmin() {
    if (!transitionBusyRef.current) onClose();
  }
  function startDebug(mode: TextMode) {
    if (!transitionBusyRef.current) onStartDebug(mode);
  }
  const [authorized, setAuthorized] = useState(false);
  const [password, setPassword] = useState("");
  const [adminName, setAdminName] = useState("admin");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<TextMode>(allowedMode);
  const [stage, setStage] = useState("1");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<StageText[]>([]);
  const [editingId, setEditingId] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const [queuedCount, setQueuedCount] = useState(0);
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueMessage, setQueueMessage] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);

  useEffect(() => {
    if (authorized) {
      void reload();
      void loadQueuedStatus();
    }
  }, [authorized]);

  useEffect(() => {
    if (!authorized) return;
    const timer = window.setInterval(() => {
      void reload();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [authorized]);

  const modeRows = useMemo(() => rows.filter((row) => modeOf(row) === mode), [mode, rows]);

  const filtered = useMemo(
    () =>
      modeRows
        .filter((row) => row.stage_number === stage)
        .filter((row) => showInactive || row.is_active === "true"),
    [modeRows, stage, showInactive]
  );

  const counts = useMemo(() => {
    return [1, 2, 3].map((value) => ({
      stage: value,
      active: modeRows.filter((row) => row.stage_number === String(value) && row.is_active === "true").length,
      total: modeRows.filter((row) => row.stage_number === String(value)).length
    }));
  }, [modeRows]);

  async function authorize() {
    const result = await window.typingKing.validateAdmin(password, adminName);
    if (result.ok) {
      setAuthorized(true);
      setMessage("");
    } else {
      setMessage("관리자 비밀번호가 올바르지 않습니다.");
    }
  }

  async function reload() {
    const result = await window.typingKing.listStageTexts();
    if (result.ok && result.data) setRows(result.data);
    else setMessage("문구 목록을 불러오지 못했습니다.");
  }

  async function loadQueuedStatus() {
    const result = await window.typingKing.getQueuedRecordStatus();
    if (result.ok && result.data) setQueuedCount(result.data.count);
  }

  async function flushQueuedRecords() {
    setQueueBusy(true);
    setQueueMessage("");
    const result = await window.typingKing.flushQueuedRecords();
    setQueueBusy(false);
    if (result.ok && result.data) {
      setQueueMessage(formatQueuedRecordFlushMessage(result.data));
    } else {
      setQueueMessage(
        storageErrorForDisplay(
          result.error,
          "누락 기록을 NAS 기록 저장소에 반영하지 못했습니다.\nNAS 연결과 역할별 권한을 확인해 주세요."
        )
      );
    }
    await loadQueuedStatus();
  }

  async function save() {
    const result = editingId
      ? await window.typingKing.updateStageText(editingId, { game_mode: mode, stage_number: stage, text })
      : await window.typingKing.addStageText(stage, text, mode);
    if (result.ok) {
      setText("");
      setEditingId("");
      setMessage(`${MODE_LABELS[mode]} 문구를 저장했습니다.`);
      await reload();
    } else {
      setMessage("문구 저장 중 오류가 발생했습니다. 다시 시도해 주세요.");
    }
  }

  async function toggle(row: StageText) {
    const result = await window.typingKing.updateStageText(row.id, {
      is_active: row.is_active === "true" ? "false" : "true"
    });
    if (!result.ok) setMessage("문구 저장 중 오류가 발생했습니다. 다시 시도해 주세요.");
    await reload();
  }

  async function softDelete(row: StageText) {
    if (!window.confirm("선택한 문구를 삭제 또는 비활성화하시겠습니까?")) return;
    const result = await window.typingKing.softDeleteStageText(row.id);
    if (!result.ok) setMessage("문구 저장 중 오류가 발생했습니다. 다시 시도해 주세요.");
    await reload();
  }

  async function hardDelete(row: StageText) {
    if (!window.confirm("선택한 문구를 완전히 삭제하시겠습니까?")) return;
    const result = await window.typingKing.hardDeleteStageText(row.id);
    if (!result.ok) setMessage("문구 저장 중 오류가 발생했습니다. 다시 시도해 주세요.");
    await reload();
  }

  async function publishSharedSettings() {
    setSyncBusy(true);
    const result = await window.typingKing.publishStageTextsToOneDrive();
    setSyncBusy(false);
    if (result.ok && result.data) {
      setMessage(formatStageTextPublishSuccess(result.data.count));
      await reload();
    } else {
      setMessage(
        storageErrorForDisplay(
          result.error,
          "문구 설정을 NAS 운영 저장소에 공유하지 못했습니다. NAS 운영 루트와 폴더 검증 상태를 확인해 주세요."
        )
      );
    }
  }

  function resetEditor(nextMode?: TextMode) {
    if (nextMode) setMode(nextMode);
    setEditingId("");
    setText("");
    setMessage("");
  }

  if (!authorized) {
    return (
      <div className="modal-backdrop">
        <section className="modal admin-modal">
          <header className="modal-header">
            <h2>관리자 로그인</h2>
            <button className="icon-button" onClick={closeAdmin} disabled={transitionBusy} aria-label="닫기">×</button>
          </header>
          <label className="field">
            <span>관리자 이름</span>
            <input value={adminName} onChange={(event) => setAdminName(event.target.value)} />
          </label>
          <label className="field">
            <span>관리자 비밀번호</span>
            <input
              value={password}
              type="password"
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void authorize();
              }}
            />
          </label>
          {message && <p className="error-text">{message}</p>}
          <div className="button-row">
            <button className="secondary-button" onClick={closeAdmin} disabled={transitionBusy}>취소</button>
            <button className="primary-button" onClick={authorize}>비밀번호 확인</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="modal-backdrop">
      <section className="modal admin-modal wide">
        <header className="modal-header">
          <div>
            <p className="eyebrow">문구 관리</p>
            <div className="mode-manager-tabs" aria-label="문구 관리 모드 선택">
              {([allowedMode] as const).map((value) => (
                <button
                  key={value}
                  className={mode === value ? "stage-pill active" : "stage-pill"}
                  onClick={() => resetEditor(value)}
                >
                  {MODE_LABELS[value]}
                </button>
              ))}
            </div>
          </div>
          <button className="icon-button" onClick={closeAdmin} disabled={transitionBusy} aria-label="닫기">×</button>
        </header>

        <section className="debug-mode-panel">
          <h3>디버그 모드</h3>
          <p>디버그 모드는 기능 테스트용입니다. 기록은 리더보드에 반영되지 않습니다.</p>
          <div className="debug-mode-options">
            {allowedMode === "normal" && (
              <button type="button" className="primary-button" onClick={() => startDebug("normal")} disabled={transitionBusy}>
                일잘러 타자왕 디버그 시작
              </button>
            )}
            {allowedMode === "ai_challenge" && (
              <button type="button" className="primary-button" onClick={() => startDebug("ai_challenge")} disabled={transitionBusy}>
                AI 타자왕 디버그 시작
              </button>
            )}
            <button type="button" className="secondary-button" onClick={closeAdmin} disabled={transitionBusy}>
              메인화면으로 돌아가기
            </button>
          </div>
          <div className="debug-mode-notes">
            <span>일잘러 타자왕을 실제 방식과 동일하게 테스트합니다. 기록은 리더보드에 반영되지 않습니다.</span>
            <span>AI 타자왕을 테스트합니다. AI 속도는 모든 스테이지에서 100타로 고정됩니다.</span>
          </div>
        </section>

        <OneDriveSettingsPanel
          role="player"
          isPractice={isPractice}
          eventProfileId={eventProfileId}
          deviceProfile={deviceProfile}
          sessionKind={sessionKind}
          gameMode={allowedMode}
          onTransitionBusyChange={handleTransitionBusyChange}
        />

        <section className="queued-records-panel">
          <div>
            <p className="eyebrow">누락 기록</p>
            <h3>누락 기록 {queuedCount}건</h3>
            <p>
              NAS 기록 저장소에 제출하지 못해 이 PC에 임시 보관된 기록입니다.
              관리자 설정과 폴더 검증이 완료된 뒤 다시 반영할 수 있습니다.
            </p>
          </div>
          <button className="primary-button" onClick={flushQueuedRecords} disabled={queueBusy || queuedCount === 0}>
            누락 기록 반영하기
          </button>
          {queueMessage && <p className="notice-text">{queueMessage}</p>}
        </section>

        <div className="stage-counts">
          {counts.map((count) => (
            <button
              key={count.stage}
              className={stage === String(count.stage) ? "stage-pill active" : "stage-pill"}
              onClick={() => setStage(String(count.stage))}
            >
              Stage {count.stage}
              <strong>{count.active}/{count.total}</strong>
            </button>
          ))}
        </div>

        {eventProfileId === "geumcheon-2026" && (
          <p className="practice-mode-note">금천과학축제 승인 문구는 읽기 전용입니다. 문구 변경은 승인된 배포 패키지로만 적용합니다.</p>
        )}
        {isPractice && eventProfileId !== "geumcheon-2026" && (
          <p className="practice-mode-note">연습모드의 문구는 읽기 전용입니다. 문구 변경과 전체 PC 공유는 공식 실행기의 관리자 모드에서 진행해 주세요.</p>
        )}
        {canEditStageTexts && <div className="admin-editor">
          <label className="field grow">
            <span>{editingId ? `${MODE_LABELS[mode]} 문구 수정` : `${MODE_LABELS[mode]} 문구 추가`}</span>
            <textarea
              value={text}
              rows={3}
              placeholder={`${MODE_LABELS[mode]} 문구를 입력해 주세요.`}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <div className="stacked-actions">
            <button className="primary-button" onClick={save}>{editingId ? "수정 저장" : "추가"}</button>
            <button className="secondary-button" onClick={publishSharedSettings} disabled={syncBusy}>
              문구 설정 공유
            </button>
            {editingId && (
              <button className="secondary-button" onClick={() => resetEditor()}>
                편집 취소
              </button>
            )}
          </div>
        </div>}

        <label className="check-line compact">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(event) => setShowInactive(event.target.checked)}
          />
          비활성 문구도 보기
        </label>

        {message && <p className="notice-text">{message}</p>}

        <div className="admin-table stage-table">
          <div className="admin-table-head">
            <span>상태</span>
            <span>문구</span>
              <span>{canEditStageTexts ? "관리" : "권한"}</span>
          </div>
          {filtered.map((row) => (
            <div className="admin-table-row" key={row.id}>
              <span className={row.is_active === "true" ? "status active" : "status inactive"}>
                {row.is_active === "true" ? "활성" : "비활성"}
              </span>
              <span className="stage-text-preview">{row.text}</span>
              {!canEditStageTexts ? (
                <span className="status inactive">읽기 전용</span>
              ) : <span className="mini-actions">
                <button onClick={() => toggle(row)}>{row.is_active === "true" ? "비활성" : "활성"}</button>
                <button
                  onClick={() => {
                    setEditingId(row.id);
                    setMode(modeOf(row));
                    setStage(row.stage_number);
                    setText(row.text);
                  }}
                >
                  수정
                </button>
                <button onClick={() => softDelete(row)}>삭제</button>
                <button className="danger-mini" onClick={() => hardDelete(row)}>완전 삭제</button>
              </span>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
