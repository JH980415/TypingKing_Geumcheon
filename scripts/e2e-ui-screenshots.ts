import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import type { Page } from "playwright-core";

type Variant = "typing" | "ai" | "typing-leaderboard" | "ai-leaderboard" | "practice" | "practice-leaderboard";
type UiRow = {
  screen: string;
  resolution: string;
  scale: string;
  horizontalOverflow: boolean;
  verticalScroll: boolean;
  buttonsReachable: boolean;
  verdict: "PASS" | "PARTIAL" | "FAIL";
  screenshot: string;
  note: string;
};

const root = process.cwd();
function resolveAdminPassword(): string {
  const configPath = path.join(root, "config", "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as { adminPassword?: unknown };
      if (typeof parsed.adminPassword === "string" && parsed.adminPassword) return parsed.adminPassword;
    } catch {
      // Fall back to the explicit test password or the safe repository placeholder.
    }
  }
  return process.env.TYPINGKING_TEST_ADMIN_PASSWORD || "CHANGE_ME_BEFORE_EVENT";
}
const adminPassword = resolveAdminPassword();
const artifactRoot = path.resolve("test_artifacts", "ui_screenshots");
const reportPath = path.join(artifactRoot, "report_ui_overflow.md");
const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const mainJs = path.join(root, "dist-electron", "electron", "main.js");

const variants: Variant[] = ["typing", "ai", "typing-leaderboard", "ai-leaderboard", "practice", "practice-leaderboard"];
const sizes = [
  { width: 1366, height: 768 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3440, height: 1440 }
];
const scaleSubstitutes = [1, 1.25, 1.5];
const rows: UiRow[] = [];

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

async function waitForStable(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(800);
}

async function metrics(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const buttons = Array.from(document.querySelectorAll("button"));
    const visibleButtons = buttons.filter((button) => {
      const rect = button.getBoundingClientRect();
      const style = window.getComputedStyle(button);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const buttonsReachable = visibleButtons.every((button) => {
      const rect = button.getBoundingClientRect();
      if (rect.right >= 0 && rect.left <= window.innerWidth && rect.bottom >= 0 && rect.top <= window.innerHeight) {
        return true;
      }

      let ancestor = button.parentElement;
      while (ancestor) {
        const ancestorRect = ancestor.getBoundingClientRect();
        const style = window.getComputedStyle(ancestor);
        const canScrollVertically =
          ancestor.scrollHeight > ancestor.clientHeight + 8 &&
          (style.overflowY === "auto" || style.overflowY === "scroll");
        const scrollContainerVisible =
          ancestorRect.right >= 0 &&
          ancestorRect.left <= window.innerWidth &&
          ancestorRect.bottom >= 0 &&
          ancestorRect.top <= window.innerHeight;
        if (canScrollVertically && scrollContainerVisible) return true;
        ancestor = ancestor.parentElement;
      }
      return false;
    });
    return {
      scrollWidth: Math.max(doc.scrollWidth, body?.scrollWidth ?? 0),
      clientWidth: doc.clientWidth,
      scrollHeight: Math.max(doc.scrollHeight, body?.scrollHeight ?? 0),
      clientHeight: doc.clientHeight,
      buttonsReachable
    };
  });
}

async function capture(
  page: Page,
  variant: Variant,
  width: number,
  height: number,
  scale: number,
  screenName: string,
  note = ""
): Promise<void> {
  await page.waitForTimeout(300);
  const m = await metrics(page);
  const dir = path.join(artifactRoot, `${width}x${height}_${Math.round(scale * 100)}`, variant);
  ensureDir(dir);
  const screenshot = path.join(dir, `${safeName(screenName)}.png`);
  let screenshotNote = note;
  try {
    await page.screenshot({ path: screenshot, fullPage: false, timeout: 8000, animations: "disabled" });
  } catch (pageError) {
    try {
      await page.locator("body").screenshot({ path: screenshot, timeout: 8000, animations: "disabled" });
      screenshotNote = `${note}; page screenshot fallback used: ${pageError instanceof Error ? pageError.message.split("\n")[0] : String(pageError)}`;
    } catch (bodyError) {
      const session = await page.context().newCDPSession(page);
      const image = await session.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      fs.writeFileSync(screenshot, Buffer.from(image.data, "base64"));
      screenshotNote = [
        note,
        `page screenshot fallback failed: ${pageError instanceof Error ? pageError.message.split("\n")[0] : String(pageError)}`,
        `body screenshot fallback failed: ${bodyError instanceof Error ? bodyError.message.split("\n")[0] : String(bodyError)}`,
        "CDP screenshot fallback used"
      ].filter(Boolean).join("; ");
    }
  }
  const horizontalOverflow = m.scrollWidth > m.clientWidth + 4;
  const verticalScroll = m.scrollHeight > m.clientHeight + 8;
  const adminScreen = screenName.includes("admin");
  const verdict = horizontalOverflow || !m.buttonsReachable ? "FAIL" : verticalScroll && !adminScreen ? "PARTIAL" : "PASS";
  rows.push({
    screen: `${variant} ${screenName}`,
    resolution: `${width}x${height}`,
    scale: `${Math.round(scale * 100)}% substitute`,
    horizontalOverflow,
    verticalScroll,
    buttonsReachable: m.buttonsReachable,
    verdict,
    screenshot,
    note: screenshotNote
  });
}

async function openAdminIfPossible(page: Page): Promise<boolean> {
  const candidates = [
    page.getByText("관리자 모드", { exact: true }),
    page.getByText("관리자", { exact: true })
  ];
  for (const candidate of candidates) {
    try {
      await candidate.first().click({ timeout: 1500 });
      await page.waitForTimeout(800);
      return true;
    } catch {
      // Try next label.
    }
  }
  return false;
}

async function authorizeAdmin(page: Page): Promise<void> {
  const protectedPanelBeforeLogin = await page.locator(".onedrive-settings-panel").count();
  if (protectedPanelBeforeLogin !== 0) {
    throw new Error("관리자 비밀번호 입력 전에 설정 화면이 노출되었습니다.");
  }
  await page.locator('input[type="password"]').first().fill(adminPassword);
  await page.getByRole("button", { name: /진입|비밀번호 확인/ }).first().click();
  await page.locator(".onedrive-settings-panel").waitFor({ timeout: 5000 });
}

async function runOne(variant: Variant, width: number, height: number, scale: number): Promise<void> {
  const app = await electron.launch({
    executablePath: electronExe,
    args: [mainJs, `--variant=${variant}`],
    env: {
      ...process.env,
      APP_VARIANT: variant,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
    }
  });
  try {
    const page = await app.firstWindow({ timeout: 15000 });
    const bw = await app.browserWindow(page);
    await bw.evaluate((window, size) => {
      window.setSize(size.width, size.height);
      window.center();
    }, { width, height });
    await bw.evaluate((window, zoom) => {
      window.webContents.setZoomFactor(1 / zoom);
    }, scale);
    await waitForStable(page);
    if (variant === "practice" && await page.locator(".mode-card").count() !== 2) {
      throw new Error("연습 플레이 화면에 일반/AI 모드 카드 2개가 표시되지 않았습니다.");
    }
    if (variant === "practice-leaderboard" && await page.locator(".ranking-table").count() !== 2) {
      throw new Error("연습 리더보드에 일반/AI 보드 2개가 표시되지 않았습니다.");
    }
    await capture(page, variant, width, height, scale, "main", "Initial app screen");

    if (width === 1366 && height === 768 && scale === 1) {
      const opened = await openAdminIfPossible(page);
      if (opened) {
        await waitForStable(page);
        await capture(page, variant, width, height, scale, "admin-login", "Admin login screen; protected settings must not be visible");
        await authorizeAdmin(page);
        if (variant === "practice") {
          const editControls = await page.locator(".admin-editor, .stage-table .mini-actions button").count();
          const readOnlyLabel = await page.getByText("읽기 전용", { exact: true }).count();
          if (editControls !== 0 || readOnlyLabel === 0) {
            throw new Error("연습모드 문구 관리가 읽기 전용 UI로 표시되지 않았습니다.");
          }
        }
        await capture(page, variant, width, height, scale, "admin-settings", "Authenticated admin settings; vertical scroll is allowed");
      } else {
        rows.push({
          screen: `${variant} admin`,
          resolution: `${width}x${height}`,
          scale: `${Math.round(scale * 100)}% substitute`,
          horizontalOverflow: false,
          verticalScroll: false,
          buttonsReachable: false,
          verdict: "PARTIAL",
          screenshot: "",
          note: "Admin button was not located by text automation"
        });
      }
    }
  } finally {
    await app.close().catch(() => undefined);
  }
}

function writeReport(): void {
  const lines: string[] = [];
  lines.push("# UI resolution and scale verification");
  lines.push("");
  lines.push("- Method: Electron window-size screenshots with CSS zoom substitutes for 125%/150% scale.");
  lines.push("- Limitation: This does not fully replace real Windows display scaling, but it catches common clipping and overflow risks.");
  lines.push("");
  lines.push("| Screen | Resolution | Scale | Horizontal overflow | Vertical scroll | Buttons reachable | Verdict | Screenshot | Note |");
  lines.push("| -- | --: | --: | -- | -- | -- | -- | -- | -- |");
  for (const row of rows) {
    lines.push(
      `| ${row.screen} | ${row.resolution} | ${row.scale} | ${row.horizontalOverflow ? "YES" : "NO"} | ${row.verticalScroll ? "YES" : "NO"} | ${row.buttonsReachable ? "YES" : "NO"} | ${row.verdict} | ${row.screenshot} | ${row.note} |`
    );
  }
  fs.writeFileSync(reportPath, `${lines.join("\n")}\n`, "utf8");
  fs.writeFileSync(
    path.join(artifactRoot, "summary.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`,
    "utf8"
  );
}

async function main() {
  cleanDir(artifactRoot);
  if (!fs.existsSync(electronExe)) throw new Error(`Electron executable not found: ${electronExe}`);
  if (!fs.existsSync(mainJs)) throw new Error(`Built Electron main not found: ${mainJs}. Run npm run build first.`);

  for (const size of sizes) {
    for (const scale of scaleSubstitutes) {
      for (const variant of variants) {
        try {
          await runOne(variant, size.width, size.height, scale);
        } catch (error) {
          rows.push({
            screen: `${variant} launch/capture`,
            resolution: `${size.width}x${size.height}`,
            scale: `${Math.round(scale * 100)}% substitute`,
            horizontalOverflow: false,
            verticalScroll: false,
            buttonsReachable: false,
            verdict: "FAIL",
            screenshot: "",
            note: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  }
  writeReport();
  const fail = rows.filter((row) => row.verdict === "FAIL").length;
  console.log(JSON.stringify({ artifactRoot, reportPath, total: rows.length, fail }, null, 2));
  if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
