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
    aiBossTyping: string;
    aiBossVictory: string;
    aiBossDefeat: string;
    vsBadge: string;
    stageBadges: readonly [string, string, string];
  };
  variants: Record<AppVariant, EventVariantPolicy>;
  aiChallenge: Record<SessionKind, AiChallengeConfig>;
};

export type DeviceProfile = {
  schemaVersion: 1;
  eventProfileId: EventProfileId;
  eventId: string;
  deviceId: `PC0${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}` | "PC10" | "LEADERBOARD01";
  role: "player" | "leaderboard";
  apiBaseUrl: string;
  sessions: {
    official: { sessionId: string; dayNo: number; roundNo: number };
    practice: { sessionId: string };
  };
  requestTimeoutMs: number;
  retry: { initialDelayMs: number; maxDelayMs: number };
};
