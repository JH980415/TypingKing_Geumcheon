import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

function zipNames(zip: string): string[] {
  const command = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${zip.replaceAll("'", "''")}'); try { ConvertTo-Json -Compress -InputObject @($z.Entries | ForEach-Object {$_.FullName}) } finally {$z.Dispose()}`;
  const result = spawnSync('powershell.exe', ['-NoProfile','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')], {encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}

test('delivery selection excludes stale practice executables and refuses overwrite/escape', async () => {
  const modulePath = '../../scripts/r7-package-release.ts';
  const available = fs.existsSync(new URL(modulePath, import.meta.url));
  assert.equal(available, true, 'R7 allowlisted packager is required');
  if (!available) return;
  const { writeZip, safeNewOutput } = await import(modulePath);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-package-test-'));
  try {
    const source = path.join(temp, 'official.exe');
    fs.writeFileSync(source, 'fixture-only-not-an-executable');
    fs.writeFileSync(path.join(temp, 'practice.exe'), 'stale');
    const zip = path.join(temp, 'official.zip');
    const manifest = await writeZip(zip, [{ name: 'G-Science AI 타자왕_검토용.exe', source }]);
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].name, 'G-Science AI 타자왕_검토용.exe');
    assert.equal(manifest[0].bytes, 30);
    assert.deepEqual(zipNames(zip), ['G-Science AI 타자왕_검토용.exe']);
    const zip2 = path.join(temp,'repeat.zip');
    await writeZip(zip2, [{name:'G-Science AI 타자왕_검토용.exe',source}]);
    assert.deepEqual(fs.readFileSync(zip2),fs.readFileSync(zip));
    assert.match(manifest[0].sha256, /^[0-9a-f]{64}$/);
    await assert.rejects(writeZip(zip, [{ name: 'other.exe', source }]), /exists/);
    await assert.rejects(writeZip(path.join(temp, 'bad.zip'), [{ name: '../escape.exe', source }]), /Unsafe/);
    assert.throws(() => safeNewOutput(temp, '../escape'), /outside/);
    assert.throws(() => safeNewOutput(temp, '.'), /child/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('profile templates retain fixed device IDs, reject secrets/practice and validate substituted numeric types', async () => {
  const modulePath = '../../scripts/r7-package-release.ts';
  const available = fs.existsSync(new URL(modulePath, import.meta.url));
  assert.equal(available, true, 'R7 profile validator is required');
  if (!available) return;
  const { validateTemplate } = await import(modulePath);
  const profile = { schemaVersion: 1, eventProfileId: 'geumcheon-2026', eventId: 'geumcheon-science-festival-2026', deviceId: 'PC01', role: 'player', apiBaseUrl: '__NAS_RECORD_API_URL__', sessions: { official: {sessionId: '__OFFICIAL_SESSION_ID__', dayNo: '__OFFICIAL_DAY_NO__', roundNo: '__OFFICIAL_ROUND_NO__'} }, requestTimeoutMs: 5000, retry: {initialDelayMs: 1000, maxDelayMs: 30000} };
  assert.equal(validateTemplate(profile, 'PC01', 'player').runtimeReady, false);
  assert.throws(() => validateTemplate({...profile, deviceId: '__PC__'}, 'PC01', 'player'));
  assert.throws(() => validateTemplate({...profile, token: 'private'}, 'PC01', 'player'));
  assert.throws(() => validateTemplate({...profile, sessions: {...profile.sessions, practice: {sessionId:'fake'}}}, 'PC01', 'player'));
  assert.throws(() => validateTemplate({...profile, sessions: {official: {...profile.sessions.official, dayNo:'1'}}}, 'PC01', 'player'));
});
