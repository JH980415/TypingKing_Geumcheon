import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadDeviceProfile, loadEventProfile } from "../shared/events/eventProfile";
import type { AppVariant, PcRole } from "../shared/types";
import type { DeviceProfile, EventProfile, EventProfileId, EventVariantPolicy } from "../shared/events/types";

export type StartupProfile = {
  eventProfile: EventProfile;
  deviceProfile?: DeviceProfile;
  runtimeRoot: string;
  userDataPath?: string;
};

export type LaunchPolicy = { pcRole: PcRole };

export type StartupProfileOptions = {
  isPackaged: boolean;
  projectRoot: string;
  executableDirectory: string;
  localAppData?: string;
  eventProfile?: string;
  packagedEventProfile?: string;
  runtimeRootOverride?: string;
};

export type PackagedMetadata = {
  eventProfileId?: EventProfileId;
  variant?: AppVariant;
};

export type ApplicationResourcePaths = {
  resourceRoot: string;
  eventProfilePath: string;
  iconPath: string;
  rendererAssetBaseUrl: string;
};

export function resolvePackagedMetadata(value: unknown): PackagedMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const metadata = value as Record<string, unknown>;
  const eventProfileId = metadata.typingKingEventProfile === "skillup-2026" ||
    metadata.typingKingEventProfile === "geumcheon-2026"
    ? metadata.typingKingEventProfile
    : undefined;
  const variant = metadata.typingKingVariant === "typing" || metadata.typingKingVariant === "typing-leaderboard" ||
    metadata.typingKingVariant === "ai" || metadata.typingKingVariant === "ai-leaderboard" ||
    metadata.typingKingVariant === "practice" || metadata.typingKingVariant === "practice-leaderboard"
    ? metadata.typingKingVariant
    : undefined;
  return { eventProfileId, variant };
}

export function recordModeFromPolicy(policy: EventVariantPolicy): "normal" | "ai_challenge" {
  return policy.gameModes[0] || "normal";
}

export function portableRuntimeMigrationAllowed(profileId: EventProfileId): boolean {
  return profileId === "skillup-2026";
}

export function resolveApplicationResourcePaths(input: {
  isPackaged: boolean;
  projectRoot: string;
  resourcesPath?: string;
  eventProfileId: EventProfileId;
  role: PcRole;
}): ApplicationResourcePaths {
  const usesPackagedResources = input.isPackaged && input.eventProfileId === "geumcheon-2026";
  if (usesPackagedResources && !input.resourcesPath) {
    throw new Error("Packaged application resources path is required");
  }
  const resourceRoot = usesPackagedResources ? input.resourcesPath! : input.projectRoot;
  const assetsRoot = path.join(resourceRoot, "assets");
  return {
    resourceRoot,
    eventProfilePath: path.join(resourceRoot, "events", input.eventProfileId, "event.config.json"),
    iconPath: path.join(
      assetsRoot,
      "icons",
      input.role === "leaderboard" ? "leaderboard_app_icon.ico" : "typing_app_icon.ico"
    ),
    rendererAssetBaseUrl: pathToFileURL(assetsRoot).toString()
  };
}

const skillUpCompatibilityProfile: EventProfile = {
  schemaVersion: 1,
  profileId: "skillup-2026",
  eventId: "skillup-festa-2026",
  nasEventId: "skillup-festa-2026",
  eventName: "2026 일잘러 페스타 타자왕",
  eventNameEn: "Skill-Up Festa 2026 Typing King",
  slogan: "일잘러의 성장을 연결합니다",
  gameName: "일잘러 타자왕",
  runtimeNamespace: "skillup-2026",
  stageTextCatalogVersion: "skillup-2026-v1",
  privacy: { noticeVersion: null, retentionExpiresAt: null },
  theme: { primaryColor: "#003B95", accentColor: "#E21883", backgroundColor: "#F7F8F2", correctColor: "#0057B8", wrongColor: "#E53935", cyanColor: "#08A7D8", orangeColor: "#F58220", successColor: "#098A55" },
  assets: {
    eventTitle: "assets/logo/event-logo.png",
    pageBackground: "assets/background/brand-soft.png",
    aiBossTyping: "assets/ai_challenge/ai_boss_typing.png",
    aiBossVictory: "assets/ai_challenge/ai_boss_victory.png",
    aiBossDefeat: "assets/ai_challenge/ai_boss_defeat.png",
    vsBadge: "assets/ai_challenge/vs_badge.png",
    stageBadges: ["assets/ai_challenge/stage_badge_1.png", "assets/ai_challenge/stage_badge_2.png", "assets/ai_challenge/stage_badge_3.png"]
  },
  variants: {
    typing: { variant: "typing", enabled: true, role: "player", sessionKind: "official", gameModes: ["normal"], displayName: "일잘러 타자왕은 누구!?", windowTitle: "일잘러 타자왕은 누구!?", artifactName: "일잘러 타자왕은 누구!.exe" },
    "typing-leaderboard": { variant: "typing-leaderboard", enabled: true, role: "leaderboard", sessionKind: "official", gameModes: ["normal"], displayName: "일잘러 타자왕은 누구!? 리더보드", windowTitle: "일잘러 타자왕은 누구!? 리더보드", artifactName: "일잘러 타자왕은 누구!_리더보드.exe" },
    ai: { variant: "ai", enabled: true, role: "player", sessionKind: "official", gameModes: ["ai_challenge"], displayName: "AI 타자왕을 이겨라!", windowTitle: "AI 타자왕을 이겨라!", artifactName: "AI 타자왕을 이겨라!.exe" },
    "ai-leaderboard": { variant: "ai-leaderboard", enabled: true, role: "leaderboard", sessionKind: "official", gameModes: ["ai_challenge"], displayName: "AI 타자왕을 이겨라! 리더보드", windowTitle: "AI 타자왕을 이겨라! 리더보드", artifactName: "AI 타자왕을 이겨라!_리더보드.exe" },
    practice: { variant: "practice", enabled: true, role: "player", sessionKind: "practice", gameModes: ["normal", "ai_challenge"], displayName: "타자왕 연습모드", windowTitle: "타자왕 연습모드", artifactName: "연습모드.exe" },
    "practice-leaderboard": { variant: "practice-leaderboard", enabled: true, role: "leaderboard", sessionKind: "practice", gameModes: ["normal", "ai_challenge"], displayName: "타자왕 연습모드 리더보드", windowTitle: "타자왕 연습모드 리더보드", artifactName: "연습모드_리더보드.exe" }
  },
  aiChallenge: {
    official: { enabled: true, stageSpeedRanges: { stage1: { min: 300, max: 350 }, stage2: { min: 350, max: 400 }, stage3: { min: 400, max: 450 } }, countdownSeconds: 3, aiEnterDelayMs: 150, aiSpeedChangeIntervalMs: 500 },
    practice: { enabled: true, stageSpeedRanges: { stage1: { min: 300, max: 350 }, stage2: { min: 350, max: 400 }, stage3: { min: 400, max: 450 } }, countdownSeconds: 3, aiEnterDelayMs: 150, aiSpeedChangeIntervalMs: 500 }
  }
};

function selectedProfileId(options: StartupProfileOptions): EventProfileId {
  const selector = options.isPackaged ? options.packagedEventProfile : options.eventProfile;
  if (selector === undefined || selector === "") return "skillup-2026";
  if (selector === "skillup-2026" || selector === "geumcheon-2026") return selector;
  throw new Error(`Unsupported event profile selector: ${selector}`);
}

export function resolveDeviceRuntimeRoot(
  localAppData: string,
  profileId: EventProfileId,
  deviceId: DeviceProfile["deviceId"]
): string {
  return path.join(localAppData, "ThePMD", "TypingKing2026", profileId, deviceId);
}

export function resolveLaunchPolicy(startup: StartupProfile, variant: AppVariant): LaunchPolicy {
  const variantPolicy = startup.eventProfile.variants[variant];
  if (!variantPolicy.enabled) throw new Error(`Variant ${variant} is disabled for ${startup.eventProfile.profileId}`);
  if (startup.eventProfile.profileId === "geumcheon-2026") {
    if (!startup.deviceProfile) throw new Error("Geumcheon launch requires a validated device profile");
    if (startup.deviceProfile.role !== variantPolicy.role) {
      throw new Error(`Device role ${startup.deviceProfile.role} cannot launch ${variantPolicy.role} variant ${variant}`);
    }
    return { pcRole: startup.deviceProfile.role };
  }
  return { pcRole: variantPolicy.role };
}

export function resolveStartupProfile(options: StartupProfileOptions): StartupProfile {
  const profileId = selectedProfileId(options);
  const eventProfile = profileId === "skillup-2026" && options.isPackaged
    ? skillUpCompatibilityProfile
    : loadEventProfile(path.join(options.projectRoot, "events", profileId, "event.config.json"));
  if (profileId === "skillup-2026") {
    const localBase = options.localAppData;
    const runtimeRoot = !options.isPackaged && options.runtimeRootOverride
      ? options.runtimeRootOverride
      : options.isPackaged && localBase
        ? path.join(localBase, "ThePMD", "TypingKing2026")
        : options.projectRoot;
    return { eventProfile, runtimeRoot };
  }

  const deviceProfile = loadDeviceProfile(path.join(options.executableDirectory, "device-profile.json"));
  if (deviceProfile.eventProfileId !== eventProfile.profileId || deviceProfile.eventId !== eventProfile.eventId) {
    throw new Error("Device profile does not match the selected Geumcheon event profile");
  }
  const localBase = options.localAppData || options.projectRoot;
  const runtimeRoot = !options.isPackaged && options.runtimeRootOverride
    ? options.runtimeRootOverride
    : resolveDeviceRuntimeRoot(localBase, eventProfile.profileId, deviceProfile.deviceId);
  return {
    eventProfile,
    deviceProfile,
    runtimeRoot,
    userDataPath: path.join(runtimeRoot, "electron-user-data")
  };
}
