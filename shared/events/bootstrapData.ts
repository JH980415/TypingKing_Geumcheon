import type { AppConfig, AppMode, AppVariant, BootstrapData, ReviewRuntimeContext } from "../types";
import type { EventProfile, SessionKind } from "./types";
import { validateDeviceProfile, validateEventProfile, variantPolicyFor } from "./eventProfile";

type BootstrapInput = {
  config: AppConfig;
  assetBaseUrl: string;
  notices: string[];
  mode: AppMode;
  variant: AppVariant;
  eventProfile: EventProfile;
  deviceProfile?: unknown;
  reviewContext?: ReviewRuntimeContext;
};

export function resolveBootstrapTheme(
  bootstrap: Pick<BootstrapData, "config" | "eventProfile">
): AppConfig["theme"] {
  return bootstrap.eventProfile.profileId === "geumcheon-2026"
    ? bootstrap.eventProfile.theme
    : bootstrap.config.theme;
}

export function mergeRuntimeConfigWithEventProfile(
  runtimeConfig: AppConfig,
  eventProfile: EventProfile,
  sessionKind: SessionKind
): AppConfig {
  if (eventProfile.profileId !== "geumcheon-2026") return runtimeConfig;
  return {
    ...runtimeConfig,
    eventName: eventProfile.eventName,
    theme: eventProfile.theme,
    aiChallenge: eventProfile.aiChallenge[sessionKind]
  };
}

export function createBootstrapData(input: BootstrapInput): BootstrapData {
  const eventProfile = validateEventProfile(input.eventProfile);
  const variantPolicy = variantPolicyFor(eventProfile, input.variant);
  if (!variantPolicy.enabled) {
    throw new Error(`Variant ${input.variant} disabled for ${eventProfile.profileId}`);
  }

  const deviceProfile = input.deviceProfile === undefined
    ? undefined
    : validateDeviceProfile(input.deviceProfile);

  return {
    config: redactRendererConfig(
      mergeRuntimeConfigWithEventProfile(input.config, eventProfile, variantPolicy.sessionKind)
    ),
    assetBaseUrl: input.assetBaseUrl,
    notices: [...input.notices],
    mode: input.mode,
    variant: input.variant,
    eventProfile,
    variantPolicy,
    deviceProfile,
    reviewContext: input.reviewContext
  };
}

export function redactRendererConfig(config: AppConfig): AppConfig {
  return { ...config, adminPassword: "" };
}
