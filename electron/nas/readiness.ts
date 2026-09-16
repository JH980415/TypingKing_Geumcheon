import type {GameStartReadiness} from "../../shared/types";
import {NasApiError} from "./apiClient";
import {deploymentErrorForDisplay} from "../deploymentProfile";
export const CLIENT_CLOCK_AHEAD_LIMIT_MS=1000;
export async function checkGeumcheonNasReadiness(options:{checkAuthenticatedReady():Promise<unknown>;getServerClockSkewMs?():number|undefined}):Promise<GameStartReadiness>{
 try{await options.checkAuthenticatedReady();}
 catch(error){
  return readinessFailure(error);
 }
 // The record server rejects completed_at later than its own receipt time, so a PC clock running ahead of the NAS
 // would silently lose every record; refuse to start and tell the operator to synchronise Windows time.
 const skew=options.getServerClockSkewMs?.();
 if(typeof skew==="number"&&Number.isFinite(skew)&&skew>CLIENT_CLOCK_AHEAD_LIMIT_MS){
  const seconds=Math.max(1,Math.round(skew/1000));
  return {ready:false,message:`이 PC의 시계가 기록 서버보다 약 ${seconds}초 빠릅니다. Windows 설정 > 시간 및 언어 > 날짜 및 시간에서 '지금 동기화'를 실행한 뒤 다시 시작해 주세요.`,reasons:["CLIENT_CLOCK_AHEAD"]};
 }
 return {ready:true};
}
function readinessFailure(error:unknown):GameStartReadiness{
  const profileMessage=deploymentErrorForDisplay(error);
  if(profileMessage)return {ready:false,message:profileMessage,reasons:[error instanceof Error?error.message:"PROFILE_INVALID"]};
  if(error instanceof NasApiError && (error.status===401 || error.status===403))return {ready:false,message:"서버가 이 PC의 인증 또는 권한을 거부했습니다. 운영자에게 유효한 프로필 확인을 요청해 주세요.",reasons:["NAS_AUTH_REJECTED"]};
  if(error instanceof NasApiError && error.status>=500)return {ready:false,message:"기록 서버에 일시적인 오류가 있습니다. 잠시 후 다시 확인해 주세요.",reasons:["NAS_SERVER_ERROR"]};
  return {ready:false,message:"기록 서버에 연결할 수 없습니다. 인터넷과 NAS 상태를 확인한 뒤 다시 시도해 주세요.",reasons:["NAS_UNAVAILABLE"]};
}
export async function requireGeumcheonCredential(importCredential:()=>Promise<unknown>):Promise<void>{
 try{await importCredential();}catch(error){throw new Error("GEUMCHEON_NAS_CREDENTIAL_REQUIRED",{cause:error});}
}
