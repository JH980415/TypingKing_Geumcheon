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
  for (const key of ['token', 'password', 'unexpected']) {
    assert.throws(() => validateTemplate({
      ...profile,
      sessions: { official: { ...profile.sessions.official, [key]: 'synthetic-not-a-secret' } }
    }, 'PC01', 'player'), /official/, 'reject unknown nested official field: ' + key);
  }
  assert.throws(() => validateTemplate({...profile, sessions: {...profile.sessions, practice: {sessionId:'fake'}}}, 'PC01', 'player'));
  assert.throws(() => validateTemplate({...profile, sessions: {official: {...profile.sessions.official, dayNo:'1'}}}, 'PC01', 'player'));
});

function serverFixture(externalModules = false, linkedBuild = false) {
  const temp = fs.mkdtempSync(path.resolve('Codex/Outputs/R7/server-package-test-'));
  const service = path.join(temp, 'services/nas-record-api');
  const write = (name: string, content: string) => {
    const target = externalModules && name.startsWith('node_modules/')
      ? path.join(temp, 'installed-runtime', name.slice('node_modules/'.length))
      : linkedBuild && name.startsWith('dist/')
        ? path.join(temp, 'linked-build', name.slice('dist/'.length))
      : path.join(service, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write('package.json', JSON.stringify({ name: 'server-fixture', version: '1.0.0', dependencies: { fastify: '1.0.0' } }));
  write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
    '': { name: 'server-fixture', version: '1.0.0', dependencies: { fastify: '1.0.0' } },
    'node_modules/fastify': { version: '1.0.0', dependencies: { nested: '2.0.0' } },
    'node_modules/fastify/node_modules/nested': { version: '2.0.0' },
    'node_modules/development-only': { version: '1.0.0', dev: true }
  } }));
  write('dist/server.cjs', "module.exports = require('fastify');\n");
  write('node_modules/fastify/package.json', JSON.stringify({ name: 'fastify', version: '1.0.0', dependencies: { nested: '2.0.0' } }));
  write('node_modules/fastify/index.js', "module.exports = require('nested');\n");
  write('node_modules/fastify/empty.js', '');
  write('node_modules/fastify/node_modules/nested/package.json', JSON.stringify({ name: 'nested', version: '2.0.0' }));
  write('node_modules/fastify/node_modules/nested/index.js', "module.exports = 'nested-runtime-ready';\n");
  write('node_modules/development-only/package.json', JSON.stringify({ name: 'development-only', version: '1.0.0' }));
  write('node_modules/unlocked-secret.txt', 'must-not-ship');
  write('config/private-token.json', 'must-not-ship');
  if (externalModules) fs.symlinkSync(path.join(temp, 'installed-runtime'), path.join(service, 'node_modules'), 'junction');
  if (linkedBuild) fs.symlinkSync(path.join(temp, 'linked-build'), path.join(service, 'dist'), 'junction');
  return { temp, service, write };
}

test('server selection carries locked transitive runtime dependencies that resolve after isolation', async () => {
  const packager = await import('../../scripts/r7-package-release.ts');
  assert.equal(typeof packager.serverRuntimeEntries, 'function', 'server runtime allowlist is required');
  const fixture = serverFixture();
  try {
    const entries = packager.serverRuntimeEntries(fixture.temp);
    assert.equal(entries.length, 8);
    assert.ok(entries.some(entry => entry.name.endsWith('/fastify/node_modules/nested/index.js')));
    assert.ok(entries.some(entry => entry.name.endsWith('/fastify/empty.js')));
    assert.ok(entries.every(entry => !/development-only|unlocked-secret|private-token/.test(entry.name)));
    const isolated = path.join(fixture.temp, 'isolated');
    for (const entry of entries) {
      const target = path.join(isolated, entry.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(entry.source, target);
    }
    const result = spawnSync(process.execPath, ['-e', "console.log(require('./server/services/nas-record-api/dist/server.cjs'))"], { cwd: isolated, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_PATH: '' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'nested-runtime-ready');
  } finally { fs.rmSync(fixture.temp, { recursive: true, force: true }); }
});

test('server selection rejects missing, mismatched and escaping locked packages', async () => {
  const packager = await import('../../scripts/r7-package-release.ts');
  assert.equal(typeof packager.serverRuntimeEntries, 'function', 'server runtime allowlist is required');
  const fixture = serverFixture();
  try {
    fixture.write('node_modules/fastify/package.json', JSON.stringify({ name: 'fastify', version: '9.0.0' }));
    assert.throws(() => packager.serverRuntimeEntries(fixture.temp), /version/i);
    fixture.write('node_modules/fastify/package.json', JSON.stringify({ name: 'fastify', version: '1.0.0', dependencies: { nested: '2.0.0' } }));
    fs.renameSync(path.join(fixture.service, 'node_modules/fastify/node_modules/nested'), path.join(fixture.service, 'missing-runtime'));
    assert.throws(() => packager.serverRuntimeEntries(fixture.temp), /missing/i);
    const lockPath = path.join(fixture.service, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.packages = { 'node_modules/../../escape': { version: '1.0.0' } };
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    assert.throws(() => packager.serverRuntimeEntries(fixture.temp), /unsafe/i);
  } finally { fs.rmSync(fixture.temp, { recursive: true, force: true }); }
});

test('server selection resolves an installed modules root junction without following package links', async () => {
  const { serverRuntimeEntries } = await import('../../scripts/r7-package-release.ts');
  const fixture = serverFixture(true);
  try {
    const installed = path.join(fixture.temp, 'installed-runtime');
    const entries = serverRuntimeEntries(fixture.temp);
    assert.ok(entries.some(entry => entry.source === path.join(installed, 'fastify/index.js')));
    const linkedPackage = path.join(fixture.temp, 'linked-package');
    fs.mkdirSync(linkedPackage);
    fs.symlinkSync(linkedPackage, path.join(installed, 'fastify/linked-package'), 'junction');
    assert.throws(() => serverRuntimeEntries(fixture.temp), /unsafe.*(?:link|ancestor|directory)/i);
  } finally { fs.rmSync(fixture.temp, { recursive: true, force: true }); }
});

test('server selection rejects a dist parent junction even when server.cjs is a regular file', async () => {
  const { serverRuntimeEntries } = await import('../../scripts/r7-package-release.ts');
  const fixture = serverFixture(false, true);
  try {
    assert.equal(fs.lstatSync(path.join(fixture.service, 'dist/server.cjs')).isSymbolicLink(), false);
    assert.throws(() => serverRuntimeEntries(fixture.temp), /unsafe source ancestor/i);
  } finally { fs.rmSync(fixture.temp, { recursive: true, force: true }); }
});

test('server template selection rejects a linked parent before reading its regular config files', async () => {
  const { serverTemplateEntries } = await import('../../scripts/r7-package-release.ts');
  const fixture = serverFixture();
  try {
    const copied = path.join(fixture.temp, 'copied-template');
    fs.cpSync('deployment/nas-production/server', copied, { recursive: true });
    const declared = path.join(fixture.temp, 'deployment/nas-production/server');
    fs.mkdirSync(path.dirname(declared), { recursive: true });
    fs.symlinkSync(copied, declared, 'junction');
    assert.equal(fs.lstatSync(path.join(declared, 'config/event-config.production.template.json')).isSymbolicLink(), false);
    assert.throws(() => serverTemplateEntries(fixture.temp), /unsafe source ancestor/i);
  } finally { fs.rmSync(fixture.temp, { recursive: true, force: true }); }
});

test('generic ZIP source selection rejects ancestor junctions before archive creation', async () => {
  const { writeZip } = await import('../../scripts/r7-package-release.ts');
  const fixture = serverFixture(false, true);
  try {
    const output = path.join(fixture.temp, 'missing-output-directory/rejected.zip');
    await assert.rejects(writeZip(output, [{ name: 'server.cjs', source: path.join(fixture.service, 'dist/server.cjs') }]), /unsafe source ancestor/i);
    assert.equal(fs.existsSync(output), false);
  } finally { fs.rmSync(fixture.temp, { recursive: true, force: true }); }
});

test('container bind template preserves Korean spaces and rejects parent or overlapping mounts', async () => {
  const packager = await import('../../scripts/r7-package-release.ts');
  assert.equal(typeof packager.validateServerMounts, 'function', 'mount validation is required');
  const { createRequire } = await import('node:module');
  const yaml = createRequire(import.meta.url)('js-yaml');
  const text = fs.readFileSync('deployment/nas-production/server/container/compose.review-only.template.yaml', 'utf8');
  const substitutions = {
    '__ABSOLUTE_CONFIRMED_TEMP_SHARE_TYPINGKING_DATA_PATH__': '/confirmed/임시/typingking',
    '__ABSOLUTE_CONFIRMED_SERVER_RUNTIME_PATH__': '/confirmed/서비스 실행/서버 묶음',
    '__ABSOLUTE_PROTECTED_TYPINGKING_SECRETS_PATH__': '/confirmed/보호 설정/typingking 비밀정보'
  };
  let supplied = text;
  for (const [placeholder, value] of Object.entries(substitutions)) supplied = supplied.replaceAll(placeholder, value);
  const parsed = yaml.load(supplied);
  const expected = Object.values(substitutions);
  const result = packager.validateServerMounts(parsed, expected[0]);
  assert.deepEqual(new Set(result.map((mount: { source: string }) => mount.source)), new Set(expected));
  assert.equal(parsed.services['record-api'].environment.NAS_BIND_HOST, '127.0.0.1');
  assert.equal(parsed.services['record-api'].ports, undefined);
  assert.equal(parsed['x-typingking-status'], 'REVIEW_ONLY_NOT_APPLIED');
  for (const source of ['/confirmed/임시', '/confirmed/임시/typingking/../other']) {
    const changed = structuredClone(parsed);
    changed.services['record-api'].volumes.find((mount: { target: string }) => mount.target === '/var/lib/typingking/records').source = source;
    assert.throws(() => packager.validateServerMounts(changed, expected[0]), /confirmed|unsafe/i);
  }
  const overlap = structuredClone(parsed);
  overlap.services['record-api'].volumes.find((mount: { target: string }) => mount.target === '/run/typingking-private').source = expected[0] + '/secrets';
  assert.throws(() => packager.validateServerMounts(overlap, expected[0]), /overlap/i);
  assert.throws(() => packager.validateServerMounts(yaml.load(text), expected[0]), /placeholder/i);
});

test('server deployment selection refuses populated secrets and keeps only approved templates', async () => {
  const packager = await import('../../scripts/r7-package-release.ts');
  assert.equal(typeof packager.serverTemplateEntries, 'function', 'server template selection is required');
  const fixture = serverFixture();
  try {
    const source = path.resolve('deployment/nas-production/server');
    fs.cpSync(source, path.join(fixture.temp, 'deployment/nas-production/server'), { recursive: true });
    const catalog = path.join(fixture.temp, 'events/geumcheon-2026/stage_texts.csv');
    fs.mkdirSync(path.dirname(catalog), { recursive: true });
    fs.copyFileSync('events/geumcheon-2026/stage_texts.csv', catalog);
    const entries = packager.serverTemplateEntries(fixture.temp);
    assert.equal(entries.length, 5);
    assert.ok(entries.some(entry => entry.name === 'server/config/stage_texts.csv'));
    assert.ok(entries.every(entry => !/start-nas-record-api|device-profile|bootstrap-credentials/.test(entry.name)));
    const manifest = path.join(fixture.temp, 'deployment/nas-production/server/config/token-manifest.production.template.json');
    const original = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    for (const mutate of [
      (value: any) => { value.tokens[0].tokenHash = 'a'.repeat(64); },
      (value: any) => { value.tokens[0].token = 'synthetic-secret-must-not-ship'; }
    ]) {
      const changed = structuredClone(original);
      mutate(changed);
      fs.writeFileSync(manifest, JSON.stringify(changed));
      assert.throws(() => packager.serverTemplateEntries(fixture.temp));
    }
    fs.writeFileSync(manifest, JSON.stringify(original));
    const composePath = path.join(fixture.temp, 'deployment/nas-production/server/container/compose.review-only.template.yaml');
    const { createRequire } = await import('node:module');
    const yaml = createRequire(import.meta.url)('js-yaml');
    const template = yaml.load(fs.readFileSync(composePath, 'utf8'));
    for (const mutate of [
      (value: any) => { value.services['record-api'].volumes[0].source = '/synthetic/private/runtime'; },
      (value: any) => { value.services['record-api'].environment.TOKEN = 'synthetic-secret-must-not-ship'; }
    ]) {
      const changed = structuredClone(template);
      mutate(changed);
      fs.writeFileSync(composePath, yaml.dump(changed));
      assert.throws(() => packager.serverTemplateEntries(fixture.temp));
    }
  } finally { fs.rmSync(fixture.temp, { recursive: true, force: true }); }
});

test('server manifest measures current source and refuses a build older than its inputs', async () => {
  const packager = await import('../../scripts/r7-package-release.ts');
  assert.equal(typeof packager.serverReleaseManifest, 'function', 'measured server release manifest is required');
  const fixture = serverFixture();
  try {
    fixture.write('src/cli.ts', 'export const fixtureVersion = 1;\n');
    fs.mkdirSync(path.join(fixture.temp, 'shared'));
    const built = path.join(fixture.service, 'dist/server.cjs');
    fs.utimesSync(built, 1, 1);
    assert.throws(() => packager.serverReleaseManifest(fixture.temp, 'a'.repeat(40)), /older|stale/i);
    fs.utimesSync(built, new Date(), new Date(Date.now() + 1000));
    const result = packager.serverReleaseManifest(fixture.temp, 'a'.repeat(40));
    const { createHash } = await import('node:crypto');
    assert.equal(result.sourceCommit, 'a'.repeat(40));
    assert.equal(result.serverSha256, createHash('sha256').update(fs.readFileSync(built)).digest('hex'));
    assert.equal(result.lockfileSha256, createHash('sha256').update(fs.readFileSync(path.join(fixture.service, 'package-lock.json'))).digest('hex'));
    assert.equal(result.runtimeDependencies.length, 2);
    const first = result.sourceFiles.find((entry: { name: string }) => entry.name.endsWith('/src/cli.ts')).sha256;
    fixture.write('src/cli.ts', 'export const fixtureVersion = 2;\n');
    const changed = packager.serverReleaseManifest(fixture.temp, 'a'.repeat(40));
    assert.notEqual(changed.sourceFiles.find((entry: { name: string }) => entry.name.endsWith('/src/cli.ts')).sha256, first);
    assert.equal(result.actualNas, 'NOT_RUN');
    assert.equal(result.productionRelease, 'HOLD');
  } finally { fs.rmSync(fixture.temp, { recursive: true, force: true }); }
});
