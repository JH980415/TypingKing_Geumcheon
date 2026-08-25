import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import type { Page } from "playwright-core";

type Variant = "typing" | "ai";
type Verdict = "PASS" | "PARTIAL" | "FAIL";

type PlayRow = {
  screen: string;
  resolution: string;
  scale: string;
  horizontalOverflow: boolean;
  verticalScroll: boolean;
  clippedBoxes: string[];
  buttonsReachable: boolean;
  verdict: Verdict;
  screenshot: string;
  note: string;
};

const root = process.cwd();
const artifactRoot = path.resolve("test_artifacts", "play_flow_screenshots");
const reportPath = path.join(artifactRoot, "report_play_flow_overflow.md");
const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const mainJs = path.join(root, "dist-electron", "electron", "main.js");
const sharedOneDriveRoot = path.join(artifactRoot, "shared_onedrive");
const sizes = [
  { width: 1366, height: 768, scales: [1, 1.25, 1.5] },
  { width: 1600, height: 900, scales: [1] },
  { width: 1920, height: 1080, scales: [1] },
  { width: 2560, height: 1440, scales: [1] },
  { width: 3440, height: 1440, scales: [1] }
];
const requestedVariant = process.env.E2E_PLAY_VARIANT as Variant | undefined;
const requestedResolution = process.env.E2E_PLAY_RESOLUTION;
const rows: PlayRow[] = [];

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
  await page.waitForTimeout(500);
}

async function setupOneDrive(page: Page, variant: Variant): Promise<void> {
  await page.evaluate(
    async ({ oneDriveRoot, variantName }) => {
      const api = (window as any).typingKing;
      await api.updateOneDriveSettings({
        syncMode: "onedrive_manual",
        pcRole: "player",
        pcId: variantName === "ai" ? "PCAI" : "PCTYPING",
        oneDriveRoot,
        recordBaseFolderName: "PlayFlow_UI",
        dayNo: 1,
        roundNo: 1
      });
      await api.validateOneDriveSetup();
    },
    { oneDriveRoot: sharedOneDriveRoot, variantName: variant }
  );
}

async function fillEntryForm(page: Page): Promise<void> {
  await page.locator(".entry-panel .field input").first().fill("테스트");
  await page.locator(".phone-row select").selectOption("010");
  await page.locator(".phone-row input").nth(0).fill("1234");
  await page.locator(".phone-row input").nth(1).fill("5678");
  await page.locator(".birth-row select").nth(0).selectOption("2000");
  await page.locator(".birth-row select").nth(1).selectOption("1");
  await page.locator(".birth-row select").nth(2).selectOption("1");
  await page.locator(".check-line input").check();
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
      return rect.right >= 0 && rect.left <= window.innerWidth && rect.bottom >= 0 && rect.top <= window.innerHeight;
    });
    return {
      scrollWidth: Math.max(doc.scrollWidth, body?.scrollWidth ?? 0),
      clientWidth: doc.clientWidth,
      scrollHeight: Math.max(doc.scrollHeight, body?.scrollHeight ?? 0),
      clientHeight: doc.clientHeight,
      clippedBoxes: Array.from(
        document.querySelectorAll(".target-line, .input-echo, .duel-target, .duel-input-highlight, .ai-typing-line")
      )
        .map((element) => {
          const htmlElement = element as HTMLElement;
          const containerRect = htmlElement.getBoundingClientRect();
          const textRects = Array.from(htmlElement.querySelectorAll("span.correct, span.wrong, span.pending"))
            .map((span) => (span as HTMLElement).getBoundingClientRect())
            .filter((rect) => rect.width > 0 && rect.height > 0);
          const label =
            htmlElement.classList.contains("target-line")
              ? "preview"
              : htmlElement.classList.contains("input-echo") || htmlElement.classList.contains("duel-input-highlight")
                ? "input"
                : htmlElement.classList.contains("duel-target")
                  ? "duel-preview"
                  : "ai-input";
          const clipped =
            textRects.length > 0 &&
            (Math.max(...textRects.map((rect) => rect.bottom)) > containerRect.bottom - 3 ||
              Math.min(...textRects.map((rect) => rect.top)) < containerRect.top + 3);
          return clipped ? label : "";
        })
        .filter(Boolean),
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
  note = "",
  waitMs = 350,
  animations: "allow" | "disabled" = "disabled"
): Promise<void> {
  if (waitMs > 0) await page.waitForTimeout(waitMs);
  const m = await metrics(page);
  const dir = path.join(artifactRoot, `${width}x${height}_${Math.round(scale * 100)}`, variant);
  ensureDir(dir);
  const screenshot = path.join(dir, `${safeName(screenName)}.png`);
  let screenshotNote = note;
  try {
    await page.screenshot({ path: screenshot, fullPage: false, timeout: 8000, animations });
  } catch (pageError) {
    const session = await page.context().newCDPSession(page);
    const image = await session.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(screenshot, Buffer.from(image.data, "base64"));
    screenshotNote = `${note}; CDP screenshot fallback used: ${pageError instanceof Error ? pageError.message.split("\n")[0] : String(pageError)}`;
  }
  const horizontalOverflow = m.scrollWidth > m.clientWidth + 4;
  const verticalScroll = m.scrollHeight > m.clientHeight + 8;
  const clippedBoxes = Array.from(new Set(m.clippedBoxes));
  const verdict: Verdict =
    horizontalOverflow || clippedBoxes.length > 0 || !m.buttonsReachable ? "FAIL" : verticalScroll ? "PARTIAL" : "PASS";
  rows.push({
    screen: `${variant} ${screenName}`,
    resolution: `${width}x${height}`,
    scale: `${Math.round(scale * 100)}% substitute`,
    horizontalOverflow,
    verticalScroll,
    clippedBoxes,
    buttonsReachable: m.buttonsReachable,
    verdict,
    screenshot,
    note: screenshotNote
  });
}

async function currentTarget(page: Page): Promise<string> {
  return page.locator(".target-line, .duel-target").first().evaluate((element) =>
    (element.textContent ?? "").replace(/\u00a0/g, " ").trim()
  );
}

async function fillCurrentTarget(page: Page): Promise<void> {
  const target = await currentTarget(page);
  await page.locator("textarea").first().fill(target);
}

async function fillAlmostCurrentTarget(page: Page): Promise<void> {
  const target = await currentTarget(page);
  const chars = Array.from(target);
  const partial = chars.slice(0, Math.max(0, chars.length - 1)).join("");
  await page.locator("textarea").first().fill(partial);
}

async function finishTypingFlow(page: Page, variant: Variant, width: number, height: number, scale: number): Promise<void> {
  await page.locator(".entry-panel .button-row .primary-button").first().click();
  if (variant === "typing") {
    await page.locator(".game-stage").waitFor({ timeout: 15000 });
    await page.locator(".countdown-overlay", { hasText: "START" }).waitFor({ timeout: 7000 });
    await capture(page, variant, width, height, scale, "countdown-start", "Normal START countdown overlay", 0, "allow");
    await page.waitForTimeout(700);
    await capture(page, variant, width, height, scale, "play", "Normal gameplay screen after countdown");
    for (let stage = 0; stage < 3; stage += 1) {
      await page.waitForTimeout(stage === 0 ? 0 : 3600);
      if (stage === 2) {
        await fillAlmostCurrentTarget(page);
        await capture(
          page,
          variant,
          width,
          height,
          scale,
          "stage-3-partial-input",
          "Normal stage 3 with preview and input both spanning three lines"
        );
      }
      await fillCurrentTarget(page);
      if (stage < 2) {
        await page.waitForTimeout(900);
      }
    }
    await page.locator(".result-panel").waitFor({ timeout: 15000 });
    await capture(page, variant, width, height, scale, "result", "Normal result screen");
    return;
  }

  await page.locator(".challenge-screen").waitFor({ timeout: 15000 });
  await page.locator(".countdown-overlay", { hasText: "START" }).waitFor({ timeout: 7000 });
  await capture(page, variant, width, height, scale, "countdown-start", "AI START countdown overlay", 0, "allow");
  await page.waitForTimeout(700);
  await capture(page, variant, width, height, scale, "play", "AI challenge gameplay screen after countdown");
  for (let stage = 0; stage < 3; stage += 1) {
    await page.waitForTimeout(stage === 0 ? 0 : 3600);
    if (stage === 2) {
      await fillAlmostCurrentTarget(page);
      await capture(
        page,
        variant,
        width,
        height,
        scale,
        "stage-3-partial-input",
        "AI challenge stage 3 with preview and input both spanning three lines"
      );
    }
    await fillCurrentTarget(page);
    await page.locator(".challenge-modal").waitFor({ timeout: 15000 });
    await capture(page, variant, width, height, scale, `stage-${stage + 1}-popup`, "AI challenge stage result popup");
    await page.locator(".challenge-modal .primary-button").first().click();
  }
  await page.locator(".challenge-result-panel").waitFor({ timeout: 15000 });
  await capture(page, variant, width, height, scale, "result", "AI challenge final result screen");
}

async function runOne(variant: Variant, width: number, height: number, scale: number): Promise<void> {
  const runtimeRoot = path.join(
    artifactRoot,
    "runtime",
    `${variant}_${width}x${height}_${Math.round(scale * 100)}`
  );
  ensureDir(runtimeRoot);
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
    const bw = await app.browserWindow(page);
    await bw.evaluate((window, size) => {
      window.setSize(size.width, size.height);
      window.center();
    }, { width, height });
    await bw.evaluate((window, zoom) => {
      window.webContents.setZoomFactor(1 / zoom);
    }, scale);
    await waitForStable(page);
    await setupOneDrive(page, variant);
    await fillEntryForm(page);
    await finishTypingFlow(page, variant, width, height, scale);
  } finally {
    await app.close().catch(() => undefined);
  }
}

function writeReport(): void {
  const lines: string[] = [];
  lines.push("# Gameplay and result screen overflow verification");
  lines.push("");
  lines.push("- Method: actual Electron click flow with temporary OneDrive root.");
  lines.push("- 125%/150% are CSS zoom substitutes, not real Windows display scaling.");
  lines.push("");
  lines.push("| Screen | Resolution | Scale | Horizontal overflow | Vertical scroll | Text clipped | Buttons reachable | Verdict | Screenshot | Note |");
  lines.push("| -- | --: | --: | -- | -- | -- | -- | -- | -- | -- |");
  for (const row of rows) {
    lines.push(
      `| ${row.screen} | ${row.resolution} | ${row.scale} | ${row.horizontalOverflow ? "YES" : "NO"} | ${row.verticalScroll ? "YES" : "NO"} | ${row.clippedBoxes.length > 0 ? row.clippedBoxes.join(", ") : "NO"} | ${row.buttonsReachable ? "YES" : "NO"} | ${row.verdict} | ${row.screenshot} | ${row.note} |`
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
  for (const size of sizes.filter((candidate) => !requestedResolution || `${candidate.width}x${candidate.height}` === requestedResolution)) {
    for (const scale of size.scales) {
      for (const variant of (["typing", "ai"] as Variant[]).filter((candidate) => !requestedVariant || candidate === requestedVariant)) {
        try {
          await runOne(variant, size.width, size.height, scale);
        } catch (error) {
          rows.push({
            screen: `${variant} play-flow`,
            resolution: `${size.width}x${size.height}`,
            scale: `${Math.round(scale * 100)}% substitute`,
            horizontalOverflow: false,
            verticalScroll: false,
            clippedBoxes: [],
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
