import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { prepareApplicationRelaunch } from "../../electron/applicationRelaunch";

function portableFixture(context: any) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r4-relaunch-"));
  const executable = path.join(directory, "G-Science AI 타자왕.exe");
  fs.writeFileSync(executable, "synthetic-unexecuted-exe");
  const before = { cwd: process.cwd(), file: process.env.PORTABLE_EXECUTABLE_FILE, directory: process.env.PORTABLE_EXECUTABLE_DIR };
  process.env.PORTABLE_EXECUTABLE_FILE = executable; process.env.PORTABLE_EXECUTABLE_DIR = directory;
  context.after(() => {
    process.chdir(before.cwd);
    if (before.file === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE; else process.env.PORTABLE_EXECUTABLE_FILE = before.file;
    if (before.directory === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR; else process.env.PORTABLE_EXECUTABLE_DIR = before.directory;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, executable };
}
test("portable restart selects the outer executable, preserves arguments, and uses its stable directory", context => {
  const f = portableFixture(context), observed: any[] = [];
  const restart = prepareApplicationRelaunch({ isPackaged: true, relaunch: options => observed.push({ options, cwd: process.cwd() }), quit: () => observed.push("quit") });
  assert.deepEqual(observed, []);
  restart();
  assert.deepEqual(observed, [{ options: { execPath: f.executable, args: process.argv.slice(1) }, cwd: f.directory }, "quit"]);
});
test("invalid or absent portable metadata is rejected before scheduling a restart", context => {
  const f = portableFixture(context), calls: string[] = [];
  const app = { isPackaged: true, relaunch: () => calls.push("relaunch"), quit: () => calls.push("quit") };
  for (const [file, directory] of [
    ["", f.directory], [f.executable, ""], ["relative.exe", f.directory],
    [f.executable, path.dirname(f.directory)], [path.join(f.directory, "missing.exe"), f.directory],
    [f.directory, f.directory]
  ]) {
    process.env.PORTABLE_EXECUTABLE_FILE = file; process.env.PORTABLE_EXECUTABLE_DIR = directory;
    assert.throws(() => prepareApplicationRelaunch(app), /PROFILE_RELAUNCH_UNAVAILABLE/);
  }
  assert.deepEqual(calls, []);
});
test("development restart retains Electron default behavior", context => {
  portableFixture(context);
  const observed: any[] = [], cwd = process.cwd();
  prepareApplicationRelaunch({ isPackaged: false, relaunch: options => observed.push(options), quit: () => observed.push("quit") })();
  assert.deepEqual(observed, [undefined, "quit"]); assert.equal(process.cwd(), cwd);
});
test("a failed relaunch does not quit the app and restores its previous directory", context => {
  portableFixture(context); const cwd = process.cwd(); let quit = false;
  const restart = prepareApplicationRelaunch({ isPackaged: true, relaunch: () => { throw new Error("SYNTHETIC_RELAUNCH"); }, quit: () => { quit = true; } });
  assert.throws(restart, /SYNTHETIC_RELAUNCH/);
  assert.equal(quit, false); assert.equal(process.cwd(), cwd);
});
test("actual rental build command enables a separate extraction directory for each portable run", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "scripts/rental-v4-package-release.ts"), "utf8");
  const start = source.indexOf("export function buildRentalClient("), end = source.indexOf("\nexport async function ", start + 1);
  assert.ok(start >= 0 && end > start);
  const commands: string[][] = [], evidence = { sha: "synthetic-source" };
  const sandbox = { exports: {} as any, path, process: { execPath: process.execPath, version: process.version },
    assert, fs: { existsSync: () => true, writeFileSync: () => {} }, sourceEvidence: () => evidence,
    assertNewDirectory: () => {}, command: (_root: string, _exe: string, args: string[]) => commands.push(args),
    compileRentalProtectionBridge: () => ({}), stageRentalApplication: () => {},
    verifyRentalRuntimeArchive: () => {}, verifyPackagedProtectionBridge: () => {},
    buildArtifactManifest: () => [], RENTAL_V4_CANDIDATE: "synthetic-test", EXES: ["game.exe", "board.exe"] };
  vm.runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  sandbox.exports.buildRentalClient(path.join(os.tmpdir(), "synthetic-not-built"));
  const builds = commands.filter(args => args.some(value => value.endsWith(path.join("electron-builder", "cli.js"))));
  assert.equal(builds.length, 2);
  for (const args of builds) {
    assert.ok(args.includes("--config.portable.unpackDirName=true"));
    assert.ok(args.includes("--publish=never"));
  }
});
