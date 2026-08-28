import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LeaderboardApp } from "../../apps/leaderboard/src/LeaderboardApp";
import * as typingGameModule from "../../apps/typing-game/src/TypingGameApp";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { createBootstrapData } from "../../shared/events/bootstrapData";
import { loadEventProfile } from "../../shared/events/eventProfile";

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

test("renders the approved Geumcheon main background, title, and main robot", () => {
  const html = renderToStaticMarkup(
    createElement(typingGameModule.TypingGameApp, {
      bootstrap: geumcheonBootstrap("ai", "game")
    })
  );

  assert.match(html, /bg_leaderboard_03_typing_hall_of_fame\.png/);
  assert.match(html, /title_04_science_hologram\.png/);
  assert.match(html, /robot_03_speed_champion\.png/);
});

test("renders the approved Geumcheon leaderboard background", () => {
  const html = renderToStaticMarkup(
    createElement(LeaderboardApp, {
      bootstrap: geumcheonBootstrap("ai-leaderboard", "leaderboard")
    })
  );

  assert.match(html, /stage_01_03_science_classroom\.png/);
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
