import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { _electron as electron } from "playwright-core";

type Variant = "typing" | "ai";
type Action = "retry" | "home";

const root = process.cwd();
const artifactRoot = path.resolve("test_artifacts", "interruption_e2e");
const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const mainJs = path.join(root, "dist-electron", "electron", "main.js");

function cleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

async function waitForJson(dir: string): Promise<string> {
  const timeoutAt = Date.now() + 12000;
  while (Date.now() < timeoutAt) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
    if (files.length > 0) return path.join(dir, files[0]);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Interrupted record was not written: ${dir}`);
}

async function runScenario(variant: Variant, action: Action): Promise<Record<string, string>> {
  const scenarioRoot = path.join(artifactRoot, `${variant}_${action}`);
  const runtimeRoot = path.join(scenarioRoot, "runtime");
  const oneDriveRoot = path.join(scenarioRoot, "shared_onedrive");
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(oneDriveRoot, { recursive: true });
  const sourceConfigPath = path.join(root, "config", "config.json");
  const runtimeConfigDir = path.join(runtimeRoot, "config");
  const runtimeConfigPath = path.join(runtimeConfigDir, "config.json");
  fs.mkdirSync(runtimeConfigDir, { recursive: true });
  const sourceConfig = JSON.parse(fs.readFileSync(sourceConfigPath, "utf8")) as Record<string, unknown>;
  const adminPassword = "interruption-e2e-admin-password";
  fs.writeFileSync(
    runtimeConfigPath,
    JSON.stringify({ ...sourceConfig, adminPassword }),
    "utf8"
  );
  const app = await electron.launch({
    executablePath: electronExe,
    args: [mainJs, `--variant=${variant}`],
    env: {
      ...process.env,
      APP_VARIANT: variant,
      TYPINGKING_RUNTIME_ROOT: runtimeRoot,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
    }
  });
  try {
    const page = await app.firstWindow({ timeout: 15000 });
    await page.evaluate(async ({ rootPath, variantName, password }) => {
      const api = (window as any).typingKing;
      const authenticated = await api.validateAdmin(password, "interruption-e2e");
      if (!authenticated.ok) {
        throw new Error(authenticated.error || "E2E administrator authentication failed");
      }
      const updated = await api.updateOneDriveSettings({
        syncMode: "onedrive_manual",
        pcRole: "player",
        pcId: variantName === "ai" ? "PCAI" : "PCTYPING",
        oneDriveRoot: rootPath,
        recordBaseFolderName: "Interruption_E2E",
        dayNo: 1,
        roundNo: 1
      });
      if (!updated.ok) {
        throw new Error(updated.error || "E2E OneDrive settings update failed");
      }
      const validated = await api.validateOneDriveSetup();
      if (!validated.ok) {
        throw new Error(validated.error || "E2E OneDrive setup validation failed");
      }
    }, { rootPath: oneDriveRoot, variantName: variant, password: adminPassword });

    await page.locator(".entry-panel .field input").first().fill("Interrupt Test");
    await page.locator(".phone-row select").selectOption("010");
    await page.locator(".phone-row input").nth(0).fill("1234");
    await page.locator(".phone-row input").nth(1).fill("5678");
    await page.locator(".birth-row select").nth(0).selectOption("2000");
    await page.locator(".birth-row select").nth(1).selectOption("1");
    await page.locator(".birth-row select").nth(2).selectOption("1");
    await page.locator(".check-line input").check();
    await page.locator(".entry-panel .button-row .primary-button").first().click();

    const screen = variant === "ai" ? page.locator(".challenge-screen") : page.locator(".game-stage");
    await screen.waitFor({ timeout: 15000 });
    await page.locator(".countdown-overlay", { hasText: "START" }).waitFor({ timeout: 7000 });
    await page.waitForTimeout(700);
    const target = await page.locator(variant === "ai" ? ".duel-target" : ".target-line").first().innerText();
    await page.locator("textarea").first().fill(Array.from(target.replace(/\n/g, "")).slice(0, 4).join(""));
    await page.locator(action === "retry" ? ".game-retry-button" : ".game-main-button").click();
    await page.locator(".game-confirm-modal .primary-button").click();

    if (action === "home") {
      await page.locator(".entry-panel").waitFor({ timeout: 12000 });
    } else {
      await screen.waitFor({ timeout: 12000 });
    }

    const incoming = path.join(
      oneDriveRoot,
      "Interruption_E2E",
      "1일차",
      "1회차",
      "incoming",
      variant === "ai" ? "ai" : "typing"
    );
    const jsonPath = await waitForJson(incoming);
    return JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Record<string, string>;
  } finally {
    await app.close().catch(() => undefined);
  }
}

async function main() {
  cleanDir(artifactRoot);
  const results: Array<{ variant: Variant; action: Action; record: Record<string, string> }> = [];
  for (const variant of ["typing", "ai"] as const) {
    for (const action of ["retry", "home"] as const) {
      const record = await runScenario(variant, action);
      assert.equal(record.memo, `사용자 중단:${action === "home" ? "메인화면" : "다시하기"}`);
      assert.equal(record.result_stage, "1");
      assert.ok(Number(record.total_char_count) > 0);
      if (variant === "typing") {
        assert.equal(record.challenge_result_label, "중단");
        assert.equal(record.game_mode, "normal");
      } else {
        assert.equal(record.challenge_result_label, "중단 패배");
        assert.equal(record.game_mode, "ai_challenge");
        assert.equal(record.final_vs_ai_result, "AI_WIN");
        assert.equal(record.ai_challenge_status, "FAILED");
      }
      results.push({ variant, action, record });
    }
  }
  fs.writeFileSync(
    path.join(artifactRoot, "summary.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), scenarios: results.map(({ variant, action, record }) => ({
      variant,
      action,
      recordId: record.record_id,
      result: record.challenge_result_label,
      progress: record.participant_progress_percent,
      aiProgress: record.ai_progress_percent
    })) }, null, 2)}\n`,
    "utf8"
  );
  console.log(JSON.stringify({ artifactRoot, pass: results.length, fail: 0 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
