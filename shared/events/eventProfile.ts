import fs from "node:fs";
import type { AiChallengeConfig, AppVariant, ThemeConfig } from "../types";
import type { DeviceProfile, EventProfile, EventProfileId, EventVariantPolicy, SessionKind } from "./types";

const APP_VARIANTS = ["typing", "typing-leaderboard", "ai", "ai-leaderboard", "practice", "practice-leaderboard"] as const;
const EVENT_IDS: Record<EventProfileId, string> = {
  "skillup-2026": "skillup-festa-2026",
  "geumcheon-2026": "geumcheon-science-festival-2026"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${name} has unknown key: ${key}`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${name} is missing key: ${key}`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requireEventProfileId(value: unknown, name: string): EventProfileId {
  if (value === "skillup-2026" || value === "geumcheon-2026") return value;
  throw new Error(`${name} must be a supported event profile ID`);
}

function requireRole(value: unknown, name: string): "player" | "leaderboard" {
  if (value === "player" || value === "leaderboard") return value;
  throw new Error(`${name} must be player or leaderboard`);
}

function validateTheme(value: unknown): ThemeConfig {
  const record = requireRecord(value, "theme");
  const keys = ["primaryColor", "accentColor", "backgroundColor", "correctColor", "wrongColor", "cyanColor", "orangeColor", "successColor"];
  requireExactKeys(record, keys, "theme");
  return Object.fromEntries(keys.map((key) => [key, requireString(record[key], `theme.${key}`)])) as ThemeConfig;
}

function validateAiChallenge(value: unknown, name: string): AiChallengeConfig {
  const record = requireRecord(value, name);
  requireExactKeys(record, ["enabled", "stageSpeedRanges", "countdownSeconds", "aiEnterDelayMs", "aiSpeedChangeIntervalMs"], name);
  if (typeof record.enabled !== "boolean") throw new Error(`${name}.enabled must be boolean`);
  const ranges = requireRecord(record.stageSpeedRanges, `${name}.stageSpeedRanges`);
  requireExactKeys(ranges, ["stage1", "stage2", "stage3"], `${name}.stageSpeedRanges`);
  const stageSpeedRanges = Object.fromEntries(
    ["stage1", "stage2", "stage3"].map((stage) => {
      const range = requireRecord(ranges[stage], `${name}.stageSpeedRanges.${stage}`);
      requireExactKeys(range, ["min", "max"], `${name}.stageSpeedRanges.${stage}`);
      const min = requirePositiveInteger(range.min, `${name}.stageSpeedRanges.${stage}.min`);
      const max = requirePositiveInteger(range.max, `${name}.stageSpeedRanges.${stage}.max`);
      if (min > max) throw new Error(`${name}.stageSpeedRanges.${stage} has an invalid range`);
      return [stage, { min, max }];
    })
  ) as AiChallengeConfig["stageSpeedRanges"];
  return {
    enabled: record.enabled,
    stageSpeedRanges,
    countdownSeconds: requirePositiveInteger(record.countdownSeconds, `${name}.countdownSeconds`),
    aiEnterDelayMs: requirePositiveInteger(record.aiEnterDelayMs, `${name}.aiEnterDelayMs`),
    aiSpeedChangeIntervalMs: requirePositiveInteger(record.aiSpeedChangeIntervalMs, `${name}.aiSpeedChangeIntervalMs`)
  };
}

function validateVariant(value: unknown, expectedVariant: AppVariant): EventVariantPolicy {
  const record = requireRecord(value, `variants.${expectedVariant}`);
  requireExactKeys(record, ["variant", "enabled", "role", "sessionKind", "gameModes", "displayName", "windowTitle", "artifactName"], `variants.${expectedVariant}`);
  if (record.variant !== expectedVariant) throw new Error(`variants.${expectedVariant}.variant must match its key`);
  if (typeof record.enabled !== "boolean") throw new Error(`variants.${expectedVariant}.enabled must be boolean`);
  const sessionKind = record.sessionKind === "official" || record.sessionKind === "practice" ? record.sessionKind : undefined;
  if (!sessionKind) throw new Error(`variants.${expectedVariant}.sessionKind is invalid`);
  if (!Array.isArray(record.gameModes) || record.gameModes.length === 0 || record.gameModes.some((mode) => mode !== "normal" && mode !== "ai_challenge")) {
    throw new Error(`variants.${expectedVariant}.gameModes is invalid`);
  }
  return {
    variant: expectedVariant,
    enabled: record.enabled,
    role: requireRole(record.role, `variants.${expectedVariant}.role`),
    sessionKind,
    gameModes: [...record.gameModes] as Array<"normal" | "ai_challenge">,
    displayName: requireString(record.displayName, `variants.${expectedVariant}.displayName`),
    windowTitle: requireString(record.windowTitle, `variants.${expectedVariant}.windowTitle`),
    artifactName: typeof record.artifactName === "string" ? record.artifactName : requireString(record.artifactName, `variants.${expectedVariant}.artifactName`)
  };
}

export function validateEventProfile(value: unknown): EventProfile {
  const record = requireRecord(value, "event profile");
  const keys = ["schemaVersion", "profileId", "eventId", "nasEventId", "eventName", "eventNameEn", "slogan", "gameName", "runtimeNamespace", "stageTextCatalogVersion", "privacy", "theme", "assets", "variants", "aiChallenge"];
  requireExactKeys(record, keys, "event profile");
  if (record.schemaVersion !== 1) throw new Error("event profile.schemaVersion must be 1");
  const profileId = requireEventProfileId(record.profileId, "event profile.profileId");
  if (record.eventId !== EVENT_IDS[profileId]) throw new Error("event profile.eventId does not match profileId");
  const privacy = requireRecord(record.privacy, "event profile.privacy");
  requireExactKeys(privacy, ["noticeVersion", "retentionExpiresAt"], "event profile.privacy");
  for (const key of ["noticeVersion", "retentionExpiresAt"] as const) {
    if (privacy[key] !== null && typeof privacy[key] !== "string") throw new Error(`event profile.privacy.${key} must be a string or null`);
  }
  const assets = requireRecord(record.assets, "event profile.assets");
  requireExactKeys(assets, ["eventTitle", "pageBackground", "aiBossTyping", "aiBossVictory", "aiBossDefeat", "vsBadge", "stageBadges"], "event profile.assets");
  if (!Array.isArray(assets.stageBadges) || assets.stageBadges.length !== 3) throw new Error("event profile.assets.stageBadges must contain three paths");
  const variants = requireRecord(record.variants, "event profile.variants");
  requireExactKeys(variants, APP_VARIANTS, "event profile.variants");
  const aiChallenge = requireRecord(record.aiChallenge, "event profile.aiChallenge");
  requireExactKeys(aiChallenge, ["official", "practice"], "event profile.aiChallenge");
  return {
    schemaVersion: 1,
    profileId,
    eventId: requireString(record.eventId, "event profile.eventId"),
    nasEventId: requireString(record.nasEventId, "event profile.nasEventId"),
    eventName: requireString(record.eventName, "event profile.eventName"),
    eventNameEn: requireString(record.eventNameEn, "event profile.eventNameEn"),
    slogan: requireString(record.slogan, "event profile.slogan"),
    gameName: requireString(record.gameName, "event profile.gameName"),
    runtimeNamespace: requireString(record.runtimeNamespace, "event profile.runtimeNamespace"),
    stageTextCatalogVersion: requireString(record.stageTextCatalogVersion, "event profile.stageTextCatalogVersion"),
    privacy: { noticeVersion: privacy.noticeVersion as string | null, retentionExpiresAt: privacy.retentionExpiresAt as string | null },
    theme: validateTheme(record.theme),
    assets: {
      eventTitle: requireString(assets.eventTitle, "event profile.assets.eventTitle"),
      pageBackground: requireString(assets.pageBackground, "event profile.assets.pageBackground"),
      aiBossTyping: requireString(assets.aiBossTyping, "event profile.assets.aiBossTyping"),
      aiBossVictory: requireString(assets.aiBossVictory, "event profile.assets.aiBossVictory"),
      aiBossDefeat: requireString(assets.aiBossDefeat, "event profile.assets.aiBossDefeat"),
      vsBadge: requireString(assets.vsBadge, "event profile.assets.vsBadge"),
      stageBadges: assets.stageBadges.map((badge, index) => requireString(badge, `event profile.assets.stageBadges.${index}`)) as [string, string, string]
    },
    variants: Object.fromEntries(APP_VARIANTS.map((variant) => [variant, validateVariant(variants[variant], variant)])) as Record<AppVariant, EventVariantPolicy>,
    aiChallenge: {
      official: validateAiChallenge(aiChallenge.official, "event profile.aiChallenge.official"),
      practice: validateAiChallenge(aiChallenge.practice, "event profile.aiChallenge.practice")
    }
  };
}

export function loadEventProfile(filePath: string): EventProfile {
  try {
    return validateEventProfile(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    throw new Error(`Invalid event profile at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateDeviceProfile(value: unknown): DeviceProfile {
  const record = requireRecord(value, "device profile");
  requireExactKeys(record, ["schemaVersion", "eventProfileId", "eventId", "deviceId", "role", "apiBaseUrl", "sessions", "requestTimeoutMs", "retry"], "device profile");
  if (record.schemaVersion !== 1) throw new Error("device profile.schemaVersion must be 1");
  const eventProfileId = requireEventProfileId(record.eventProfileId, "device profile.eventProfileId");
  if (record.eventId !== EVENT_IDS[eventProfileId]) throw new Error("device profile.eventId does not match eventProfileId");
  const deviceId = requireString(record.deviceId, "device profile.deviceId");
  if (!/^PC0[1-9]$|^PC10$|^LEADERBOARD01$/.test(deviceId)) throw new Error("device profile.deviceId is invalid");
  const role = requireRole(record.role, "device profile.role");
  if ((deviceId === "LEADERBOARD01") !== (role === "leaderboard")) throw new Error("device profile.role does not match deviceId");
  const apiBaseUrl = requireString(record.apiBaseUrl, "device profile.apiBaseUrl");
  let url: URL;
  try {
    url = new URL(apiBaseUrl);
  } catch {
    throw new Error("device profile.apiBaseUrl must be an HTTPS URL");
  }
  if (url.protocol !== "https:") throw new Error("device profile.apiBaseUrl must use HTTPS");
  if (url.username || url.password) throw new Error("device profile.apiBaseUrl cannot contain credentials");
  if (url.search) throw new Error("device profile.apiBaseUrl cannot contain a query");
  if (url.hash) throw new Error("device profile.apiBaseUrl cannot contain a hash");
  const sessions = requireRecord(record.sessions, "device profile.sessions");
  requireExactKeys(sessions, ["official", "practice"], "device profile.sessions");
  const official = requireRecord(sessions.official, "device profile.sessions.official");
  requireExactKeys(official, ["sessionId", "dayNo", "roundNo"], "device profile.sessions.official");
  const practice = requireRecord(sessions.practice, "device profile.sessions.practice");
  requireExactKeys(practice, ["sessionId"], "device profile.sessions.practice");
  const retry = requireRecord(record.retry, "device profile.retry");
  requireExactKeys(retry, ["initialDelayMs", "maxDelayMs"], "device profile.retry");
  const initialDelayMs = requirePositiveInteger(retry.initialDelayMs, "device profile.retry.initialDelayMs");
  const maxDelayMs = requirePositiveInteger(retry.maxDelayMs, "device profile.retry.maxDelayMs");
  if (initialDelayMs > maxDelayMs) throw new Error("device profile.retry initialDelayMs must not exceed maxDelayMs");
  return {
    schemaVersion: 1,
    eventProfileId,
    eventId: record.eventId,
    deviceId: deviceId as DeviceProfile["deviceId"],
    role,
    apiBaseUrl: url.toString().replace(/\/$/, ""),
    sessions: {
      official: { sessionId: requireString(official.sessionId, "device profile.sessions.official.sessionId"), dayNo: requirePositiveInteger(official.dayNo, "device profile.sessions.official.dayNo"), roundNo: requirePositiveInteger(official.roundNo, "device profile.sessions.official.roundNo") },
      practice: { sessionId: requireString(practice.sessionId, "device profile.sessions.practice.sessionId") }
    },
    requestTimeoutMs: requirePositiveInteger(record.requestTimeoutMs, "device profile.requestTimeoutMs"),
    retry: { initialDelayMs, maxDelayMs }
  };
}

export function loadDeviceProfile(filePath: string): DeviceProfile {
  try {
    return validateDeviceProfile(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    throw new Error(`Invalid device profile at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function variantPolicyFor(profile: EventProfile, variant: AppVariant): EventVariantPolicy {
  return profile.variants[variant];
}

export type { DeviceProfile, EventProfile, EventProfileId, EventVariantPolicy, SessionKind } from "./types";
