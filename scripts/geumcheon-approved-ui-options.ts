export const approvedUiVariants = [
  "ai",
  "ai-leaderboard",
  "practice",
  "practice-leaderboard"
] as const;

export type ApprovedUiVariant = (typeof approvedUiVariants)[number];

export type ApprovedUiRunOptions =
  | {
      mode: "automated";
      captureScreens: true;
      waitForUserClose: false;
    }
  | {
      mode: "interactive";
      variant: ApprovedUiVariant;
      captureScreens: false;
      waitForUserClose: true;
    };

function isApprovedUiVariant(value: string): value is ApprovedUiVariant {
  return approvedUiVariants.includes(value as ApprovedUiVariant);
}

export function parseApprovedUiRunOptions(args: readonly string[]): ApprovedUiRunOptions {
  let interactive = false;
  let variant: ApprovedUiVariant | undefined;

  for (const argument of args) {
    if (argument === "--interactive") {
      interactive = true;
      continue;
    }
    if (argument.startsWith("--variant=")) {
      const candidate = argument.slice("--variant=".length);
      if (!isApprovedUiVariant(candidate)) {
        throw new Error(`Unsupported Geumcheon review variant: ${candidate || "(empty)"}`);
      }
      variant = candidate;
      continue;
    }
    throw new Error(`Unknown Geumcheon review option: ${argument}`);
  }

  if (!interactive && variant) {
    throw new Error("--variant requires --interactive");
  }
  if (interactive && !variant) {
    throw new Error("--interactive requires --variant");
  }
  if (interactive) {
    return {
      mode: "interactive",
      variant,
      captureScreens: false,
      waitForUserClose: true
    };
  }
  return {
    mode: "automated",
    captureScreens: true,
    waitForUserClose: false
  };
}

export function buildApprovedUiLaunchEnvironment(
  options: ApprovedUiRunOptions
): Record<string, string> {
  return {
    TYPINGKING_E2E_PROFILE: "approved-ui",
    TYPINGKING_E2E_SUPPRESS_STARTUP_DIALOGS: "1",
    ...(options.mode === "automated" ? { TYPINGKING_E2E_HIDE_WINDOW: "1" } : {})
  };
}
