import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright-core";

type AppVariant =
  | "typing"
  | "typing-leaderboard"
  | "ai"
  | "ai-leaderboard"
  | "practice"
  | "practice-leaderboard";

interface ExeCase {
  file: string;
  variant: AppVariant;
  title: string;
  mode: "game" | "leaderboard";
}

const root = process.cwd();
const releaseRoot = path.join(root, "release");
const artifactRoot = path.join(root, "test_artifacts", "packaged_runtime");
const cases: ExeCase[] = [
  { file: "일잘러 타자왕은 누구.exe", variant: "typing", title: "일잘러 타자왕은 누구!?", mode: "game" },
  { file: "AI 타자왕을 이겨라.exe", variant: "ai", title: "AI 타자왕을 이겨라!", mode: "game" },
  {
    file: "일잘러 타자왕은 누구_리더보드.exe",
    variant: "typing-leaderboard",
    title: "일잘러 타자왕은 누구!? 리더보드",
    mode: "leaderboard"
  },
  {
    file: "AI 타자왕을 이겨라_리더보드.exe",
    variant: "ai-leaderboard",
    title: "AI 타자왕을 이겨라! 리더보드",
    mode: "leaderboard"
  },
  { file: "타자왕 연습모드.exe", variant: "practice", title: "타자왕 연습모드", mode: "game" },
  {
    file: "타자왕 연습모드_리더보드.exe",
    variant: "practice-leaderboard",
    title: "타자왕 연습모드 리더보드",
    mode: "leaderboard"
  }
];

function cleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function snapshotReleaseRuntimeFiles(): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const relative of [
    "config/config.json",
    "config/config.practice.json",
    "data/records.csv",
    "data/admin_audit.csv",
    "data/stage_texts.csv"
  ]) {
    const file = path.join(releaseRoot, relative);
    assert.ok(fs.existsSync(file), `배포 템플릿 파일 누락: ${relative}`);
    snapshot.set(relative, sha256(file));
  }
  return snapshot;
}

async function runCase(testCase: ExeCase): Promise<Record<string, unknown>> {
  const exePath = path.join(releaseRoot, testCase.file);
  assert.ok(fs.existsSync(exePath), `EXE 누락: ${testCase.file}`);
  const localAppData = path.join(artifactRoot, testCase.variant, "LocalAppData");
  const appData = path.join(artifactRoot, testCase.variant, "RoamingAppData");
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });

  const app = await electron.launch({
    executablePath: exePath,
    env: {
      ...process.env,
      APP_VARIANT: testCase.variant,
      LOCALAPPDATA: localAppData,
      APPDATA: appData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
    },
    timeout: 30000
  });

  try {
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean((window as any).typingKing), undefined, { timeout: 15000 });
    const bootstrap = await page.evaluate(async () => (window as any).typingKing.getBootstrap());
    assert.equal(bootstrap.ok, true);
    assert.equal(bootstrap.data.variant, testCase.variant);
    assert.equal(bootstrap.data.mode, testCase.mode);
    assert.equal(await page.title(), testCase.title);
    const assetUrl = new URL(String(bootstrap.data.assetBaseUrl));
    assert.equal(path.basename(decodeURIComponent(assetUrl.pathname)), "assets", "배포 에셋 경로가 assets를 가리키지 않음");
    const firstImage = page.locator("img").first();
    await firstImage.waitFor({ state: "visible", timeout: 15000 });
    assert.equal(
      await firstImage.evaluate((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0),
      true,
      "배포 이미지가 실제로 로드되지 않음"
    );

    const runtimeRoot = path.join(localAppData, "ThePMD", "TypingKing2026");
    const expectedConfig = path.join(
      runtimeRoot,
      "config",
      testCase.variant.startsWith("practice") ? "config.practice.json" : "config.json"
    );
    assert.ok(fs.existsSync(expectedConfig), `AppData 설정 파일 미생성: ${expectedConfig}`);
    assert.ok(fs.existsSync(path.join(runtimeRoot, "data", "stage_texts.csv")), "AppData 문구 파일 미생성");
    assert.equal(fs.existsSync(path.join(releaseRoot, "local_queue")), false);

    return {
      exe: testCase.file,
      variant: bootstrap.data.variant,
      mode: bootstrap.data.mode,
      title: await page.title(),
      runtimeRoot,
      assetBaseUrl: bootstrap.data.assetBaseUrl
    };
  } finally {
    await app.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  cleanDir(artifactRoot);
  const before = snapshotReleaseRuntimeFiles();
  const results: Array<Record<string, unknown>> = [];
  for (const testCase of cases) results.push(await runCase(testCase));
  const after = snapshotReleaseRuntimeFiles();
  for (const [relative, hash] of before) {
    assert.equal(after.get(relative), hash, `EXE 실행 중 release 템플릿 변경: ${relative}`);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    pass: results.length,
    fail: 0,
    releaseTemplatesUnchanged: true,
    results
  };
  fs.writeFileSync(path.join(artifactRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
