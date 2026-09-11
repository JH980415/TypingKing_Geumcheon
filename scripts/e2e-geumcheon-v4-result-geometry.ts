import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "csv-parse/sync";
import { chromium, type Page } from "playwright-core";
import { ChallengeSummary } from "../apps/typing-game/src/AIChallengeGame";
import { loadEventProfile } from "../shared/events/eventProfile";
import { calculateCurrentCpm, countConvertedTypingUnits, countTypeableChars } from "../shared/utils/typing";

type DisplayMetrics = [string, string, string];
type GeometryOptions = {
  outputDir: string;
  evidenceKind: "source-component-browser" | "final-packaged-exe-display-fixture";
};

function validMaxima(): DisplayMetrics[] {
  const aiConfig = loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json")).aiChallenge.official;
  const rows = parse(fs.readFileSync(path.resolve("events/geumcheon-2026/stage_texts.csv"), "utf8"), { columns: true }) as Array<{ text: string; stage_number: string; is_active: string }>;
  return [1, 2, 3].map((stage) => {
    const texts = rows.filter((row) => row.stage_number === String(stage) && row.is_active === "true").map((row) => row.text);
    const range = aiConfig.stageSpeedRanges[`stage${stage}` as "stage1" | "stage2" | "stage3"];
    return [
      (Math.max(...texts.map((text) => countConvertedTypingUnits(text) / range.min * 60000 + aiConfig.aiEnterDelayMs)) / 1000).toFixed(2),
      String(Math.max(...texts.map(countTypeableChars))),
      String(Math.max(...texts.map((text) => calculateCurrentCpm(text, 500, text))))
    ];
  });
}

/** Runs only after the genuine final result is present. It changes displayed text and restores it.
 * No app APIs, local records, credentials, or NAS calls are made. Keep evidence marked display fixture. */
export async function exerciseV4ResultGeometry(page: Page, options: GeometryOptions) {
  fs.mkdirSync(options.outputDir, { recursive: true });
  await page.locator(".r7-stage-result-card").first().waitFor({ state: "visible" });
  const original = await page.locator(".r7-stage-metric-row").evaluateAll((rows) =>
    rows.map((row) => [...row.children].map((child) => child.textContent ?? "")));
  await page.screenshot({ path: path.join(options.outputDir, "before-fixtures.png"), fullPage: true });
  assert.equal(original.length, 6, "the three final cards must each expose two shared metric rows");
  const times = ["0.00", "7.00", "12.34", "99.99"];
  const chars = ["0", "6", "13", "99"];
  const cpms = ["0", "9", "57", "257"];
  const cases: Array<{ name: string; user: DisplayMetrics; ai: DisplayMetrics }> = [];
  for (let t = 0; t < 4; t++) for (let c = 0; c < 4; c++) for (let p = 0; p < 4; p++) {
    cases.push({ name: `matrix-${t}${c}${p}`, user: [times[t], chars[c], cpms[p]],
      ai: [times[3 - t], chars[3 - c], cpms[3 - p]] });
  }
  const maxima = validMaxima();
  for (let stage = 0; stage < 3; stage++) {
    cases.push({ name: `stage-${stage + 1}-valid-maxima`, user: maxima[stage], ai: ["0.00", "0", "0"] });
    cases.push({ name: `stage-${stage + 1}-reversed-maxima`, user: ["0.00", "0", "0"], ai: maxima[stage] });
  }
  const samples: any[] = [];
  try {
    for (const fixture of cases) {
      await page.locator(".r7-stage-metric-row").evaluateAll((rows, values) => {
        rows.forEach((row, index) => {
          const metrics = index % 2 === 0 ? values.user : values.ai;
          [1, 4, 7].forEach((column, metric) => { row.children[column].textContent = metrics[metric]; });
        });
      }, fixture);
      const cards = await page.locator(".r7-stage-result-card").evaluateAll((elements) => elements.map((card) => {
        const rows = [...card.querySelectorAll<HTMLElement>(".r7-stage-metric-row")];
        const geometry = { rect(element: Element | Range) {
          const box = element.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, centerX: (box.left + box.right) / 2 };
        } };
        const cells = rows.map((row) => [...row.children].map((child) => {
          const range = document.createRange(); range.selectNodeContents(child);
          return { text: child.textContent, cell: geometry.rect(child), ink: geometry.rect(range), align: getComputedStyle(child).textAlign };
        }));
        const cardBox = geometry.rect(card);
        return {
          card: cardBox, cells,
          dividerDeltas: [3, 6].map((column) => Math.abs(cells[0][column].cell.centerX - cells[1][column].cell.centerX)),
          unitDeltas: [2, 5, 8].map((column) => Math.abs(cells[0][column].cell.left - cells[1][column].cell.left)),
          problems: cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => {
            const problems: string[] = [];
            if (cell.ink.left < cardBox.left - 1 || cell.ink.right > cardBox.right + 1 || cell.ink.top < cardBox.top - 1 || cell.ink.bottom > cardBox.bottom + 1) problems.push(`row ${rowIndex} column ${column} outside card`);
            if (cell.ink.left < cell.cell.left - 1 || cell.ink.right > cell.cell.right + 1) problems.push(`row ${rowIndex} column ${column} clipped`);
            if (column && row[column - 1].ink.right > cell.ink.left + 1) problems.push(`row ${rowIndex} column ${column} overlaps previous`);
            if ([1, 4, 7].includes(column) && cell.align !== "right") problems.push(`row ${rowIndex} column ${column} not right aligned`);
            return problems;
          }))
        };
      }));
      samples.push({ fixture, cards });
      if (fixture.name === "matrix-333" || fixture.name.endsWith("valid-maxima")) {
        await page.screenshot({ path: path.join(options.outputDir, `${fixture.name}.png`), fullPage: true });
      }
    }
  } finally {
    await page.locator(".r7-stage-metric-row").evaluateAll((rows, values) => {
      rows.forEach((row, i) => [...row.children].forEach((cell, j) => { cell.textContent = values[i][j]; }));
    }, original);
  }
  const failures = samples.flatMap((sample) => sample.cards.flatMap((card: any, index: number) => [
    ...card.problems.map((problem: string) => `${sample.fixture.name} card ${index + 1}: ${problem}`),
    ...card.dividerDeltas.filter((delta: number) => delta > 1).map((delta: number) => `${sample.fixture.name}: divider delta ${delta}`),
    ...card.unitDeltas.filter((delta: number) => delta > 1).map((delta: number) => `${sample.fixture.name}: unit delta ${delta}`)
  ]));
  const report = {
    evidenceKind: options.evidenceKind, displayOnly: true, nasWrites: 0,
    viewport: page.viewportSize(), matrixCases: cases.length, cardsMeasured: samples.length * 3,
    maximumBasis: "Current active stage catalog and Geumcheon official AI config: per-stage longest AI duration at configured minimum speed plus Enter delay; largest character count; participant CPM at the existing 500 ms display threshold. These are display bounds, not a synthetic server record.",
    validMaxima: maxima,
    maxDividerCenterDeltaPx: Math.max(...samples.flatMap((sample) => sample.cards.flatMap((card: any) => card.dividerDeltas))),
    maxUnitLeftDeltaPx: Math.max(...samples.flatMap((sample) => sample.cards.flatMap((card: any) => card.unitDeltas))),
    failures, samples
  };
  fs.writeFileSync(path.join(options.outputDir, "geometry.json"), JSON.stringify(report, null, 2));
  assert.equal(failures.length, 0, failures.slice(0, 12).join("\n"));
  return { evidenceKind: report.evidenceKind, matrixCases: cases.length, cardsMeasured: report.cardsMeasured,
    maxDividerCenterDeltaPx: report.maxDividerCenterDeltaPx, maxUnitLeftDeltaPx: report.maxUnitLeftDeltaPx, problems: failures.length };
}

async function main() {
  const outputRoot = path.resolve(process.env.TYPINGKING_V4_GEOMETRY_OUTPUT ?? ".superpowers/sdd/2026-09-12-rental-v4/ui-geometry");
  const profile = loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json"));
  const baseBattle = { text: "가".repeat(13), userTimeMs: 7000, userCpm: 257, userAccuracy: 100, aiTimeMs: 12340,
    aiElapsedMs: 12340, aiCpm: 57, plannedAiCpm: 300, aiTypedUnits: 6, aiTypedChars: 6, result: "USER_WIN" as const, userInput: "가".repeat(13) };
  const markup = renderToStaticMarkup(createElement(ChallengeSummary, {
    battles: [1, 2, 3].map((stage) => ({ ...baseBattle, stage })), row: null,
    participant: { name: "표시 검수", phone1: "010", phone2: "0000", phone3: "0000", birthYear: "2000", birthMonth: "1", birthDay: "1", privacyAgreedAt: "2026-09-12T00:00:00.000Z" },
    assetBaseUrl: pathToFileURL(path.resolve("assets")).href, eventProfile: profile
  })).replace(/(?:src|href)="(file:[^"]+)"/g, (match, source: string) => {
    const file = fileURLToPath(source);
    return fs.existsSync(file) ? match.replace(source, `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`) : match;
  });
  const css = ["apps/shell/src/styles.css", "apps/typing-game/src/r7-geumcheon.css", "apps/leaderboard/src/r7-geumcheon.css"]
    .map((file) => fs.readFileSync(path.resolve(file), "utf8")).join("\n");
  const browser = await chromium.launch({ executablePath: process.env.TYPINGKING_V4_BROWSER_EXE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
  try {
    for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
      const page = await browser.newPage({ viewport });
      await page.setContent(`<!doctype html><html data-event-profile="geumcheon-2026"><head><meta charset="utf-8"><style>${css}</style></head><body><main class="app game-app"><section class="challenge-result-panel r7-final-victory">${markup}</section></main></body></html>`);
      await page.evaluate(() => document.fonts.ready);
      const result = await exerciseV4ResultGeometry(page, { outputDir: path.join(outputRoot, `${viewport.width}x${viewport.height}`), evidenceKind: "source-component-browser" });
      console.log(JSON.stringify({ viewport, ...result }));
      await page.close();
    }
  } finally { await browser.close(); }
}
if (path.basename(process.argv[1] ?? "") === "e2e-geumcheon-v4-result-geometry.ts") {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
