import type { GameStartReadiness } from "../../shared/types";

export async function checkGeumcheonNasReadiness(options: {
  checkAuthenticatedReady(): Promise<unknown>;
}): Promise<GameStartReadiness> {
  try {
    await options.checkAuthenticatedReady();
    return { ready: true };
  } catch {
    return unavailable();
  }
}

export async function requireGeumcheonCredential(importCredential: () => Promise<unknown>): Promise<void> {
  try {
    await importCredential();
  } catch (error) {
    throw new Error("GEUMCHEON_NAS_CREDENTIAL_REQUIRED", { cause: error });
  }
}

function unavailable(): GameStartReadiness {
  return {
    ready: false,
    message: "기록 서버에 연결할 수 없습니다. 인터넷과 NAS 상태를 확인한 뒤 다시 시도해 주세요.",
    reasons: ["NAS_UNAVAILABLE"]
  };
}
