import path from "node:path";

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

export function resolveGeumcheonE2eArtifactRoot(
  projectRoot: string,
  defaultDirectoryName: string,
  override?: string
): string {
  const testArtifactsRoot = path.resolve(projectRoot, "test_artifacts");
  const requested = override?.trim();
  const resolved = path.resolve(
    projectRoot,
    requested || path.join("test_artifacts", defaultDirectoryName)
  );
  if (
    resolved === testArtifactsRoot
    || !resolved.startsWith(`${testArtifactsRoot}${path.sep}`)
  ) {
    throw new Error("Refusing E2E artifact root outside test_artifacts");
  }
  if (path.dirname(resolved) !== testArtifactsRoot) {
    throw new Error("E2E artifact root must be a direct child of test_artifacts");
  }
  return resolved;
}

export function resolveGeumcheonR2ReleaseRoot(projectRoot: string, override: string): string {
  const releaseRoot = path.resolve(projectRoot, "Codex", "Outputs", "R2", "01_Release");
  const requested = override.trim();
  const resolved = path.resolve(projectRoot, requested);
  if (resolved === releaseRoot) {
    throw new Error("R2 release output must be a child directory");
  }
  if (!resolved.startsWith(`${releaseRoot}${path.sep}`)) {
    throw new Error("Refusing R2 release root outside Codex/Outputs/R2/01_Release");
  }
  if (path.dirname(resolved) !== releaseRoot) {
    throw new Error("R2 release root must be a direct child of Codex/Outputs/R2/01_Release");
  }
  return resolved;
}

export function resolveGeumcheonReleaseRoot(projectRoot: string, override?: string): string {
  const requested = override?.trim();
  return requested
    ? resolveGeumcheonR2ReleaseRoot(projectRoot, requested)
    : path.resolve(projectRoot, "release-geumcheon");
}