/**
 * Operator-only local issuer. Never executed on rental PCs; never contacts NAS,
 * generates operating tokens, or changes an existing token manifest.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDeploymentProfile, inspectDeploymentProfileForRenewal, originalProfileFileName, type DeploymentProfileV2 } from '../electron/deploymentProfile';
import { writeZip } from './r7-package-release';
import { verifyZipAgainstManifest } from './rental-v4-package-release';

const EVENT = 'geumcheon-science-festival-2026';
const DEVICES = ['PC01','PC02','PC03','PC04','LEADERBOARD01'] as const;
type Stage = 'synthetic' | 'test' | 'production';
type Session = { sessionId:string; dayNo:number; roundNo:number };
type ExistingToken = { tokenId:string; tokenHash:string; deviceId:string; role:'writer'|'leaderboard'|'operator';
  allowedSessions:string[]; expiresAt:string; revokedAt:string|null };
export type RentalIssuanceInput = {
  stage:Stage; deploymentId:string; apiBaseUrl:string; issuedAt:string; notBefore:string; expiresAt:string;
  defaultSessionId:string; approvalReference?:string;
  eventConfig:unknown; tokenManifest:unknown;
  keys:Array<{tokenId:string;token:string}>;
  administratorPassword:string;
  renewalProfiles?:Array<{fileName:string;profile:unknown}>;
};
function fail(code:string):never { throw new Error(code); }
const sha=(text:string|Buffer)=>crypto.createHash('sha256').update(text).digest('hex');
function record(value:unknown,required:string[],optional:string[]=[],code='INPUT'):Record<string,any>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail(code+'_INVALID');
  const r=value as Record<string,unknown>;
  if(required.some(k=>!(k in r))||Object.keys(r).some(k=>!required.includes(k)&&!optional.includes(k)))fail(code+'_FIELDS');
  return r;
}
function iso(value:unknown,code:string):number{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))fail(code);
  return Date.parse(value);
}
function id(value:unknown,code:string):string{
  if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)||/__[A-Z0-9_]+__/.test(value))fail(code);
  return value;
}
function parseServerInputs(input:RentalIssuanceInput){
  const event=record(input.eventConfig,['schemaVersion','eventId','recordBaseFolderName','stageTextCatalogPath','allowedSessions','aiRanges'],[],'EVENT');
  const manifest=record(input.tokenManifest,['manifestVersion','eventId','tokens'],[],'TOKEN_MANIFEST');
  if(event.schemaVersion!==1||event.eventId!==EVENT||event.recordBaseFolderName!=='기록저장'||manifest.manifestVersion!==1||manifest.eventId!==EVENT)fail('EVENT_MISMATCH');
  if(typeof event.stageTextCatalogPath!=='string'||!(path.isAbsolute(event.stageTextCatalogPath)||path.posix.isAbsolute(event.stageTextCatalogPath))||/__.*__/.test(event.stageTextCatalogPath))fail('EVENT_CATALOG_INVALID');
  const allowed=record(event.allowedSessions,['official'],['practice'],'SESSION');
  if(!Array.isArray(allowed.official)||!allowed.official.length||allowed.official.length>1000)fail('SESSION_INVALID');
  const sessions:Session[]=allowed.official.map((s:unknown)=>{
    const v=record(s,['sessionId','dayNo','roundNo'],[],'SESSION');
    id(v.sessionId,'SESSION_INVALID');
    if(!Number.isSafeInteger(v.dayNo)||v.dayNo<1||!Number.isSafeInteger(v.roundNo)||v.roundNo<1)fail('SESSION_INVALID');
    return {sessionId:v.sessionId,dayNo:v.dayNo,roundNo:v.roundNo};
  });
  if(new Set(sessions.map(s=>s.sessionId)).size!==sessions.length||new Set(sessions.map(s=>s.dayNo+':'+s.roundNo)).size!==sessions.length)fail('SESSION_DUPLICATE');
  if(allowed.practice!==undefined){
    const practice=record(allowed.practice,['sessionId'],[],'SESSION');
    id(practice.sessionId,'SESSION_INVALID');
    if(sessions.some(s=>s.sessionId===practice.sessionId))fail('SESSION_DUPLICATE');
  }
  const ranges=record(event.aiRanges,['official','practice'],[],'AI_RANGES');
  for(const kind of ['official','practice'])if(JSON.stringify(ranges[kind])!==JSON.stringify([[100,125],[125,150],[150,200]]))fail('AI_RANGES_INVALID');
  if(!Array.isArray(manifest.tokens)||!manifest.tokens.length)fail('CREDENTIAL_LIST_INVALID');
  const tokens:ExistingToken[]=manifest.tokens.map((entry:unknown)=>{
    const t=record(entry,['tokenId','tokenHash','deviceId','role','allowedSessions','expiresAt','revokedAt'],[],'CREDENTIAL');
    id(t.tokenId,'CREDENTIAL_ID_INVALID');id(t.deviceId,'CREDENTIAL_DEVICE_INVALID');
    if(typeof t.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(t.tokenHash))fail('CREDENTIAL_HASH_INVALID');
    if(!['writer','leaderboard','operator'].includes(t.role)||!Array.isArray(t.allowedSessions)||!t.allowedSessions.length||
      t.allowedSessions.some((k:unknown)=>k!=='official'&&k!=='practice')||new Set(t.allowedSessions).size!==t.allowedSessions.length)fail('CREDENTIAL_SCOPE_INVALID');
    iso(t.expiresAt,'CREDENTIAL_EXPIRY_INVALID');if(t.revokedAt!==null)iso(t.revokedAt,'CREDENTIAL_REVOCATION_INVALID');
    return t as ExistingToken;
  });
  if(new Set(tokens.map(t=>t.tokenId)).size!==tokens.length||new Set(tokens.map(t=>t.tokenHash)).size!==tokens.length)fail('CREDENTIAL_DUPLICATE');
  return {sessions,tokens};
}
function validatedRenewalProfiles(input:RentalIssuanceInput,now:Date){
  if(input.renewalProfiles===undefined)return undefined;
  if(!Array.isArray(input.renewalProfiles)||input.renewalProfiles.length!==DEVICES.length)fail('RENEWAL_PROFILE_SET_INVALID');
  const previous=new Map<string,DeploymentProfileV2>();
  for(const entry of input.renewalProfiles){
    const item=record(entry,['fileName','profile'],[],'RENEWAL_PROFILE');
    if(typeof item.fileName!=='string')fail('RENEWAL_PROFILE_NAME_INVALID');
    const profile=inspectDeploymentProfileForRenewal(item.profile,{now,fileName:item.fileName});
    if(!DEVICES.includes(profile.device.deviceId as typeof DEVICES[number])||previous.has(profile.device.deviceId))fail('RENEWAL_PROFILE_SET_INVALID');
    const actual=crypto.scryptSync(input.administratorPassword,Buffer.from(profile.administrator.salt,'hex'),64);
    if(!crypto.timingSafeEqual(actual,Buffer.from(profile.administrator.hash,'hex')))fail('RENEWAL_ADMINISTRATOR_INVALID');
    previous.set(profile.device.deviceId,profile);
  }
  if(DEVICES.some(deviceId=>!previous.has(deviceId)))fail('RENEWAL_PROFILE_SET_INVALID');
  if(Date.parse(input.notBefore)>now.getTime())fail('RENEWAL_PROFILE_NOT_ACTIVE');
  return previous;
}
export function buildRentalProfiles(input:RentalIssuanceInput,{now=new Date()}:{now?:Date}={}){
  record(input,['stage','deploymentId','apiBaseUrl','issuedAt','notBefore','expiresAt','defaultSessionId','eventConfig','tokenManifest','keys','administratorPassword'],['approvalReference','renewalProfiles']);
  if(!['synthetic','test','production'].includes(input.stage))fail('STAGE_INVALID');
  if(input.stage!=='synthetic'&&(typeof input.approvalReference!=='string'||input.approvalReference.trim().length<8))fail('APPROVAL_REQUIRED');
  if(input.stage==='production'&&input.apiBaseUrl!=='https://typingking.thepmd.synology.me')fail('PRODUCTION_ENDPOINT_INVALID');
  if(input.stage==='synthetic'&&!/^https:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(input.apiBaseUrl))fail('SYNTHETIC_ENDPOINT_INVALID');
  id(input.deploymentId,'DEPLOYMENT_ID_INVALID');
  const expiry=iso(input.expiresAt,'EXPIRY_INVALID');
  if(expiry<=now.getTime()||iso(input.notBefore,'NOT_BEFORE_INVALID')>=expiry||iso(input.issuedAt,'ISSUED_AT_INVALID')>=expiry)fail('PROFILE_TIME_INVALID');
  const password=input.administratorPassword;
  if(typeof password!=='string'||password.length<16||password.length>256||!/[a-z]/.test(password)||!/[A-Z]/.test(password)||!/[0-9]/.test(password)||
    /password|changeme|placeholder|__.+__/i.test(password))fail('ADMINISTRATOR_PASSWORD_WEAK');
  const {sessions,tokens}=parseServerInputs(input);
  const selected=sessions.find(s=>s.sessionId===input.defaultSessionId);
  if(!selected)fail('DEFAULT_SESSION_INVALID');
  if(!Array.isArray(input.keys))fail('KEY_LIST_INVALID');
  const keyMap=new Map<string,string>();
  for(const entry of input.keys){
    const k=record(entry,['tokenId','token'],[],'KEY');
    id(k.tokenId,'KEY_ID_INVALID');
    if(keyMap.has(k.tokenId))fail('KEY_DUPLICATE');
    if(typeof k.token!=='string'||k.token.length<32||k.token.length>2048||!/^[-A-Za-z0-9_+/=]+$/.test(k.token)||
      /placeholder|changeme|example|__.+__/i.test(k.token)||new Set(k.token).size<12)fail('KEY_INVALID');
    keyMap.set(k.tokenId,k.token);
  }
  const renewalProfiles=validatedRenewalProfiles(input,now);
  const selectedKeys=new Set<string>();
  const profiles=DEVICES.map(deviceId=>{
    const credential=(role:'writer'|'leaderboard')=>{
      const candidates=tokens.filter(t=>t.deviceId===deviceId&&t.role===role&&t.revokedAt===null&&Date.parse(t.expiresAt)>now.getTime());
      if(candidates.length!==1)fail('CREDENTIAL_BINDING_INVALID');
      const existing=candidates[0]!;
      if(existing.allowedSessions.length!==1||existing.allowedSessions[0]!=='official')fail('CREDENTIAL_SCOPE_INVALID');
      if(Date.parse(existing.expiresAt)<expiry)fail('CREDENTIAL_EXPIRY_TOO_SHORT');
      const token=keyMap.get(existing.tokenId);
      if(token===undefined)fail('KEY_MISSING');
      if(sha(token)!==existing.tokenHash)fail('KEY_HASH_MISMATCH');
      selectedKeys.add(existing.tokenId);
      return {eventId:EVENT,deviceId,apiBaseUrl:input.apiBaseUrl,role,token};
    };
    const previous=renewalProfiles?.get(deviceId);
    const salt=previous?.administrator.salt??crypto.randomBytes(16).toString('hex');
    const fileName=originalProfileFileName(deviceId);
    const profile=parseDeploymentProfile({
      schemaVersion:2,deploymentId:input.deploymentId,issuedAt:input.issuedAt,notBefore:input.notBefore,expiresAt:input.expiresAt,
      environment:input.stage==='production'?'production':'test',
      device:{schemaVersion:1,eventProfileId:'geumcheon-2026',eventId:EVENT,deviceId,
        role:deviceId==='LEADERBOARD01'?'leaderboard':'player',apiBaseUrl:input.apiBaseUrl,
        sessions:{official:{...selected}},requestTimeoutMs:5000,retry:{initialDelayMs:1000,maxDelayMs:30000}},
      allowedSessions:sessions,
      credentials:{leaderboard:credential('leaderboard'),...(deviceId==='LEADERBOARD01'?{}:{writer:credential('writer')})},
      administrator:previous?{...previous.administrator}:{algorithm:'scrypt',salt,hash:crypto.scryptSync(password,Buffer.from(salt,'hex'),64).toString('hex')}
    },{now,fileName,allowInactive:true});
    if(previous){
      const sessionKeys=(values:Session[])=>values.map(s=>s.sessionId+'|'+s.dayNo+'|'+s.roundNo).sort().join('\n');
      if(previous.environment!==profile.environment||JSON.stringify(previous.device)!==JSON.stringify(profile.device)
        ||sessionKeys(previous.allowedSessions)!==sessionKeys(profile.allowedSessions))fail('RENEWAL_SCOPE_CHANGE');
      profile.device=previous.device;
      profile.allowedSessions=previous.allowedSessions;
    }
    return {fileName,profile};
  });
  if([...keyMap.keys()].some(k=>!selectedKeys.has(k)))fail('KEY_OUTSIDE_BATCH');
  const receipt={
    schemaVersion:1,stage:input.stage.toUpperCase(),deploymentId:input.deploymentId,issuedAt:input.issuedAt,
    notBefore:input.notBefore,expiresAt:input.expiresAt,eventId:EVENT,apiBaseUrl:input.apiBaseUrl,
    allowedSessions:sessions,defaultSessionId:input.defaultSessionId,
    profileSchemaVersion:2,credentialProvenance:'EXISTING_LOCAL_SERVER_MANIFEST_SHA256_MATCH',
    serverAuthorizationVerified:'LOCAL_CONFIG_ONLY_ACTUAL_NAS_NOT_RUN',
    productionRelease:'HOLD',actualNas:'NOT_RUN',
    files:profiles.map(({fileName,profile})=>({fileName,deviceId:profile.device.deviceId,
      capabilities:profile.credentials.writer?['writer','leaderboard']:['leaderboard']}))
  };
  const privateValues=[
    ...input.keys.map(k=>k.token),password,
    ...tokens.map(t=>t.tokenHash),
    ...profiles.flatMap(({profile})=>[profile.administrator.salt,profile.administrator.hash]),
    ...[...(renewalProfiles?.values()??[])].flatMap(profile=>Object.values(profile.credentials).map(credential=>credential.token))
  ];
  const assertPublic=(value:unknown):void=>{
    if(typeof value==='string'){
      if(privateValues.some(secret=>value.includes(secret)))fail('PUBLIC_RECEIPT_SECRET_MATCH');
    }else if(Array.isArray(value))value.forEach(assertPublic);
    else if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){assertPublic(key);assertPublic(item);}
  };
  assertPublic(receipt);

  return {profiles,receipt};
}
export function assertPrivateLocalPath(value:string):string{
  if(typeof value!=='string'||!path.isAbsolute(value)||/^\\\\|^\/\/|^[A-Za-z]:[\\/][\\/]/.test(value)||
    value.split(/[\\/]+/).some(p=>p==='..'||/^(OneDrive(?: - .*)?|Dropbox|Google Drive|GoogleDrive|iCloudDrive)$/i.test(p)))fail('PRIVATE_LOCAL_PATH_INVALID');
  const resolved=path.resolve(value);
  const configuredSyncRoots=[process.env.OneDrive,process.env.OneDriveCommercial,process.env.OneDriveConsumer].filter((p):p is string=>!!p);
  if(configuredSyncRoots.some(p=>resolved.toLowerCase()===path.resolve(p).toLowerCase()||resolved.toLowerCase().startsWith(path.resolve(p).toLowerCase()+path.sep)))fail('PRIVATE_LOCAL_PATH_SYNC');
  if(process.platform==='win32'){
    const drive=path.parse(resolved).root.replace(/'/g,"''");
    runPowerShell("$drive=[IO.DriveInfo]::new('"+drive+"'); if($drive.DriveType -ne [IO.DriveType]::Fixed -and $drive.DriveType -ne [IO.DriveType]::Removable){exit 1}");
  }
  for(let current=resolved;;current=path.dirname(current)){
    if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())fail('PRIVATE_LOCAL_PATH_LINK');
    if(fs.existsSync(path.join(current,'.git')))fail('PRIVATE_LOCAL_PATH_REPOSITORY');
    if(current===path.dirname(current))break;
  }
  return resolved;
}
function runPowerShell(script:string,args:string[]=[]){
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script,...args],{encoding:'utf8',windowsHide:true});
  if(result.status!==0)fail('PRIVATE_LOCAL_PERMISSIONS_INVALID');
}
function protectDirectory(directory:string){
  if(process.platform==='win32'){
    const literal="'"+directory.replace(/'/g,"''")+"'";
    runPowerShell("$ErrorActionPreference='Stop'; $p="+literal+"; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); foreach($s in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}; [IO.Directory]::SetAccessControl($p,$acl)");
  }else fs.chmodSync(directory,0o700);
}
function requirePrivateInput(file:string){
  const resolved=assertPrivateLocalPath(file);
  if(!fs.lstatSync(resolved).isFile())fail('PRIVATE_INPUT_INVALID');
  if(process.platform==='win32'){
    const literal="'"+resolved.replace(/'/g,"''")+"'";
    runPowerShell("$ErrorActionPreference='Stop'; $p="+literal+"; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=[IO.File]::GetAccessControl($p); $allowed=@($sid,'S-1-5-18','S-1-5-32-544'); $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; if($owner -notin $allowed){exit 1}; foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed){exit 1}}");
  }else{
    const stat=fs.statSync(resolved);
    if((stat.mode&0o077)!==0||(typeof process.getuid==='function'&&stat.uid!==process.getuid()))fail('PRIVATE_INPUT_PERMISSIONS_INVALID');
  }
  return resolved;
}
export async function issueRentalProfiles({input,approvedOutputRoot,outputDirectory,now=new Date()}:{
  input:RentalIssuanceInput;approvedOutputRoot:string;outputDirectory:string;now?:Date
}){
  const base=assertPrivateLocalPath(approvedOutputRoot),output=assertPrivateLocalPath(outputDirectory);
  if(output===base||!output.startsWith(base+path.sep))fail('OUTPUT_PATH_INVALID');
  if(fs.existsSync(output))fail('OUTPUT_EXISTS');
  const result=buildRentalProfiles(input,{now});
  // mkdir without recursive never creates an unapproved parent or follows a new junction.
  if(!fs.existsSync(base)||!fs.statSync(base).isDirectory()||path.dirname(output)!==base)fail('OUTPUT_PATH_INVALID');
  fs.mkdirSync(output,{mode:0o700});
  protectDirectory(output);
  const entries=[];
  for(const {fileName,profile} of result.profiles){
    const source=path.join(output,fileName);
    fs.writeFileSync(source,JSON.stringify(profile,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
    entries.push({name:fileName,source});
  }
  const archive=path.join(output,'UIV3_OFFICIAL_DEVICE_PROFILES.zip');
  const manifest=await writeZip(archive,entries);
  await verifyZipAgainstManifest(archive,manifest);
  fs.writeFileSync(path.join(output,'ISSUANCE_RECEIPT.json'),JSON.stringify(result.receipt,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
  return {outputDirectory:output,receipt:result.receipt};
}
export async function issueRentalProfilesFromRequest(requestPath:string){
  const request=JSON.parse(fs.readFileSync(requirePrivateInput(requestPath),'utf8'));
  record(request,['schemaVersion','stage','deploymentId','apiBaseUrl','issuedAt','notBefore','expiresAt','defaultSessionId',
    'eventConfigPath','tokenManifestPath','keys','administratorPasswordFile','approvedOutputRoot','outputDirectory'],['approvalReference','renewalProfilePaths'],'REQUEST');
  if(request.schemaVersion!==1||!Array.isArray(request.keys)
    ||(request.renewalProfilePaths!==undefined&&(!Array.isArray(request.renewalProfilePaths)||request.renewalProfilePaths.length!==DEVICES.length)))fail('REQUEST_INVALID');
  const read=(p:string)=>fs.readFileSync(requirePrivateInput(p),'utf8');
  const input:RentalIssuanceInput={
    stage:request.stage,deploymentId:request.deploymentId,apiBaseUrl:request.apiBaseUrl,
    issuedAt:request.issuedAt,notBefore:request.notBefore,expiresAt:request.expiresAt,defaultSessionId:request.defaultSessionId,
    ...(request.approvalReference===undefined?{}:{approvalReference:request.approvalReference}),
    eventConfig:JSON.parse(read(request.eventConfigPath)),tokenManifest:JSON.parse(read(request.tokenManifestPath)),
    keys:request.keys.map((k:unknown)=>{const item=record(k,['tokenId','filePath'],[],'KEY_FILE');return {tokenId:item.tokenId,token:read(item.filePath).trim()};}),
    administratorPassword:read(request.administratorPasswordFile).replace(/\r?\n$/,''),
    ...(request.renewalProfilePaths===undefined?{}:{renewalProfiles:request.renewalProfilePaths.map((file:string)=>{
      const checked=requirePrivateInput(file);
      return {fileName:path.basename(checked),profile:JSON.parse(fs.readFileSync(checked,'utf8'))};
    })})
  };
  return issueRentalProfiles({input,approvedOutputRoot:request.approvedOutputRoot,outputDirectory:request.outputDirectory});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const requestPath=process.argv[2];
  if(!requestPath){process.stderr.write('REQUEST_PATH_REQUIRED\n');process.exitCode=1;}
  else issueRentalProfilesFromRequest(requestPath).then(result=>process.stdout.write(JSON.stringify(result.receipt)+'\n')).catch(error=>{
    const message=error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'ISSUANCE_FAILED';
    process.stderr.write(message+'\n');process.exitCode=1;
  });
}
