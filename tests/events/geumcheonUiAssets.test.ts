import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LeaderboardApp } from "../../apps/leaderboard/src/LeaderboardApp";
import * as typingGameModule from "../../apps/typing-game/src/TypingGameApp";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { createBootstrapData } from "../../shared/events/bootstrapData";
import { loadEventProfile } from "../../shared/events/eventProfile";
import { resolveAiBossResultAsset } from "../../shared/events/types";

const geumcheonProfile = loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json"));

function geumcheonBootstrap(variant: "ai" | "ai-leaderboard", mode: "game" | "leaderboard") {
  return createBootstrapData({
    config: DEFAULT_CONFIG,
    assetBaseUrl: "file:///resources/assets",
    notices: [],
    mode,
    variant,
    eventProfile: geumcheonProfile
  });
}

test("groups the approved Geumcheon title and exact subtitle in one centered left title group", () => {
  const html = renderToStaticMarkup(
    createElement(typingGameModule.TypingGameApp, {
      bootstrap: geumcheonBootstrap("ai", "game")
    })
  );

  assert.match(html, /bg_leaderboard_03_typing_hall_of_fame\.png/);
  assert.match(html, /ai_타자왕_금나래의_도전\.png/);
  assert.match(html, /robot_03_speed_champion\.png/);
  assert.doesNotMatch(html, /ai_title_(compact|oneline_trimmed)\.png|ai_challenge_title\.png/);

  const leftTitleGroup = html.match(/<div class="left-title-group">[\s\S]*?<\/div>/)?.[0];
  assert.ok(leftTitleGroup, "approved title and subtitle must share .left-title-group");
  assert.match(leftTitleGroup, /geumcheon-main-title-image/);
  assert.match(leftTitleGroup, />3개의 스테이지에서 금나래보다<br\/>먼저 정확하게 입력하세요\.<\/p>/);
});

test("replaces the Geumcheon right-panel mode card with one event copy above the participant form", () => {
  const html = renderToStaticMarkup(
    createElement(typingGameModule.TypingGameApp, {
      bootstrap: geumcheonBootstrap("ai", "game")
    })
  );

  const entryPanel = html.match(/<form class="entry-panel"[^>]*>[\s\S]*?<\/form>/)?.[0];
  assert.ok(entryPanel, "entry panel must render");
  assert.match(entryPanel, /^<form class="entry-panel"[^>]*><div class="entry-event-copy">/);
  assert.equal((entryPanel.match(/class="entry-event-copy"/g) ?? []).length, 1);
  assert.match(entryPanel, /2026 G-Science Festival/);
  assert.match(entryPanel, /AI와 소통하는 활기찬 미래 금천/);
  assert.match(entryPanel, /class="entry-form-group"/);
  assert.doesNotMatch(entryPanel, /mode-selector|mode-card|게임 모드/);
});

test("uses the user-approved Geumcheon title and refreshed stage badges", () => {
  assert.equal(
    geumcheonProfile.assets.eventTitle,
    "assets/ai_타자왕_금나래의_도전.png"
  );
  assert.deepEqual(geumcheonProfile.assets.stageBadges, [
    "assets/ai_challenge/stage_badge_1_r203.png",
    "assets/ai_challenge/stage_badge_2_r203.png",
    "assets/ai_challenge/stage_badge_3_r203.png"
  ]);
});

test("maps the approved Geumcheon result art by winner and stage", () => {
  assert.equal(resolveAiBossResultAsset(geumcheonProfile, "AI_WIN", 1), "assets/금나래 승리.png");
  assert.deepEqual(geumcheonProfile.assets.aiBossDefeats, [
    "assets/금나래패배_스테이지1.png",
    "assets/금나래패배_스테이지2.png",
    "assets/금나래패배_스테이지3.png"
  ]);
  for (const stage of [1, 2, 3] as const) {
    assert.equal(resolveAiBossResultAsset(geumcheonProfile, "USER_WIN", stage), `assets/금나래패배_스테이지${stage}.png`);
  }
});

test("omits the duplicate brand header on Geumcheon AI and result screens", () => {
  const shouldShowBrandHeader = (typingGameModule as typeof typingGameModule & {
    shouldShowBrandHeader?: (profileId: string, screen: "start" | "game" | "ai" | "result") => boolean;
  }).shouldShowBrandHeader;
  assert.equal(typeof shouldShowBrandHeader, "function");
  assert.equal(shouldShowBrandHeader?.("geumcheon-2026", "ai"), false);
  assert.equal(shouldShowBrandHeader?.("geumcheon-2026", "result"), false);
  assert.equal(shouldShowBrandHeader?.("skillup-2026", "ai"), true);
});

test("stacks multiple permanent system notices without dropping fallback errors", () => {
  const html = renderToStaticMarkup(createElement(typingGameModule.TypingGameApp, {
    bootstrap: createBootstrapData({ config: DEFAULT_CONFIG, assetBaseUrl: "file:///resources/assets", notices: ["기본 문구로 복구했습니다.", "기본 설정으로 복구했습니다."], mode: "game", variant: "ai", eventProfile: geumcheonProfile })
  }));
  assert.match(html, /class="system-notices"/);
  assert.equal((html.match(/class="system-notice"/g) ?? []).length, 2);
  assert.match(html, /기본 문구로 복구했습니다/);
  assert.match(html, /기본 설정으로 복구했습니다/);
});

test("hides routine Geumcheon first-run creation notices but keeps real stage fallback errors", () => {
  const html = renderToStaticMarkup(createElement(typingGameModule.TypingGameApp, {
    bootstrap: createBootstrapData({ config: DEFAULT_CONFIG, assetBaseUrl: "file:///resources/assets", notices: [
      "설정 파일이 없어 기본 설정으로 생성합니다.",
      "기록 파일이 없어 새로 생성합니다.",
      "문구 파일을 읽지 못해 기본 문구를 사용합니다."
    ], mode: "game", variant: "ai", eventProfile: geumcheonProfile })
  }));
  assert.doesNotMatch(html, /설정 파일이 없어|기록 파일이 없어/);
  assert.match(html, /문구 파일을 읽지 못해 기본 문구를 사용합니다/);
});

test("Geumcheon builders preserve art with R7 official and historical practice candidate metadata", () => {
  const configs = fs.readdirSync(path.resolve()).filter((name) => /^electron-builder\.geumcheon.*\.yml$/.test(name));
  assert.equal(configs.length, 8);
  for (const config of configs) {
    const source = fs.readFileSync(path.resolve(config), "utf8");
    assert.match(source, config.includes('practice') ? /typingKingReleaseCandidate: R6-v2-20260908/ : /typingKingReleaseCandidate: R7-ppt-official-only-20260909/, config);
    for (const asset of ["금나래 승리.png", "금나래패배_스테이지1.png", "금나래패배_스테이지2.png", "금나래패배_스테이지3.png"]) {
      assert.match(source, new RegExp(`assets/${asset.replace(".", "\\.")}`), `${config}: ${asset}`);
    }
  }
});

test("renders the approved Geumcheon leaderboard background", () => {
  const html = renderToStaticMarkup(
    createElement(LeaderboardApp, {
      bootstrap: geumcheonBootstrap("ai-leaderboard", "leaderboard")
    })
  );

  assert.match(html, /stage_01_03_science_classroom\.png/);
  assert.match(html, /geumcheon-leaderboard-logo/);
  assert.match(html, /ai_타자왕_금나래의_도전\.png/);
});

test("uses the play background for every active or result game screen", () => {
  const resolveTypingScreenBackground = (
    typingGameModule as typeof typingGameModule & {
      resolveTypingScreenBackground?: (
        screen: "start" | "game" | "ai" | "result",
        assets: typeof geumcheonProfile.assets
      ) => string;
    }
  ).resolveTypingScreenBackground;

  assert.equal(typeof resolveTypingScreenBackground, "function");
  assert.equal(
    resolveTypingScreenBackground?.("start", geumcheonProfile.assets),
    "assets/bg_leaderboard_03_typing_hall_of_fame.png"
  );
  for (const screen of ["game", "ai", "result"] as const) {
    assert.equal(
      resolveTypingScreenBackground?.(screen, geumcheonProfile.assets),
      "assets/bg_main_03_geumcheon_data_city.png"
    );
  }
});

test("reserves enough 1080p vertical space for all five guide lines", () => {
  const styles = fs.readFileSync(path.resolve("apps/shell/src/styles.css"), "utf8");
  const largeViewportRules = styles.split("@media (min-width: 1401px) and (min-height: 801px) {")[1];

  assert.ok(largeViewportRules, "large viewport rules must exist");
  assert.match(largeViewportRules, /geumcheon-main-robot/);
  assert.equal(largeViewportRules.includes("calc(100vh - 646px), 240px"), true);
});
