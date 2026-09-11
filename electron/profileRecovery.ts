import {app,BrowserWindow,dialog,safeStorage,ipcMain} from "electron";
import fs from "node:fs";
import path from "node:path";
import {randomBytes,scryptSync} from "node:crypto";
import {AdminAccessSessions} from "./adminAccessSession";
import {assertSafeDeploymentApplication,deploymentErrorForDisplay,loadDeploymentProfile,profileFingerprint,profilePreview,replaceDeploymentSelection,withDeploymentLocks,type AdministratorVerifier,type DeploymentProfileV2} from "./deploymentProfile";
type RecoveryAuthorization={verifier:AdministratorVerifier;runtimeRoot:string};
export function saveRecoveryAuthorization(filePath:string,password:string,profile:DeploymentProfileV2,runtimeRoot:string):void {
 let verifier=profile.administrator;
 if(password.trim() && password.trim()!=="CHANGE_ME_BEFORE_EVENT") {const salt=randomBytes(16).toString("hex");verifier={algorithm:"scrypt",salt,hash:scryptSync(password,Buffer.from(salt,"hex"),64).toString("hex")};}
 const tmp=filePath+"."+process.pid+".tmp";fs.mkdirSync(path.dirname(filePath),{recursive:true});
 try{fs.writeFileSync(tmp,safeStorage.encryptString(JSON.stringify({verifier,runtimeRoot})),{mode:0o600});fs.renameSync(tmp,filePath);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
export async function openProfileRecovery(options:{error:unknown;authorizationPath:string;selectionPath:string;directory:string;variant:string;localAppData:string}):Promise<boolean>{
 if(!fs.existsSync(options.authorizationPath))return false;
 let auth:RecoveryAuthorization;
 try{auth=JSON.parse(safeStorage.decryptString(fs.readFileSync(options.authorizationPath)));if(auth.verifier.algorithm!=="scrypt"||!/^[a-f0-9]{32}$/.test(auth.verifier.salt)||!/^[a-f0-9]{128}$/.test(auth.verifier.hash)||!path.isAbsolute(auth.runtimeRoot))return false;}catch{return false;}
 const sessions=new AdminAccessSessions({password:"",verifier:auth.verifier,ttlMs:15*60*1000});
 const win=new BrowserWindow({width:640,height:550,resizable:false,title:"관리자 프로필 복구",webPreferences:{preload:path.join(__dirname,"profileRecoveryPreload.js"),contextIsolation:true,nodeIntegration:false,sandbox:true,devTools:false}});
 win.setMenuBarVisibility(false);win.removeMenu();win.webContents.setWindowOpenHandler(()=>({action:"deny"}));
 let candidate:{profile:DeploymentProfileV2;filePath:string;fingerprint:string}|undefined;
 function authorize(event:Electron.IpcMainInvokeEvent){if(event.sender.id!==win.webContents.id)throw new Error("ADMIN_AUTH_REQUIRED");sessions.require(event.sender);}
 async function safe(action:()=>Promise<unknown>|unknown){try{return {ok:true,data:await action()};}catch(error){return {ok:false,error:deploymentErrorForDisplay(error)||"관리자 인증 또는 프로필 적용을 확인해 주세요."};}}
 ipcMain.handle("recovery:authenticate",(event,password:string)=>safe(()=>{if(event.sender.id!==win.webContents.id)return false;return sessions.authenticate(event.sender,password).ok;}));
 ipcMain.handle("recovery:choose",event=>safe(async()=>{authorize(event);const result=await dialog.showOpenDialog(win,{title:"관리자 복구 프로필 선택",properties:["openFile"],filters:[{name:"원래 이름 장치 프로필",extensions:["json"]}]});if(result.canceled||!result.filePaths[0]){candidate=undefined;return null;}const filePath=result.filePaths[0],profile=loadDeploymentProfile(filePath);candidate={profile,filePath,fingerprint:profileFingerprint(profile)};return profilePreview(profile,filePath);}));
 ipcMain.handle("recovery:apply",event=>safe(async()=>{authorize(event);if(!candidate)throw new Error("PROFILE_CANDIDATE_MISSING");const current=loadDeploymentProfile(candidate.filePath);if(profileFingerprint(current)!==candidate.fingerprint)throw new Error("PROFILE_CANDIDATE_CHANGED");if(!options.variant.endsWith("leaderboard")&&current.device.role!=="player")throw new Error("PROFILE_GAME_ROLE_INVALID");const root=path.join(options.localAppData,"ThePMD","TypingKing2026",current.device.eventProfileId,current.device.deviceId);await withDeploymentLocks([auth.runtimeRoot,root],async()=>{await assertSafeDeploymentApplication({currentRuntimeRoot:auth.runtimeRoot,targetRuntimeRoot:root,replacement:current,safeStorage,coldRecovery:true});replaceDeploymentSelection(path.join(root,"nas","deployment-profile.bin"),options.selectionPath,options.directory,current,candidate!.filePath,safeStorage);});app.relaunch();app.quit();return true;}));
 const html=`<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>관리자 프로필 복구</title><style>body{font-family:Malgun Gothic,sans-serif;padding:30px;color:#15385c}input,button{font:inherit;padding:10px;margin:8px 4px}#preview{white-space:pre-wrap;padding:12px;background:#f0f4f8}p{line-height:1.5}</style></head><body><h2>관리자 프로필 복구</h2><p id="reason"></p><label>기존 관리자 비밀번호<input id="password" type="password" autocomplete="off"></label><button id="login">관리자 확인</button><p id="message" role="status"></p><div id="controls" hidden><button id="choose">복구 프로필 선택</button><pre id="preview"></pre><button id="apply" disabled>복구 프로필 적용·재시작</button></div><script>const $=id=>document.getElementById(id);$("login").onclick=async()=>{const r=await window.profileRecovery.authenticate($("password").value);$("password").value="";$("controls").hidden=!(r.ok&&r.data);$("message").textContent=r.ok&&r.data?"관리자 확인 완료":"관리자 비밀번호를 확인해 주세요.";};$("choose").onclick=async()=>{const r=await window.profileRecovery.choose();$("apply").disabled=!(r.ok&&r.data);$("preview").textContent=r.ok&&r.data?r.data.fileName+"\\n"+r.data.deviceId+" / "+r.data.eventId+"\\n"+r.data.session.dayNo+"일차 "+r.data.session.roundNo+"회차":"";$("message").textContent=r.ok?"":r.error;};$("apply").onclick=async()=>{const r=await window.profileRecovery.apply();$("message").textContent=r.ok?"적용했습니다. 앱을 다시 시작합니다.":r.error;};</script></body></html>`;
 await win.loadURL("data:text/html;charset=utf-8,"+encodeURIComponent(html));
 await win.webContents.executeJavaScript("document.getElementById('reason').textContent="+JSON.stringify(deploymentErrorForDisplay(options.error)||"저장된 프로필을 확인할 수 없습니다. 기존 기록은 보존됩니다."));
 await new Promise<void>(resolve=>win.once("closed",()=>{for(const channel of ["recovery:authenticate","recovery:choose","recovery:apply"])ipcMain.removeHandler(channel);resolve();}));
 app.quit();return true;
}
