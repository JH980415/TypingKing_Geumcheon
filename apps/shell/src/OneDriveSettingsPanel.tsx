import { useEffect, useMemo, useState } from "react";
import type {
  AppConfig,
  DeviceProfile,
  EventProfileId,
  PcRole,
  QueuedRecordFlushResult,
  SessionKind
} from "../../../shared/types";

type StorageSettingsForm = {
  oneDriveRoot: string;
  recordBaseFolderName: string;
  dayNo: string;
  roundNo: string;
  pcId: string;
};

type Props = {
  role: PcRole;
  isPractice?: boolean;
  eventProfileId?: EventProfileId;
  deviceProfile?: DeviceProfile;
  sessionKind?: SessionKind;
  gameMode?: "normal" | "ai_challenge";
  onSettingsChange?: (config: AppConfig) => void;
};

const SKILLUP_PLAYER_PC_IDS = ["PC01", "PC02", "PC03", "PC04", "PC05", "PC06"];
const SKILLUP_LEADERBOARD_PC_IDS = ["PC07", "PC08"];
const GEUMCHEON_PLAYER_PC_IDS = [
  "PC01",
  "PC02",
  "PC03",
  "PC04",
  "PC05",
  "PC06",
  "PC07",
  "PC08",
  "PC09",
  "PC10"
];
const GEUMCHEON_LEADERBOARD_PC_IDS = ["LEADERBOARD01"];
const DEFAULT_RECORD_BASE_FOLDER = "기록저장";

function geumcheonPcOptionsForRole(role: PcRole): string[] {
  return role === "leaderboard" ? GEUMCHEON_LEADERBOARD_PC_IDS : GEUMCHEON_PLAYER_PC_IDS;
}

function normalizePcId(pcId: string | undefined, role: PcRole): string {
  const options = geumcheonPcOptionsForRole(role);
  const candidate = pcId?.trim().toUpperCase() ?? "";
  return options.includes(candidate) ? candidate : options[0];
}

function toSkillUpForm(config?: AppConfig): StorageSettingsForm {
  return {
    oneDriveRoot: config?.oneDriveRoot ?? "",
    recordBaseFolderName: config?.recordBaseFolderName || DEFAULT_RECORD_BASE_FOLDER,
    dayNo: String(config?.dayNo || 1),
    roundNo: String(config?.roundNo || 1),
    pcId: config?.pcId || "PC01"
  };
}

function cleanNumber(value: string): string {
  return value.replace(/\D/g, "").slice(0, 2);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/[\\/]+$/g, "");
}

function previewPath(form: StorageSettingsForm, isPractice = false): string {
  const root = trimTrailingSlash(form.oneDriveRoot.trim());
  const base = form.recordBaseFolderName.trim() || DEFAULT_RECORD_BASE_FOLDER;
  const day = Number(form.dayNo) || 1;
  const round = Number(form.roundNo) || 1;
  if (!root) return "OneDrive 루트 폴더를 선택하면 자동 생성 경로가 표시됩니다.";
  if (isPractice) return `${root}\\${base}\\연습회차`;
  return `${root}\\${base}\\${day}일차\\${round}회차`;
}

function formatSkillUpQueuedRecordFlushMessage(result: QueuedRecordFlushResult): string {
  const targetText = result.targetPaths.length > 0 ? `\n대상 경로: ${result.targetPaths[0]}` : "";
  const failureText =
    result.failures.length > 0
      ? `\n실패 사유: ${result.failures.map((item) => `${item.fileName} - ${item.error}`).join(" / ")}`
      : "";

  if (result.sent > 0 && result.failed === 0) {
    return `누락 기록 ${result.sent}건을 OneDrive 기록 폴더에 반영했습니다.${targetText}\n리더보드는 OneDrive 동기화 후 반영됩니다.`;
  }
  if (result.sent > 0 && result.failed > 0) {
    return `누락 기록 ${result.sent}건을 OneDrive 기록 폴더에 반영했습니다.${targetText}\n다만 ${result.failed}건은 다시 올리지 못했습니다.${failureText}\nOneDrive 상태, 기록 폴더 설정, 디스크 권한을 확인해 주세요.`;
  }
  if (result.sent === 0 && result.failed > 0) {
    return `기록 폴더에 다시 올리지 못했습니다.${failureText}\nOneDrive 상태, 기록 폴더 설정, 디스크 권한을 확인해 주세요.`;
  }
  return "다시 올릴 누락 기록이 없습니다.";
}

export function formatQueuedRecordFlushMessage(result: QueuedRecordFlushResult): string {
  if (result.sent > 0 && result.failed === 0) {
    return `누락 기록 ${result.sent}건을 NAS 기록 저장소에 반영했습니다.\n리더보드는 기록을 새로고침하면 반영됩니다.`;
  }
  if (result.sent > 0 && result.failed > 0) {
    return `누락 기록 ${result.sent}건을 NAS 기록 저장소에 반영했습니다.\n다만 ${result.failed}건은 반영하지 못했습니다. NAS 연결, 운영 폴더 검증 상태, 역할별 권한을 확인해 주세요.`;
  }
  if (result.sent === 0 && result.failed > 0) {
    return "누락 기록을 NAS 기록 저장소에 반영하지 못했습니다.\nNAS 연결, 운영 폴더 검증 상태, 역할별 권한을 확인해 주세요.";
  }
  return "다시 올릴 누락 기록이 없습니다.";
}

export function storageErrorForDisplay(_error: string | undefined, fallback: string): string {
  const message = _error?.trim();
  if (!message) return fallback;
  const hasInternalDetail =
    /(?:OneDrive|[A-Za-z]:[\\/]|\\\\|(?:^|[\s"'(])\/(?!\/)[^\s"'<>]+(?:\/[^\s"'<>]*)+|https?:\/\/|\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?\b|\b(?:ENOENT|EACCES|EPERM|ENOTFOUND|ECONNREFUSED|ETIMEDOUT)\b|\b(?:HTTP\s*)?[45]\d{2}(?:\s+[A-Za-z][A-Za-z ]+)?\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\.(?:json|csv|log|txt)\b|(?:^|\n)\s*at\s+\S+)/i.test(message);
  return hasInternalDetail ? fallback : message;
}

type StorageAccessValidationActions = {
  validateReadable(): Promise<{ ok: boolean }>;
  validateWritable(): Promise<{ ok: boolean; data?: AppConfig }>;
};

export async function validateStorageAccessForRole(
  role: PcRole,
  actions: StorageAccessValidationActions
): Promise<{ ok: boolean; mode: "read_only" | "write_probe"; data?: AppConfig }> {
  if (role === "leaderboard") {
    const result = await actions.validateReadable();
    return { ok: result.ok, mode: "read_only" };
  }
  const result = await actions.validateWritable();
  return { ok: result.ok, mode: "write_probe", data: result.data };
}

export function buildStorageSettingsPatch(form: StorageSettingsForm, role: PcRole, isPractice: boolean) {
  return {
    syncMode: "onedrive_manual" as const,
    pcRole: role,
    pcId: normalizePcId(form.pcId, role),
    oneDriveRoot: form.oneDriveRoot.trim(),
    recordBaseFolderName: form.recordBaseFolderName.trim() || DEFAULT_RECORD_BASE_FOLDER,
    dayNo: Number(form.dayNo) || 1,
    roundNo: Number(form.roundNo) || 1,
    isPracticeSession: isPractice
  };
}

function roleLabel(role: PcRole): string {
  return role === "leaderboard" ? "리더보드" : "플레이어";
}

function geumcheonSessionLabel(deviceProfile: DeviceProfile | undefined, sessionKind: SessionKind | undefined): string {
  if (sessionKind === "practice") return "연습회차";
  const official = deviceProfile?.sessions.official;
  return official ? `공식 ${official.dayNo}일차 ${official.roundNo}회차` : "공식회차";
}

function GeumcheonNasStatusPanel({
  role,
  deviceProfile,
  sessionKind,
  gameMode = "ai_challenge"
}: Pick<Props, "role" | "deviceProfile" | "sessionKind" | "gameMode">) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [validated, setValidated] = useState(false);
  const deviceMatches =
    deviceProfile?.eventProfileId === "geumcheon-2026" &&
    deviceProfile.role === role;
  const sessionLabel = geumcheonSessionLabel(deviceProfile, sessionKind);

  async function validateConnection() {
    if (!deviceMatches || !sessionKind) {
      setValidated(false);
      setMessage("이 실행 파일의 장치 프로필·역할·세션이 일치하지 않습니다. 배포 설정을 확인해 주세요.");
      return;
    }

    setBusy(true);
    if (role === "leaderboard") {
      const result = await window.typingKing.listRecords();
      setBusy(false);
      setValidated(result.ok);
      setMessage(
        result.ok
          ? `중앙 기록 API 연결, ${deviceProfile.deviceId} 조회 전용 역할, ${sessionLabel} 세션을 확인했습니다.`
          : storageErrorForDisplay(
              result.error,
              "중앙 기록 API를 조회할 수 없습니다. 조회 전용 장치 인증과 연결 상태를 확인해 주세요."
            )
      );
      return;
    }

    const result = await window.typingKing.checkGameStartReadiness(gameMode);
    const ready = Boolean(result.ok && result.data?.ready);
    setBusy(false);
    setValidated(ready);
    setMessage(
      ready
        ? `중앙 기록 API 연결, ${deviceProfile.deviceId} 기록 제출 역할, ${sessionLabel} 세션을 확인했습니다.`
        : storageErrorForDisplay(
            result.data?.message || result.error,
            "중앙 기록 API를 확인할 수 없습니다. 기록 제출 장치 인증과 연결 상태를 확인해 주세요."
          )
    );
  }

  return (
    <section className="onedrive-settings-panel geumcheon-nas-status-panel">
      <div className="onedrive-settings-title">
        <div>
          <p className="eyebrow">중앙 기록 API</p>
          <h3>연결·장치 역할·세션 검증</h3>
          <p className="app-role-summary">
            현재 앱: {roleLabel(role)} / 장치 ID: {deviceProfile?.deviceId || "미설정"} / {sessionLabel}
          </p>
        </div>
        <span className={validated ? "setup-state ready" : "setup-state pending"}>
          {validated ? "API 연결 확인" : "연결 검증 필요"}
        </span>
      </div>

      <div className="session-preview">
        <span>프로비저닝 상태</span>
        <strong>{deviceMatches ? "행사 전용 장치 프로필 적용" : "장치 프로필 확인 필요"}</strong>
        <small>
          {role === "leaderboard"
            ? "LEADERBOARD01 조회 전용 권한으로 현재 세션 기록을 확인합니다."
            : "PC01~PC10 기록 제출 전용 권한으로 현재 세션을 확인합니다."}
        </small>
      </div>

      <p className="settings-helper">
        서버 주소와 인증 정보는 배포 시 고정되며 이 화면에서 변경하거나 표시하지 않습니다.
      </p>
      <div className="button-row">
        <button className="primary-button" onClick={validateConnection} disabled={busy}>
          연결·장치 역할·세션 검증
        </button>
      </div>
      {message && <p className="notice-text">{message}</p>}
    </section>
  );
}

export function OneDriveSettingsPanel(props: Props) {
  if (props.eventProfileId === "geumcheon-2026") {
    return <GeumcheonNasStatusPanel {...props} />;
  }
  return <SkillUpOneDriveSettingsPanel {...props} />;
}

function SkillUpOneDriveSettingsPanel({ role, isPractice = false, onSettingsChange }: Props) {
  const [form, setForm] = useState<StorageSettingsForm>(() => toSkillUpForm());
  const [settings, setSettings] = useState<AppConfig | null>(null);
  const [message, setMessage] = useState("");
  const [queuedCount, setQueuedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const pcOptions = role === "leaderboard" ? SKILLUP_LEADERBOARD_PC_IDS : SKILLUP_PLAYER_PC_IDS;
  const currentPreview = useMemo(() => previewPath(form, isPractice), [form, isPractice]);
  const roleMismatch = Boolean(settings && settings.pcRole && settings.pcRole !== role);

  useEffect(() => {
    void load(true);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!busy) void load(!dirty);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [busy, dirty]);

  async function load(syncForm = true) {
    const result = await window.typingKing.getOneDriveSettings();
    if (result.ok && result.data) {
      setSettings(result.data);
      if (syncForm) setForm(toSkillUpForm(result.data));
      onSettingsChange?.(result.data);
    } else {
      setMessage(result.error || "OneDrive 기록 설정을 불러오지 못했습니다.");
    }
    if (role === "player") await refreshQueueCount();
  }

  async function refreshQueueCount() {
    const result = await window.typingKing.getQueuedRecordStatus();
    if (result.ok && result.data) setQueuedCount(result.data.count);
  }

  async function chooseRoot() {
    setBusy(true);
    const result = await window.typingKing.chooseOneDriveRoot();
    setBusy(false);
    if (result.ok && result.data) {
      setSettings(result.data);
      setForm(toSkillUpForm(result.data));
      setDirty(false);
      onSettingsChange?.(result.data);
      setMessage("OneDrive 루트 폴더를 선택했습니다.\n[폴더 생성 및 검증]을 먼저 실행해 주세요.");
    } else {
      setMessage(result.error || "OneDrive 루트 폴더가 선택되지 않았습니다.");
    }
  }

  async function saveOnly() {
    setBusy(true);
    const result = await window.typingKing.updateOneDriveSettings(toPatch());
    setBusy(false);
    if (result.ok && result.data) {
      setSettings(result.data);
      setForm(toSkillUpForm(result.data));
      setDirty(false);
      onSettingsChange?.(result.data);
      setMessage("설정을 저장했습니다.\n일차, 회차, 폴더명을 바꾼 경우 [폴더 생성 및 검증]을 다시 실행해 주세요.");
      if (role === "player") await refreshQueueCount();
    } else {
      setMessage(result.error || "설정 저장에 실패했습니다.");
    }
  }

  async function validateSetup() {
    setBusy(true);
    const saveResult = await window.typingKing.updateOneDriveSettings(toPatch());
    if (!saveResult.ok) {
      setBusy(false);
      setMessage(saveResult.error || "설정 저장에 실패했습니다.");
      return;
    }
    const result = await window.typingKing.validateOneDriveSetup();
    setBusy(false);
    if (result.ok && result.data) {
      setSettings(result.data);
      setForm(toSkillUpForm(result.data));
      setDirty(false);
      onSettingsChange?.(result.data);
      let nextMessage = "기록 폴더를 생성하고 검증했습니다.\n이제 기록 저장과 리더보드 집계가 가능합니다.";
      if (role === "player") {
        const flushResult = await window.typingKing.flushQueuedRecords();
        if (flushResult.ok && flushResult.data) {
          nextMessage += `\n${formatSkillUpQueuedRecordFlushMessage(flushResult.data)}`;
        }
        await refreshQueueCount();
      }
      setMessage(nextMessage);
    } else {
      setMessage(result.error || "기록 폴더를 생성할 수 없습니다.\nOneDrive 경로와 권한을 확인해 주세요.");
    }
  }

  async function flushQueued() {
    setBusy(true);
    const result = await window.typingKing.flushQueuedRecords();
    setBusy(false);
    if (result.ok && result.data) setMessage(formatSkillUpQueuedRecordFlushMessage(result.data));
    else {
      setMessage(
        result.error ||
          "기록 폴더에 다시 올리지 못했습니다.\nOneDrive 상태, 기록 폴더 설정, 디스크 권한을 확인해 주세요."
      );
    }
    await refreshQueueCount();
  }

  async function openFolder() {
    const result = await window.typingKing.openSessionFolder();
    setMessage(result.ok ? "기록 폴더를 열었습니다." : result.error || "기록 폴더를 열 수 없습니다.");
  }

  async function cleanupLegacyArtifacts() {
    const confirmed = window.confirm(
      "구버전이 만든 OneDrive 자동 로그와 동기화 보조 파일을 정리합니다.\n참가 기록 JSON, 관리자 조치, CSV 백업은 삭제하지 않습니다.\n\n새 버전 프로그램을 모든 PC에 교체한 뒤 실행해 주세요. 계속하시겠습니까?"
    );
    if (!confirmed) return;
    setBusy(true);
    const result = await window.typingKing.cleanupLegacyOneDriveArtifacts();
    setBusy(false);
    if (result.ok && result.data) {
      const megabytes = result.data.deletedBytes / 1024 / 1024;
      setMessage(
        `OneDrive 불필요 파일 ${result.data.deletedFileCount}개를 정리했습니다. ` +
          `(약 ${megabytes.toFixed(2)}MB)\n` +
          (result.data.failedFileCount > 0
            ? `정리하지 못한 파일 ${result.data.failedFileCount}개가 있습니다. OneDrive 동기화 후 다시 시도해 주세요.`
            : "참가 기록 JSON과 CSV 백업은 그대로 유지했습니다.")
      );
    } else {
      setMessage(result.error || "OneDrive 불필요 파일 정리에 실패했습니다. OneDrive 상태와 폴더 권한을 확인해 주세요.");
    }
  }

  function toPatch() {
    return {
      syncMode: "onedrive_manual" as const,
      pcRole: role,
      pcId: form.pcId.trim() || pcOptions[0],
      oneDriveRoot: form.oneDriveRoot.trim(),
      recordBaseFolderName: form.recordBaseFolderName.trim() || DEFAULT_RECORD_BASE_FOLDER,
      dayNo: Number(form.dayNo) || 1,
      roundNo: Number(form.roundNo) || 1,
      isPracticeSession: false
    };
  }

  function updateForm(patch: Partial<StorageSettingsForm>) {
    setDirty(true);
    setForm((current) => ({ ...current, ...patch }));
  }

  return (
    <section className="onedrive-settings-panel">
      <div className="onedrive-settings-title">
        <div>
          <p className="eyebrow">OneDrive 기록 설정</p>
          <h3>{isPractice ? "연습 기록 폴더" : "일차·회차 기록 폴더"}</h3>
          <p className="app-role-summary">
            현재 앱: {roleLabel(role)} / PC ID: {form.pcId || "-"} / {isPractice ? "연습회차" : `${form.dayNo || 1}일차 ${form.roundNo || 1}회차`}
          </p>
        </div>
        <span className={settings?.setupComplete ? "setup-state ready" : "setup-state pending"}>
          {settings?.setupComplete ? "폴더 준비 완료" : "검증 필요"}
        </span>
      </div>

      {roleMismatch && (
        <p className="role-warning">
          현재 실행 파일 역할과 저장된 PC 역할이 다릅니다. 이 화면에서 설정 저장을 누르면 현재 실행 파일 역할로 다시 저장됩니다.
        </p>
      )}

      <div className="onedrive-settings-grid">
        <label className="field wide-field">
          <span>OneDrive 루트 폴더</span>
          <div className="path-picker">
            <input
              value={form.oneDriveRoot}
              onChange={(event) => updateForm({ oneDriveRoot: event.target.value })}
              placeholder="예: C:\\Users\\사용자\\OneDrive - 더피엠디"
            />
            <button type="button" className="secondary-button" onClick={chooseRoot} disabled={busy}>
              폴더 선택
            </button>
          </div>
        </label>

        <label className="field">
          <span>기록 기본 폴더명</span>
          <input
            value={form.recordBaseFolderName}
            onChange={(event) => updateForm({ recordBaseFolderName: event.target.value })}
          />
        </label>

        {isPractice && (
          <p className="practice-mode-note">
            연습모드는 일차·회차와 무관하게 [기록 기본 폴더명\연습회차] 폴더를 사용합니다.
          </p>
        )}

        {!isPractice && (
          <label className="field">
            <span>일차</span>
            <input
              inputMode="numeric"
              value={form.dayNo}
              onChange={(event) => updateForm({ dayNo: cleanNumber(event.target.value) })}
            />
          </label>
        )}

        {!isPractice && (
          <label className="field">
            <span>회차</span>
            <input
              inputMode="numeric"
              value={form.roundNo}
              onChange={(event) => updateForm({ roundNo: cleanNumber(event.target.value) })}
            />
          </label>
        )}

        <label className="field">
          <span>PC ID</span>
          <input
            list={`pc-id-options-${role}`}
            value={form.pcId}
            onChange={(event) => updateForm({ pcId: event.target.value.toUpperCase() })}
          />
          <datalist id={`pc-id-options-${role}`}>
            {pcOptions.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
      </div>

      <div className="session-preview">
        <span>자동 생성될 기록 폴더</span>
        <strong>{currentPreview}</strong>
        <small>하위 폴더: incoming\typing, incoming\ai, exports, logs, admin_actions</small>
      </div>

      <p className="settings-helper">
        PC ID는 테스트 PC별로 중복되지 않게 입력해 주세요. 예: 플레이어 PC01~PC06, 리더보드 PC07/PC08
      </p>
      <p className="onedrive-keep-note">
        OneDrive 기록저장 폴더는 우클릭 후 [항상 이 장치에 유지]를 선택하는 것을 권장합니다. 이 옵션은 파일을 해당 PC에 실제로 받아 두어 리더보드가 안정적으로 읽을 수 있게 합니다.
      </p>

      {role === "player" && (
        <div className="queue-recovery-box">
          <strong>누락 기록 {queuedCount}건</strong>
          <button className="secondary-button" type="button" onClick={flushQueued} disabled={busy || queuedCount === 0}>
            누락 기록 반영하기
          </button>
        </div>
      )}

      <div className="button-row">
        <button className="primary-button" onClick={validateSetup} disabled={busy}>
          폴더 생성 및 검증
        </button>
        <button className="secondary-button" onClick={saveOnly} disabled={busy}>
          설정 저장
        </button>
        <button className="secondary-button" onClick={openFolder} disabled={busy}>
          기록 폴더 열기
        </button>
      </div>
      {!isPractice && (
        <div className="button-row maintenance-row">
          <button className="secondary-button" onClick={cleanupLegacyArtifacts} disabled={busy || !settings?.setupComplete}>
            OneDrive 불필요 파일 정리
          </button>
          <small>참가 기록과 CSV는 유지하고, 구버전 자동 로그·동기화 보조 파일만 정리합니다.</small>
        </div>
      )}

      {settings?.setupValidatedAt && <p className="onedrive-hint">마지막 검증 시각: {settings.setupValidatedAt}</p>}
      {message && <p className="notice-text">{message}</p>}
    </section>
  );
}
