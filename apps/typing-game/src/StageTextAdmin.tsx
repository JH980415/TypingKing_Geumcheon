import { useEffect, useMemo, useState } from "react";
import type { StageText } from "../../../shared/types";
import { OneDriveSettingsPanel } from "../../shell/src/OneDriveSettingsPanel";

type Props = {
  onClose: () => void;
  onStartDebug: (mode: TextMode) => void;
  allowedMode?: TextMode;
  isPractice?: boolean;
};

type TextMode = "normal" | "ai_challenge";

const MODE_LABELS: Record<TextMode, string> = {
  normal: "일잘러 타자왕",
  ai_challenge: "AI 타자왕"
};

function modeOf(row: StageText): TextMode {
  return row.game_mode === "ai_challenge" ? "ai_challenge" : "normal";
}

export function StageTextAdmin({ onClose, onStartDebug, allowedMode = "normal", isPractice = false }: Props) {
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
      setMessage(result.error || "관리자 비밀번호가 올바르지 않습니다.");
    }
  }

  async function reload() {
    const result = await window.typingKing.listStageTexts();
    if (result.ok && result.data) setRows(result.data);
    else setMessage(result.error || "문구 목록을 불러오지 못했습니다.");
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
      const sent = result.data.sent;
      const failed = result.data.failed;
      if (sent > 0 && failed === 0) {
        setQueueMessage(`임시 저장 기록 ${sent}건을 기록 폴더에 다시 올렸습니다.\n리더보드는 OneDrive 동기화 후 반영됩니다.`);
      } else if (sent > 0 && failed > 0) {
        setQueueMessage(
          `임시 저장 기록 ${sent}건을 기록 폴더에 다시 올렸습니다.\n다만 ${failed}건은 다시 올리지 못했습니다.\nOneDrive 상태, 기록 폴더 설정, 디스크 권한을 확인해 주세요.`
        );
      } else if (sent === 0 && failed > 0) {
        setQueueMessage("기록 폴더에 다시 올리지 못했습니다.\nOneDrive 상태, 기록 폴더 설정, 디스크 권한을 확인해 주세요.");
      } else {
        setQueueMessage("다시 올릴 누락 기록이 없습니다.");
      }
    } else {
      setQueueMessage(result.error || "기록 폴더에 다시 올리지 못했습니다.\nOneDrive 상태, 기록 폴더 설정, 디스크 권한을 확인해 주세요.");
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
      setMessage(result.error || "문구 저장 중 오류가 발생했습니다. 다시 시도해 주세요.");
    }
  }

  async function toggle(row: StageText) {
    const result = await window.typingKing.updateStageText(row.id, {
      is_active: row.is_active === "true" ? "false" : "true"
    });
    if (!result.ok) setMessage(result.error || "문구 저장 중 오류가 발생했습니다. 다시 시도해 주세요.");
    await reload();
  }

  async function softDelete(row: StageText) {
    if (!window.confirm("선택한 문구를 삭제 또는 비활성화하시겠습니까?")) return;
    const result = await window.typingKing.softDeleteStageText(row.id);
    if (!result.ok) setMessage(result.error || "문구 저장 중 오류가 발생했습니다. 다시 시도해 주세요.");
    await reload();
  }

  async function hardDelete(row: StageText) {
    if (!window.confirm("선택한 문구를 완전히 삭제하시겠습니까?")) return;
    const result = await window.typingKing.hardDeleteStageText(row.id);
    if (!result.ok) setMessage(result.error || "문구 저장 중 오류가 발생했습니다. 다시 시도해 주세요.");
    await reload();
  }

  async function publishSharedSettings() {
    setSyncBusy(true);
    const result = await window.typingKing.publishStageTextsToOneDrive();
    setSyncBusy(false);
    if (result.ok && result.data) {
      setMessage(`문구 설정을 OneDrive에 저장했습니다.\n다른 PC는 잠시 후 자동으로 갱신됩니다.\n저장 문구: ${result.data.count}건`);
      await reload();
    } else {
      setMessage(result.error || "문구 설정을 OneDrive에 저장하지 못했습니다. OneDrive 폴더 설정을 확인해 주세요.");
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
            <button className="icon-button" onClick={onClose} aria-label="닫기">×</button>
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
            <button className="secondary-button" onClick={onClose}>취소</button>
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
            <p className="eyebrow">Stage Text Manager</p>
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
          <button className="icon-button" onClick={onClose} aria-label="닫기">×</button>
        </header>

        <section className="debug-mode-panel">
          <h3>디버그 모드</h3>
          <p>디버그 모드는 기능 테스트용입니다. 기록은 리더보드에 반영되지 않습니다.</p>
          <div className="debug-mode-options">
            {allowedMode === "normal" && (
              <button type="button" className="primary-button" onClick={() => onStartDebug("normal")}>
                일잘러 타자왕 디버그 시작
              </button>
            )}
            {allowedMode === "ai_challenge" && (
              <button type="button" className="primary-button" onClick={() => onStartDebug("ai_challenge")}>
                AI 타자왕 디버그 시작
              </button>
            )}
            <button type="button" className="secondary-button" onClick={onClose}>
              메인화면으로 돌아가기
            </button>
          </div>
          <div className="debug-mode-notes">
            <span>일잘러 타자왕을 실제 방식과 동일하게 테스트합니다. 기록은 리더보드에 반영되지 않습니다.</span>
            <span>AI 타자왕을 테스트합니다. AI 속도는 모든 스테이지에서 100타로 고정됩니다.</span>
          </div>
        </section>

        <OneDriveSettingsPanel role="player" isPractice={isPractice} />

        <section className="queued-records-panel">
          <div>
            <p className="eyebrow">누락 기록</p>
            <h3>누락 기록 {queuedCount}건</h3>
            <p>
              OneDrive 저장에 실패해 이 PC에 임시 보관된 기록입니다.
              관리자 설정이 완료된 뒤 기록 폴더에 다시 올릴 수 있습니다.
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

        {isPractice && (
          <p className="practice-mode-note">연습모드의 문구는 읽기 전용입니다. 문구 변경과 전체 PC 공유는 공식 실행기의 관리자 모드에서 진행해 주세요.</p>
        )}
        {!isPractice && <div className="admin-editor">
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
              설정 저장
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
              <span>{isPractice ? "권한" : "관리"}</span>
          </div>
          {filtered.map((row) => (
            <div className="admin-table-row" key={row.id}>
              <span className={row.is_active === "true" ? "status active" : "status inactive"}>
                {row.is_active === "true" ? "활성" : "비활성"}
              </span>
              <span className="stage-text-preview">{row.text}</span>
              {isPractice ? (
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
