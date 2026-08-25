import type { AppConfig, AppMode, AppVariant, BootstrapData } from "../types";
import type { EventProfile } from "./types";
import { validateDeviceProfile, validateEventProfile, variantPolicyFor } from "./eventProfile";

type BootstrapInput = {
  config: AppConfig;
  assetBaseUrl: string;
  notices: string[];
  mode: AppMode;
  variant: AppVariant;
  eventProfile: EventProfile;
  deviceProfile?: unknown;
};

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
    config: {
      ...input.config,
      eventName: eventProfile.eventName,
      theme: eventProfile.theme,
      aiChallenge: eventProfile.aiChallenge[variantPolicy.sessionKind]
    },
    assetBaseUrl: input.assetBaseUrl,
    notices: [...input.notices],
    mode: input.mode,
    variant: input.variant,
    eventProfile,
    variantPolicy,
    deviceProfile
  };
}
