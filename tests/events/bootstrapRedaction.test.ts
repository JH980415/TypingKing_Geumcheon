import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { createBootstrapData } from "../../shared/events/bootstrapData";
import { loadEventProfile } from "../../shared/events/eventProfile";

test("renderer bootstrap never exposes the configured administrator password", () => {
  const config = { ...DEFAULT_CONFIG, adminPassword: "0208" };
  const bootstrap = createBootstrapData({
    config,
    assetBaseUrl: "file:///assets",
    notices: [],
    mode: "game",
    variant: "ai",
    eventProfile: loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json")),
  });

  assert.equal(bootstrap.config.adminPassword, "");
  assert.equal(config.adminPassword, "0208");
});
