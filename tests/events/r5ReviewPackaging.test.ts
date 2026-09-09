import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

type BuilderConfig = {
  appId?: string;
  productName?: string;
  extraMetadata?: Record<string, unknown>;
  directories?: { output?: string };
  files?: string[];
  extraResources?: unknown[];
  asar?: boolean;
  win?: { signExecutable?: boolean; target?: Array<{ target?: string; arch?: string[] }> };
  portable?: { artifactName?: string };
};

const root = path.resolve();
const variants = [
  {
    variant: "ai",
    config: "electron-builder.geumcheon-ai-review.yml",
    sourceConfig: "electron-builder.geumcheon-ai.yml",
    appId: "com.thepmd.gscience.typingking.review.ai",
    productName: "G-Science AI 타자왕_검토용",
    output: "release-build/geumcheon-review/ai",
    artifactName: "G-Science AI 타자왕_검토용.exe"
  },
  {
    variant: "ai-leaderboard",
    config: "electron-builder.geumcheon-ai-leaderboard-review.yml",
    sourceConfig: "electron-builder.geumcheon-ai-leaderboard.yml",
    appId: "com.thepmd.gscience.typingking.review.ai-leaderboard",
    productName: "G-Science AI 타자왕_리더보드_검토용",
    output: "release-build/geumcheon-review/ai-leaderboard",
    artifactName: "G-Science AI 타자왕_리더보드_검토용.exe"
  },
  {
    variant: "practice",
    config: "electron-builder.geumcheon-practice-review.yml",
    sourceConfig: "electron-builder.geumcheon-practice.yml",
    appId: "com.thepmd.gscience.typingking.review.practice",
    productName: "G-Science AI 타자왕_연습모드_검토용",
    output: "release-build/geumcheon-review/practice",
    artifactName: "G-Science AI 타자왕_연습모드_검토용.exe"
  },
  {
    variant: "practice-leaderboard",
    config: "electron-builder.geumcheon-practice-leaderboard-review.yml",
    sourceConfig: "electron-builder.geumcheon-practice-leaderboard.yml",
    appId: "com.thepmd.gscience.typingking.review.practice-leaderboard",
    productName: "G-Science AI 타자왕_연습모드_리더보드_검토용",
    output: "release-build/geumcheon-review/practice-leaderboard",
    artifactName: "G-Science AI 타자왕_연습모드_리더보드_검토용.exe"
  }
] as const;

function readYaml(relative: string): BuilderConfig {
  return yaml.load(fs.readFileSync(path.join(root, relative), "utf8")) as BuilderConfig;
}

test("official R7 and retained historical practice builders preserve isolated strict review tuples", () => {
  const appIds = new Set<string>();
  const outputs = new Set<string>();
  const artifacts = new Set<string>();

  for (const spec of variants) {
    const config = readYaml(spec.config);
    const approved = readYaml(spec.sourceConfig);
    assert.equal(config.appId, spec.appId, spec.config);
    assert.equal(config.productName, spec.productName, spec.config);
    assert.deepEqual(config.extraMetadata, {
      author: { name: "제8회 금천과학축제" },
      typingKingEventProfile: "geumcheon-2026",
      typingKingVariant: spec.variant,
      typingKingEnvironment: "review",
      typingKingBuildId: "R2.0.4-R5",
      typingKingReleaseCandidate: spec.variant.startsWith("practice") ? "R6-v2-20260908" : "R7-ppt-official-only-20260909"
    });
    assert.equal(config.directories?.output, spec.output);
    assert.deepEqual(config.files, ["dist-renderer/**", "dist-electron/**", "package.json"]);
    assert.deepEqual(config.extraResources, approved.extraResources, `${spec.config} resource allowlist drifted`);
    assert.equal(config.asar, true);
    assert.equal(config.win?.signExecutable, false);
    assert.deepEqual(config.win?.target, [{ target: "portable", arch: ["x64"] }]);
    assert.equal(config.portable?.artifactName, spec.artifactName);

    const serialized = JSON.stringify(config);
    assert.doesNotMatch(serialized, /(?:runtime[\\/]node\.exe|uat-runner\.js|\.cmd\b|\.bat\b|device-profile\.json|bootstrap-credentials|credential)/i);
    appIds.add(config.appId!);
    outputs.add(config.directories!.output!);
    artifacts.add(config.portable!.artifactName!);
  }

  assert.equal(appIds.size, 4);
  assert.equal(outputs.size, 4);
  assert.equal(artifacts.size, 4);
});

test("review aggregate builds only official R7 pair while retaining the historical standalone harness", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(
    pkg.scripts?.["dist:geumcheon:review"],
    "npm run build && electron-builder --config electron-builder.geumcheon-ai-review.yml --publish=never && electron-builder --config electron-builder.geumcheon-ai-leaderboard-review.yml --publish=never"
  );
  const event = JSON.parse(fs.readFileSync(path.join(root, "events/geumcheon-2026/event.config.json"), "utf8"));
  assert.deepEqual(Object.entries(event.variants).filter(([, value]) => (value as { enabled: boolean }).enabled).map(([key]) => key).sort(), ["ai", "ai-leaderboard"]);
  for (const variant of ["practice", "practice-leaderboard"]) {
    assert.equal(event.variants[variant].enabled, false);
    assert.doesNotMatch(pkg.scripts?.["dist:geumcheon:review"] ?? "", new RegExp("geumcheon-" + variant + "-review"));
  }
  assert.equal(pkg.scripts?.["test:e2e:geumcheon-review"], "tsx scripts/r5-standalone-review-check.ts");
  assert.equal(fs.existsSync(path.join(root, "scripts", "r5-standalone-review-check.ts")), true);
});
