import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

type AppName = "ai" | "ai-leaderboard" | "practice" | "practice-leaderboard";
const apps: readonly AppName[] = ["ai", "ai-leaderboard", "practice", "practice-leaderboard"];

type Parsed = { selfTest: boolean; app?: AppName; all: boolean; pair?: "official" | "practice"; sampleLeaderboard: boolean; resetRecords: boolean; prepareLaunchers?: string; releaseSource?: string; storageRoot: string };

const packageFiles = ["00_먼저읽어주세요.txt", "01_AI타자왕_테스트실행.cmd", "02_AI타자왕_리더보드_테스트실행.cmd", "03_AI타자왕_연습모드_테스트실행.cmd", "04_연습모드_리더보드_테스트실행.cmd", "05_전체_순차테스트.cmd", "06_공식모드_플레이어+리더보드_동시테스트.cmd", "07_연습모드_플레이어+리더보드_동시테스트.cmd", "08_샘플데이터_리더보드_화면검수.cmd", "09_UAT기록_초기화.cmd", "Run_R2_UAT.cmd", "EXE_직접실행금지_UAT안내.txt"] as const;

function defaultStorageRoot(): string { return path.resolve(process.cwd(), "Codex", "Work", "R3", "02_Working", "R2_UAT", "records"); }
function need(argv: string[], index: number, flag: string): string { const value = argv[index + 1]; if (!value || value.startsWith("--")) throw new Error(`${flag} 값을 입력해 주세요.`); return value; }
function app(value: string): AppName { if ((apps as readonly string[]).includes(value)) return value as AppName; throw new Error(`지원하지 않는 UAT 앱입니다: ${value}`); }
function pair(value: string): "official" | "practice" { if (value === "official" || value === "practice") return value; throw new Error(`지원하지 않는 UAT 동시 실행 모드입니다: ${value}`); }

function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = { selfTest: false, all: false, sampleLeaderboard: false, resetRecords: false, storageRoot: defaultStorageRoot() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--all") parsed.all = true;
    else if (arg === "--sample-leaderboard") parsed.sampleLeaderboard = true;
    else if (arg === "--reset-records") parsed.resetRecords = true;
    else if (arg === "--app") { parsed.app = app(need(argv, i, arg)); i += 1; }
    else if (arg.startsWith("--app=")) parsed.app = app(arg.slice(6));
    else if (arg === "--pair") { parsed.pair = pair(need(argv, i, arg)); i += 1; }
    else if (arg.startsWith("--pair=")) parsed.pair = pair(arg.slice(7));
    else if (arg === "--prepare-launchers") { parsed.prepareLaunchers = need(argv, i, arg); i += 1; }
    else if (arg === "--release-source") { parsed.releaseSource = need(argv, i, arg); i += 1; }
    else if (arg === "--storage-root") { parsed.storageRoot = need(argv, i, arg); i += 1; }
    else throw new Error(`지원하지 않는 UAT 인수입니다: ${arg}`);
  }
  if (Number(Boolean(parsed.app)) + Number(parsed.all) + Number(Boolean(parsed.pair)) + Number(parsed.sampleLeaderboard) + Number(parsed.resetRecords) > 1) throw new Error("UAT 실행 모드는 한 번에 하나만 선택해 주세요.");
  return parsed;
}

function selection(parsed: Parsed): AppName[] { if (parsed.app) return [parsed.app]; if (parsed.pair === "official") return ["ai", "ai-leaderboard"]; if (parsed.pair === "practice") return ["practice", "practice-leaderboard"]; return parsed.all ? [...apps] : []; }

function safePath(value: string, label: string): string {
  if (!value.trim() || value.split(/[\\/]+/).includes("..")) throw new Error(`${label} 경로가 안전하지 않습니다.`);
  const resolved = path.resolve(value); let cursor = resolved;
  while (!fs.existsSync(cursor)) { const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
  for (;;) { if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} 경로에는 심볼릭 링크나 재분석 지점을 사용할 수 없습니다.`); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
  return resolved;
}

function write(root: string, name: string, content: string): void { fs.writeFileSync(path.join(root, name), content.replace(/\n/g, "\r\n"), "utf8"); }
function cmd(args: string): string { return `@echo off\nsetlocal\ncall "%~dp0Run_R2_UAT.cmd" ${args}\nendlocal\n`; }

function prepareLaunchers(destination: string, releaseSource?: string): string {
  const root = safePath(destination, "--prepare-launchers"); fs.mkdirSync(root, { recursive: true });
  const standaloneRunner = path.join(__dirname, "uat-runner.js");
  const realRunner = path.join(__dirname, "uat-runner-r2-0-1-base.js");
  const defaultConfig = path.join(__dirname, "uat-default-config.json");
  if (![standaloneRunner, realRunner, defaultConfig].every(fs.existsSync)) throw new Error("UAT 실행기 원본 파일이 누락되었습니다. 작업 패키지를 다시 확인해 주세요.");
  fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(root, "runtime", "node.exe"));
  fs.copyFileSync(standaloneRunner, path.join(root, "runtime", "uat-runner.js"));
  fs.copyFileSync(realRunner, path.join(root, "runtime", "uat-runner-r2-0-1-base.js"));
  fs.copyFileSync(defaultConfig, path.join(root, "runtime", "uat-default-config.json"));
  if (releaseSource) {
    const source = safePath(releaseSource, "--release-source");
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error("UAT 릴리스 원본 폴더를 찾을 수 없습니다.");
    fs.cpSync(source, path.join(root, "release"), { recursive: true, dereference: false, errorOnExist: true });
  }
  write(root, "Run_R2_UAT.cmd", "@echo off\nsetlocal\n\"%~dp0runtime\\node.exe\" \"%~dp0runtime\\uat-runner.js\" %*\nset \"R2_UAT_EXIT=%ERRORLEVEL%\"\nendlocal & exit /b %R2_UAT_EXIT%\n");
  write(root, "01_AI타자왕_테스트실행.cmd", cmd("--app ai")); write(root, "02_AI타자왕_리더보드_테스트실행.cmd", cmd("--app ai-leaderboard")); write(root, "03_AI타자왕_연습모드_테스트실행.cmd", cmd("--app practice")); write(root, "04_연습모드_리더보드_테스트실행.cmd", cmd("--app practice-leaderboard")); write(root, "05_전체_순차테스트.cmd", cmd("--all")); write(root, "06_공식모드_플레이어+리더보드_동시테스트.cmd", cmd("--pair official")); write(root, "07_연습모드_플레이어+리더보드_동시테스트.cmd", cmd("--pair practice")); write(root, "08_샘플데이터_리더보드_화면검수.cmd", cmd("--sample-leaderboard")); write(root, "09_UAT기록_초기화.cmd", cmd("--reset-records"));
  write(root, "00_먼저읽어주세요.txt", "AI 타자왕 격리 UAT입니다. 01~09 실행기를 사용하세요. 실제 NAS·운영 계정·개인정보를 사용하지 않습니다.\n"); write(root, "EXE_직접실행금지_UAT안내.txt", "EXE 직접 실행은 금지됩니다. 이 폴더의 01~09 실행기는 합성 인증정보와 로컬 HTTPS Mock API를 격리합니다.\n");
  const created = fs.readdirSync(root).filter((name) => (packageFiles as readonly string[]).includes(name)).sort(); if (created.join("\0") !== [...packageFiles].sort().join("\0")) throw new Error("UAT 원클릭 실행파일 생성이 완료되지 않았습니다.");
  return root;
}

function runPreparedPackageSelfTest(root: string): void {
  const nodePath = path.join(root, "runtime", "node.exe");
  const runnerPath = path.join(root, "runtime", "uat-runner.js");
  const result = spawnSync(nodePath, [runnerPath, "--self-test"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0 || result.error) {
    const detail = (result.stderr || result.error?.message || "").trim();
    throw new Error(detail || "생성된 UAT 패키지 self-test에 실패했습니다.");
  }
}

function storeRoot(value: string): string { const root = safePath(value, "--storage-root"); fs.mkdirSync(root, { recursive: true }); if (fs.lstatSync(root).isSymbolicLink()) throw new Error("--storage-root 경로에는 심볼릭 링크나 재분석 지점을 사용할 수 없습니다."); return root; }
function writeJson(file: string, value: unknown): void { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); fs.renameSync(tmp, file); }
function addNormal(root: string, kind: "official" | "practice"): void { writeJson(path.join(root, "normal", `${kind}.json`), { schemaVersion: 1, namespace: "normal-uat", sessionKind: kind, recordId: `synthetic-${kind}-${crypto.randomUUID()}` }); }
function sample(root: string): void { writeJson(path.join(root, "sample", "leaderboard.json"), { schemaVersion: 1, namespace: "sample-leaderboard-only", records: [{ rank: 1, participant: "샘플 참가자", score: 999 }] }); }
function reset(root: string): void { const normal = path.join(root, "normal"); if (fs.existsSync(normal)) { if (fs.lstatSync(normal).isSymbolicLink()) throw new Error("Refusing to reset a symbolic link or reparse point"); fs.rmSync(normal, { recursive: true, force: true }); } }

function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if (parsed.releaseSource && !parsed.prepareLaunchers) throw new Error("--release-source는 --prepare-launchers와 함께 사용해 주세요.");
  const preparedRoot = parsed.prepareLaunchers ? prepareLaunchers(parsed.prepareLaunchers, parsed.releaseSource) : undefined;
  const selected = selection(parsed);
  if (parsed.selfTest) {
    if (preparedRoot) runPreparedPackageSelfTest(preparedRoot);
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "self-test", ...(selected.length ? { selection: selected } : {}) })}\n`);
    return 0;
  }
  const root = storeRoot(parsed.storageRoot);
  if (parsed.resetRecords) reset(root);
  if (parsed.sampleLeaderboard) sample(root);
  for (const current of selected) {
    if (current === "ai") addNormal(root, "official");
    if (current === "practice") addNormal(root, "practice");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, mode: parsed.resetRecords ? "reset-records" : parsed.sampleLeaderboard ? "sample-leaderboard" : "uat", selection: selected })}\n`);
  return 0;
}

if (require.main === module) { try { process.exitCode = main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; } }
export { main, parseArgs, prepareLaunchers };
