import fs from "node:fs";
import net from "node:net";
import { EncryptedNasOutbox } from "./nas/outbox";
import {createActiveAttemptStore} from "./activeAttemptStore";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateDeviceProfile } from "../shared/events/eventProfile";
import type { DeviceProfile } from "../shared/events/types";
import { isEncoded256BitToken, type SafeStorageAdapter } from "./nas/credentialStore";

export const DEPLOYMENT_PROFILE_VERSION = 2;
export type ProfileSession = { sessionId: string; dayNo: number; roundNo: number };
export type AdministratorVerifier = { algorithm: "scrypt"; salt: string; hash: string };
export type DeploymentCredential = { eventId: string; deviceId: string; apiBaseUrl: string; role: "writer" | "leaderboard"; token: string };
export type DeploymentProfileV2 = {
  schemaVersion: 2; deploymentId: string; environment: "production" | "test";
  issuedAt: string; notBefore: string; expiresAt: string; device: DeviceProfile;
  allowedSessions: ProfileSession[];
  credentials: { writer?: DeploymentCredential; leaderboard: DeploymentCredential };
  administrator: AdministratorVerifier;
};
function fail(code: string): never { throw new Error(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("PROFILE_FORMAT_INVALID");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join(",") !== keys.sort().join(",")) fail("PROFILE_FIELDS_INVALID");
}
export function originalProfileFileName(deviceId: string): string {
  if (deviceId === "LEADERBOARD01") return "leaderboard_01.device-profile.json";
  if (!/^PC0[1-4]$/.test(deviceId)) fail("PROFILE_DEVICE_INVALID");
  return `player_${deviceId.slice(2)}.device-profile.json`;
}
export function parseDeploymentProfile(value: unknown, options: { now?: Date; fileName?: string; allowInactive?: boolean } = {}): DeploymentProfileV2 {
  return validateDeploymentProfile(value,{now:options.now,fileName:options.fileName,allowInactive:options.allowInactive});
}
function validateDeploymentProfile(value: unknown, options: {now?:Date;fileName?:string;allowInactive?:boolean;recoveryInspection?:boolean}): DeploymentProfileV2 {
  const p = object(value);
  exact(p, ["schemaVersion","deploymentId","environment","issuedAt","notBefore","expiresAt","device","allowedSessions","credentials","administrator"]);
  if (p.schemaVersion !== 2 || typeof p.environment !== "string" || !["production","test"].includes(p.environment)) fail("PROFILE_VERSION_INVALID");
  if (typeof p.deploymentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(p.deploymentId)) fail("PROFILE_DEPLOYMENT_INVALID");
  let device: DeviceProfile;
  try { device = validateDeviceProfile(p.device); } catch { fail("PROFILE_DEVICE_INVALID"); }
  if (device.eventProfileId !== "geumcheon-2026" || device.sessions.practice !== undefined || !/^(PC0[1-4]|LEADERBOARD01)$/.test(device.deviceId)) fail("PROFILE_DEVICE_INVALID");
  if(device.requestTimeoutMs<100 || device.requestTimeoutMs>120000)fail("PROFILE_DEVICE_INVALID");
  if (options.fileName && options.fileName !== originalProfileFileName(device.deviceId)) fail("PROFILE_ORIGINAL_NAME_REQUIRED");
  const url = new URL(device.apiBaseUrl);
  if (p.environment === "production" ? device.apiBaseUrl !== "https://typingking.thepmd.synology.me" : !(device.apiBaseUrl === "https://typingking.thepmd.synology.me" || (url.hostname === "127.0.0.1" && url.pathname === "/"))) fail("PROFILE_API_ENDPOINT_INVALID");
  const now = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(now)) fail("PROFILE_TIME_INVALID");
  const times = ["issuedAt","notBefore","expiresAt"].map(k => {
    const v=p[k]; if(typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return NaN;
    const ms=Date.parse(v); return Number.isFinite(ms) && new Date(ms).toISOString()===v ? ms : NaN;
  });
  if (times.some(t => !Number.isFinite(t)) || times[0] >= times[2] || times[1] >= times[2] || times[0] > now + 300000) fail("PROFILE_TIME_INVALID");
  if (now >= times[2] && !options.recoveryInspection) fail("PROFILE_EXPIRED");
  if (!options.allowInactive && !options.recoveryInspection && now < times[1]) fail("PROFILE_NOT_ACTIVE");
  if (!Array.isArray(p.allowedSessions) || p.allowedSessions.length < 1 || p.allowedSessions.length > 1000) fail("PROFILE_SESSIONS_INVALID");
  const ids = new Set<string>(), pairs = new Set<string>();
  const allowedSessions = p.allowedSessions.map(value => {
    const s = object(value); exact(s, ["sessionId","dayNo","roundNo"]);
    if (typeof s.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(s.sessionId) || !Number.isSafeInteger(s.dayNo) || Number(s.dayNo) < 1 || !Number.isSafeInteger(s.roundNo) || Number(s.roundNo) < 1) fail("PROFILE_SESSIONS_INVALID");
    const pair = `${s.dayNo}:${s.roundNo}`;
    if (ids.has(s.sessionId) || pairs.has(pair)) fail("PROFILE_SESSIONS_INVALID");
    ids.add(s.sessionId); pairs.add(pair);
    return s as ProfileSession;
  });
  if (!allowedSessions.some(s => JSON.stringify(s) === JSON.stringify(device.sessions.official) || (s.sessionId === device.sessions.official.sessionId && s.dayNo === device.sessions.official.dayNo && s.roundNo === device.sessions.official.roundNo))) fail("PROFILE_SESSION_NOT_ALLOWED");
  const credentials = object(p.credentials);
  exact(credentials, device.role === "player" ? ["writer","leaderboard"] : ["leaderboard"]);
  for (const [role, value] of Object.entries(credentials)) {
    const c = object(value); exact(c, ["eventId","deviceId","apiBaseUrl","role","token"]);
    if (c.role !== role || c.eventId !== device.eventId || c.deviceId !== device.deviceId || c.apiBaseUrl !== device.apiBaseUrl || !isEncoded256BitToken(c.token)) fail("PROFILE_CREDENTIAL_BINDING_INVALID");
  }
  if (credentials.writer && object(credentials.writer).token === object(credentials.leaderboard).token) fail("PROFILE_CREDENTIAL_ROLE_REUSE");
  const administrator = object(p.administrator); exact(administrator, ["algorithm","salt","hash"]);
  if (administrator.algorithm !== "scrypt" || typeof administrator.salt !== "string" || !/^[a-f0-9]{32}$/.test(administrator.salt) || typeof administrator.hash !== "string" || !/^[a-f0-9]{128}$/.test(administrator.hash)) fail("PROFILE_ADMIN_VERIFIER_INVALID");
  const publicText=JSON.stringify({deploymentId:p.deploymentId,device,allowedSessions});
  if(Object.values(credentials).some(value=>publicText.includes(object(value).token as string)) || publicText.includes(administrator.hash as string))fail("PROFILE_FIELDS_INVALID");
  return { ...p, device, allowedSessions } as DeploymentProfileV2;
}
export function loadDeploymentProfile(filePath: string): DeploymentProfileV2 {
  let value: unknown;
  try {
    if (fs.statSync(filePath).size > 1024 * 1024) fail("PROFILE_TOO_LARGE");
    value = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) { if (error instanceof Error && error.message.startsWith("PROFILE_")) throw error; fail("PROFILE_JSON_INVALID"); }
  return parseDeploymentProfile(value, { fileName: path.basename(filePath) });
}
export function discoverDeploymentProfile(directory: string): { profile: DeploymentProfileV2; filePath: string } | undefined {
  if(!fs.existsSync(directory))return undefined;
  const names = fs.readdirSync(directory).filter(name => /\.device-profile\.json$/i.test(name));
  if (names.length > 1) fail("PROFILE_MULTIPLE_FILES");
  if (!names.length) return undefined;
  const filePath = path.join(directory, names[0]);
  return { profile: loadDeploymentProfile(filePath), filePath };
}
export function profileFingerprint(profile: DeploymentProfileV2): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}
export function profilePreview(profile: DeploymentProfileV2, filePath: string) {
  return { fileName: path.basename(filePath), deploymentId: profile.deploymentId, environment: profile.environment, deviceId: profile.device.deviceId, eventId: profile.device.eventId, apiBaseUrl: profile.device.apiBaseUrl, role: profile.device.role, session: profile.device.sessions.official, allowedSessions: profile.allowedSessions, expiresAt: profile.expiresAt };
}
/** Both EXEs consume one atomic DPAPI-protected envelope; secrets never enter renderer state. */
export class DeploymentProfileStore {
  private fingerprint?: string;
  constructor(private readonly filePath: string, private readonly safeStorage: SafeStorageAdapter) {}
  activate(profile: DeploymentProfileV2, replace = false): void {
    this.available(); parseDeploymentProfile(profile);
    const fingerprint = profileFingerprint(profile);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = this.filePath + "." + process.pid + "." + createHash("sha256").update(String(Math.random())).digest("hex").slice(0,12) + ".tmp";
    try {
      fs.writeFileSync(temporary, this.safeStorage.encryptString(JSON.stringify(profile)), {mode:0o600});
      if (replace) fs.renameSync(temporary, this.filePath);
      else {
        try { fs.linkSync(temporary, this.filePath); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (profileFingerprint(this.read()) !== fingerprint) fail("PROFILE_CACHE_CONFLICT");
        }
      }
      this.fingerprint = fingerprint;
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  read(): DeploymentProfileV2 { return parseDeploymentProfile(this.decryptValue()); }
  /** Inspection is only for authenticated renewal guards; it cannot provide runtime credentials. */
  inspectForRecovery(): DeploymentProfileV2 { return validateDeploymentProfile(this.decryptValue(),{recoveryInspection:true}); }
  private decryptValue(): unknown {
    this.available();
    try { return JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.filePath))); }
    catch { fail("PROFILE_CACHE_UNREADABLE"); }
  }
  assertLocalIdentity():void {
    if(this.fingerprint && profileFingerprint(this.inspectForRecovery())!==this.fingerprint)fail("PROFILE_CONFIGURATION_CHANGED");
  }
  assertCurrent(): void {
    if (this.fingerprint && profileFingerprint(this.read()) !== this.fingerprint) fail("PROFILE_CONFIGURATION_CHANGED");
  }
  token(role: "writer" | "leaderboard"): string {
    this.assertCurrent();
    const c = this.read().credentials[role];
    if (!c) fail("NAS_ROLE_FORBIDDEN");
    return c.token;
  }
  private available(): void { if (!this.safeStorage.isEncryptionAvailable()) fail("SAFE_STORAGE_UNAVAILABLE"); }
}

export type SavedDeploymentSelection = { profile: DeploymentProfileV2; folderFingerprint: string | null; selectedFilePath: string };
export function readDeploymentSelection(filePath: string, directory: string, storage: SafeStorageAdapter): SavedDeploymentSelection | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  if (!storage.isEncryptionAvailable()) fail("SAFE_STORAGE_UNAVAILABLE");
  let saved: SavedDeploymentSelection;
  try { saved = JSON.parse(storage.decryptString(fs.readFileSync(filePath))); } catch { fail("PROFILE_CACHE_UNREADABLE"); }
  const profile = parseDeploymentProfile(saved.profile);
  const current=deploymentFolderFingerprint(directory);
  if(current!==null && current!==saved.folderFingerprint) fail("PROFILE_CACHE_CONFLICT");
  if (typeof saved.selectedFilePath !== "string") fail("PROFILE_CACHE_UNREADABLE");
  if (fs.existsSync(saved.selectedFilePath) && profileFingerprint(loadDeploymentProfile(saved.selectedFilePath)) !== profileFingerprint(profile)) fail("PROFILE_CONFIGURATION_CHANGED");
  return {...saved,profile};
}
export function saveDeploymentSelection(filePath: string, directory: string, profile: DeploymentProfileV2, selectedFilePath: string, storage: SafeStorageAdapter): void {
  if (!storage.isEncryptionAvailable()) fail("SAFE_STORAGE_UNAVAILABLE");
  const value: SavedDeploymentSelection = {profile,folderFingerprint:deploymentFolderFingerprint(directory),selectedFilePath};
  fs.mkdirSync(path.dirname(filePath),{recursive:true});
  const tmp=filePath+"."+process.pid+".tmp";
  try { fs.writeFileSync(tmp,storage.encryptString(JSON.stringify(value)),{mode:0o600});fs.renameSync(tmp,filePath); }
  finally {if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}

const PROFILE_ERROR_MESSAGES: Record<string,string> = {
  "PROFILE_FILE_MISSING": "해당 PC의 원래 이름 프로필 하나를 EXE 옆에 배치해 주세요.",
  "PROFILE_MULTIPLE_FILES": "프로필이 여러 개 있습니다. 해당 PC의 원래 이름 프로필 하나만 EXE 옆에 남겨 주세요.",
  "PROFILE_ORIGINAL_NAME_REQUIRED": "프로필 파일 이름이 맞지 않습니다. 운영자가 발급한 원래 이름을 유지해 주세요.",
  "PROFILE_JSON_INVALID": "프로필 파일을 읽을 수 없습니다. 운영자가 발급한 원본으로 복구해 주세요.",
  "PROFILE_CACHE_UNREADABLE": "보호된 프로필을 읽을 수 없습니다. 관리자 복구에서 원본 프로필을 다시 적용해 주세요.",
  "PROFILE_CACHE_CONFLICT": "현재 폴더의 프로필과 저장된 설정이 다릅니다. 관리자 복구에서 적용할 프로필을 선택해 주세요.",
  "PROFILE_CONFIGURATION_CHANGED": "실행 중 프로필이 변경되었습니다. 진행 중 기록을 보존한 뒤 관리자에게 프로필 확인을 요청해 주세요.",
  "PROFILE_EXPIRED": "프로필 사용 기간이 만료되었습니다. 운영자가 발급한 유효한 프로필이 필요합니다.",
  "PROFILE_NOT_ACTIVE": "아직 프로필 사용 시작 시간이 아닙니다. 승인된 운영 시간을 확인해 주세요.",
  "PROFILE_TIME_INVALID": "프로필의 발급·사용 기간 정보가 올바르지 않습니다.",
  "PROFILE_SESSION_NOT_ALLOWED": "서버에 등록된 허용 일차·회차만 선택할 수 있습니다.",
  "PROFILE_APP_ALREADY_RUNNING": "같은 PC ID의 이 앱이 이미 실행 중입니다. 기존 창을 확인해 주세요.",
  "PROFILE_FORMAT_INVALID": "프로필 형식이 올바르지 않습니다.",
  "PROFILE_FIELDS_INVALID": "프로필 필수 항목 또는 지원하지 않는 항목이 있습니다.",
  "PROFILE_VERSION_INVALID": "지원하는 v4 프로필이 아닙니다.",
  "PROFILE_DEVICE_INVALID": "프로필의 행사·PC ID·역할이 올바르지 않습니다.",
  "PROFILE_API_ENDPOINT_INVALID": "승인된 기록 서버 주소가 아닌 프로필입니다.",
  "PROFILE_CREDENTIAL_BINDING_INVALID": "프로필 인증정보의 행사·PC·권한 연결이 일치하지 않습니다.",
  "PROFILE_CREDENTIAL_ROLE_REUSE": "기록 제출과 조회 인증정보가 분리되지 않은 프로필입니다.",
  "PROFILE_ADMIN_VERIFIER_INVALID": "프로필의 관리자 인증 설정이 올바르지 않습니다.",
  "PROFILE_PENDING_SCOPE_CHANGE":"미전송 기록이 있을 때는 장치·행사·서버·회차 범위를 유지한 인증 갱신만 적용할 수 있습니다.",
  "PROFILE_BUSY_RECORDS": "진행 중이거나 미전송 기록이 있어 변경할 수 없습니다. 경기 종료와 전송 완료 후 다시 시도해 주세요.",
  "PROFILE_OTHER_APP_RUNNING": "이 PC의 다른 게임·리더보드를 종료한 뒤 프로필을 교체해 주세요.",
  "PROFILE_SESSION_INPUT_INVALID": "일차와 회차는 1 이상의 정수로 입력해 주세요.",
  "PROFILE_CANDIDATE_MISSING": "먼저 프로필을 선택해 주세요.",
  "PROFILE_CANDIDATE_CHANGED": "선택 후 프로필이 변경되었습니다. 다시 선택해 주세요.",
  "PROFILE_GAME_ROLE_INVALID": "조회 전용 프로필은 게임에 적용할 수 없습니다.",
  "PROFILE_MANAGEMENT_UNAVAILABLE": "현재 환경에서는 운영 프로필을 관리할 수 없습니다.",
  "SAFE_STORAGE_UNAVAILABLE": "Windows의 보호된 저장소를 사용할 수 없습니다."
};
export function deploymentErrorForDisplay(error:unknown):string|undefined {return error instanceof Error ? PROFILE_ERROR_MESSAGES[error.message] : undefined;}

export function assertDeploymentReplacementSafe(runtimeRoots: string[], ownPid = process.pid): void {
  assertDeploymentFilesSafe(runtimeRoots,ownPid,false);
}
function assertDeploymentFilesSafe(runtimeRoots:string[],ownPid:number,allowPending:boolean,allowColdCheckpoint=false):void {
  for(const root of new Set(runtimeRoots)) {
    const nas=path.join(root,"nas");
    if(!allowColdCheckpoint && ["official","practice"].some(kind=>fs.existsSync(path.join(nas,`active-attempt-${kind}.bin`)))) fail("PROFILE_BUSY_RECORDS");
    function hasFiles(directory:string):boolean {return fs.existsSync(directory) && fs.readdirSync(directory,{withFileTypes:true}).some(e=>e.isDirectory()?hasFiles(path.join(directory,e.name)):e.isFile());}
    if(!allowPending && hasFiles(path.join(nas,"outbox"))) fail("PROFILE_BUSY_RECORDS");
    const leases=path.join(nas,"app-leases");
    if(!fs.existsSync(leases))continue;
    for(const name of fs.readdirSync(leases)) {
      const pid=Number(fs.readFileSync(path.join(leases,name),"utf8"));
      if(!Number.isSafeInteger(pid) || pid<=0) fail("PROFILE_OTHER_APP_RUNNING");
      if(pid===ownPid)continue;
      try {process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")continue;throw error;}
      fail("PROFILE_OTHER_APP_RUNNING");
    }
  }
}
function deploymentFolderFingerprint(directory:string):string|null {
  if(!fs.existsSync(directory))return null;
  const names=fs.readdirSync(directory).filter(name=>/\.device-profile\.json$/i.test(name)).sort();
  if(!names.length)return null;
  return createHash("sha256").update(JSON.stringify(names.map(name=>[name,createHash("sha256").update(fs.readFileSync(path.join(directory,name))).digest("hex")]))).digest("hex");
}

export async function withDeploymentLocks<T>(roots: string[], action:()=>Promise<T>):Promise<T> {
  const servers: import("node:net").Server[]=[];
  try {
    for(const root of [...new Set(roots.map(root=>path.resolve(root)))].sort()) {
      const name=createHash("sha256").update(root).digest("hex");
      const address=process.platform==="win32" ? String.raw`\\.\pipe\typingking-v4-profile-`+name : path.join(root,"profile-mutation.sock");
      let acquired=false;
      for(let attempt=0;attempt<100 && !acquired;attempt++) {
        const server=net.createServer(socket=>socket.end());
        acquired=await new Promise<boolean>((resolve,reject)=>{server.once("error",(error:NodeJS.ErrnoException)=>error.code==="EADDRINUSE"?resolve(false):reject(error));server.listen(address,()=>resolve(true));});
        if(acquired)servers.push(server);else await new Promise(resolve=>setTimeout(resolve,25));
      }
      if(!acquired)fail("PROFILE_ACTIVATION_BUSY");
    }
    return await action();
  } finally {await Promise.all(servers.map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));}
}
export function replaceDeploymentSelection(targetPath:string,selectionPath:string,directory:string,profile:DeploymentProfileV2,selectedFilePath:string,storage:SafeStorageAdapter):void {
  const oldTarget=fs.existsSync(targetPath)?fs.readFileSync(targetPath):undefined;
  const oldSelection=fs.existsSync(selectionPath)?fs.readFileSync(selectionPath):undefined;
  try {
    new DeploymentProfileStore(targetPath,storage).activate(profile,true);
    saveDeploymentSelection(selectionPath,directory,profile,selectedFilePath,storage);
  } catch(error) {
    for(const [file,previous] of [[targetPath,oldTarget],[selectionPath,oldSelection]] as const) {
      if(previous===undefined){if(fs.existsSync(file))fs.unlinkSync(file);}
      else {const tmp=file+"."+process.pid+".rollback";fs.writeFileSync(tmp,previous,{mode:0o600});fs.renameSync(tmp,file);}
    }
    throw error;
  }
}

/** Must run under withDeploymentLocks after administrator authentication. Never rewrites an outbox. */
export async function assertSafeDeploymentApplication(options:{
  currentRuntimeRoot:string;targetRuntimeRoot:string;replacement:DeploymentProfileV2;safeStorage:SafeStorageAdapter;ownPid?:number;coldRecovery?:boolean;
}):Promise<"replacement"|"credential-renewal"> {
  const replacement=parseDeploymentProfile(options.replacement);
  const roots=[options.currentRuntimeRoot,options.targetRuntimeRoot],ownPid=options.ownPid??process.pid;
  const checkpointPath=path.join(options.currentRuntimeRoot,"nas","active-attempt-official.bin");
  const hasCheckpoint=fs.existsSync(checkpointPath);
  assertDeploymentFilesSafe(roots,options.coldRecovery?-1:ownPid,true,options.coldRecovery===true); // cold recovery permits preserved data only when no executable lease is live
  if(fs.existsSync(path.join(options.currentRuntimeRoot,"nas","active-attempt-practice.bin")))fail("PROFILE_PENDING_SCOPE_CHANGE");
  let pending=false;
  try {assertDeploymentReplacementSafe(roots,ownPid);}catch(error){if(!(error instanceof Error)||error.message!=="PROFILE_BUSY_RECORDS")throw error;pending=true;}
  if(!pending && !hasCheckpoint)return "replacement";
  if(path.resolve(options.currentRuntimeRoot)!==path.resolve(options.targetRuntimeRoot))fail("PROFILE_PENDING_SCOPE_CHANGE");
  const previous=new DeploymentProfileStore(path.join(options.currentRuntimeRoot,"nas","deployment-profile.bin"),options.safeStorage).inspectForRecovery();
  const sessionKey=(s:ProfileSession)=>`${s.sessionId}|${s.dayNo}|${s.roundNo}`;
  if(JSON.stringify(previous.device)!==JSON.stringify(replacement.device)
    || previous.environment!==replacement.environment
    || previous.allowedSessions.map(sessionKey).sort().join("\n")!==replacement.allowedSessions.map(sessionKey).sort().join("\n")) fail("PROFILE_PENDING_SCOPE_CHANGE");
  if(hasCheckpoint) {
    if(!options.coldRecovery)fail("PROFILE_BUSY_RECORDS");
    const checkpoint=await createActiveAttemptStore({checkpointPath,encryption:options.safeStorage,eventProfileId:previous.device.eventProfileId}).read();
    if(!checkpoint || checkpoint.variant!=="ai" || !checkpoint.recordId.startsWith(`gsc26-${replacement.device.deviceId.toLowerCase()}-`))fail("PROFILE_PENDING_SCOPE_CHANGE");
    const sessionPath=path.join(options.currentRuntimeRoot,"nas","session-ai.json");
    let currentSession:ProfileSession=previous.device.sessions.official;
    if(fs.existsSync(sessionPath)){try{currentSession=JSON.parse(fs.readFileSync(sessionPath,"utf8"));}catch{fail("PROFILE_PENDING_SCOPE_CHANGE");}}
    if(!previous.allowedSessions.some(s=>sessionKey(s)===sessionKey(currentSession)) || !replacement.allowedSessions.some(s=>sessionKey(s)===sessionKey(currentSession)))fail("PROFILE_PENDING_SCOPE_CHANGE");
  }
  const outboxRoot=path.join(options.currentRuntimeRoot,"nas","outbox");
  const outbox=new EncryptedNasOutbox({rootDir:outboxRoot,safeStorage:options.safeStorage});
  const [official,blocked,practice,practiceBlocked]=await Promise.all([outbox.list("official"),outbox.listBlocked("official"),outbox.list("practice"),outbox.listBlocked("practice")]);
  if(practice.length||practiceBlocked.length)fail("PROFILE_PENDING_SCOPE_CHANGE");
  const items=[...official,...blocked],allowed=new Set(replacement.allowedSessions.map(sessionKey));
  const actualFiles:string[]=[];
  function collect(dir:string):void {if(fs.existsSync(dir))for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())collect(p);else actualFiles.push(p);}}
  collect(outboxRoot);
  if((!items.length && !hasCheckpoint) || actualFiles.length!==items.length)fail("PROFILE_PENDING_SCOPE_CHANGE");
  for(const item of items) {
    const envelope=item.envelope,session=envelope?.session;
    if(envelope?.schema_version!==1||envelope.event_id!==replacement.device.eventId||session?.kind!=="official"
      || !allowed.has(sessionKey({sessionId:session.session_id,dayNo:session.day_no,roundNo:session.round_no}))
      || envelope.row?.record_id!==item.recordId || !item.recordId.startsWith(`gsc26-${replacement.device.deviceId.toLowerCase()}-`)) fail("PROFILE_PENDING_SCOPE_CHANGE");
  }
  return "credential-renewal";
}
