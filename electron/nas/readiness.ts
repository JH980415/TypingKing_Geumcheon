import type {GameStartReadiness} from "../../shared/types";
import {NasApiError} from "./apiClient";
import {deploymentErrorForDisplay} from "../deploymentProfile";
export async function checkGeumcheonNasReadiness(options:{checkAuthenticatedReady():Promise<unknown>}):Promise<GameStartReadiness>{
 try{await options.checkAuthenticatedReady();return {ready:true};}
 catch(error){
  const profileMessage=deploymentErrorForDisplay(error);
  if(profileMessage)return {ready:false,message:profileMessage,reasons:[error instanceof Error?error.message:"PROFILE_INVALID"]};
  if(error instanceof NasApiError && (error.status===401 || error.status===403))return {ready:false,message:"서버가 이 PC의 인증 또는 권한을 거부했습니다. 운영자에게 유효한 프로필 확인을 요청해 주세요.",reasons:["NAS_AUTH_REJECTED"]};
  if(error instanceof NasApiError && error.status>=500)return {ready:false,message:"기록 서버에 일시적인 오류가 있습니다. 잠시 후 다시 확인해 주세요.",reasons:["NAS_SERVER_ERROR"]};
  return {ready:false,message:"기록 서버에 연결할 수 없습니다. 인터넷과 NAS 상태를 확인한 뒤 다시 시도해 주세요.",reasons:["NAS_UNAVAILABLE"]};
 }
}
export async function requireGeumcheonCredential(importCredential:()=>Promise<unknown>):Promise<void>{
 try{await importCredential();}catch(error){throw new Error("GEUMCHEON_NAS_CREDENTIAL_REQUIRED",{cause:error});}
}
