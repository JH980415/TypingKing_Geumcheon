import type { AiChallengeConfig, AppVariant, ThemeConfig } from "../types";

export type EventProfileId = "skillup-2026" | "geumcheon-2026";
export type SessionKind = "official" | "practice";

export type EventVariantPolicy = {
  variant: AppVariant;
  enabled: boolean;
  role: "player" | "leaderboard";
  sessionKind: SessionKind;
  gameModes: readonly ("normal" | "ai_challenge")[];
  displayName: string;
  windowTitle: string;
  artifactName: string;
};

export type EventProfile = {
  schemaVersion: 1;
  profileId: EventProfileId;
  eventId: string;
  nasEventId: string;
  eventName: string;
  eventNameEn: string;
  slogan: string;
  gameName: string;
  runtimeNamespace: string;
  stageTextCatalogVersion: string;
  privacy: { noticeVersion: string | null; retentionExpiresAt: string | null };
  theme: ThemeConfig;
  assets: {
    eventTitle: string;
    pageBackground: string;
    startBackground: string;
    playBackground: string;
    leaderboardBackground: string;
    aiBossMain: string;
    aiBossTyping: string;
    aiBossVictory: string;
    aiBossDefeat: string;
    aiBossDefeats?: readonly [string, string, string];
    vsBadge: string;
    stageBadges: readonly [string, string, string];
  };
  variants: Record<AppVariant, EventVariantPolicy>;
  aiChallenge: Record<SessionKind, AiChallengeConfig>;
};

export function resolveEventAssetUrl(
  assetBaseUrl: string,
  eventProfile: Pick<EventProfile, "profileId">,
  configuredPath: string
): string {
  const baseUrl = assetBaseUrl.replace(/\/+$/, "");
  const relativePath = configuredPath.replace(/^assets\//, "");
  return eventProfile.profileId === "geumcheon-2026"
    ? `${baseUrl}/../events/${eventProfile.profileId}/assets/${relativePath}`
    : `${baseUrl}/${relativePath}`;
}

export function resolveAiBossResultAsset(
  eventProfile: Pick<EventProfile, "assets">,
  result: "USER_WIN" | "AI_WIN",
  stage: 1 | 2 | 3
): string {
  if (result === "AI_WIN") return eventProfile.assets.aiBossVictory;
  return eventProfile.assets.aiBossDefeats?.[stage - 1] ?? eventProfile.assets.aiBossDefeat;
}

export type DeviceProfile = {
  schemaVersion: 1;
  eventProfileId: EventProfileId;
  eventId: string;
  deviceId: `PC0${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}` | "PC10" | "LEADERBOARD01";
  role: "player" | "leaderboard";
  apiBaseUrl: string;
  sessions: {
    official: { sessionId: string; dayNo: number; roundNo: number };
    practice?: { sessionId: string };
  };
  requestTimeoutMs: number;
  retry: { initialDelayMs: number; maxDelayMs: number };
};
