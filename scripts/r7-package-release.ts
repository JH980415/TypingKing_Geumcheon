import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { validateDeviceProfile } from '../shared/events/eventProfile';

type Entry = { name: string; source: string; allowEmpty?: boolean };
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const marker = '.typingking-geumcheon-client-release.json';
export const officialArtifacts = [
  ['geumcheon-review/ai', 'G-Science AI 타자왕_검토용.exe'],
  ['geumcheon-review/ai-leaderboard', 'G-Science AI 타자왕_리더보드_검토용.exe'],
  ['geumcheon/ai', 'G-Science AI 타자왕.exe'],
  ['geumcheon/ai-leaderboard', 'G-Science AI 타자왕 리더보드.exe'],
] as const;
function assertSourceAncestors(source: string) {
  for (let current = path.resolve(source); ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Unsafe source ancestor: ${current}`);
    if (current === path.dirname(current)) break;
  }
}

const digest = (source: string) => {
  assertSourceAncestors(source);
  return crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
};

export function safeNewOutput(base: string, relative: string): string {
  const target = path.resolve(base, relative);
  if (target === path.resolve(base)) throw new Error('Output must be a child directory');
  if (!target.startsWith(path.resolve(base) + path.sep)) throw new Error('Output outside allowed root');
  if (fs.existsSync(target)) throw new Error(`Output exists: ${target}`);
  // Reject junction/symlink ancestors so lexical containment cannot redirect writes.
  for (let p = path.dirname(target); ; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('Unsafe output ancestor');
    if (p === path.dirname(p)) break;
  }
  return target;
}

export async function writeZip(output: string, entries: Entry[]) {
  if (fs.existsSync(output)) throw new Error(`Output exists: ${output}`);
  const sorted = [...entries].sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const names = new Set<string>();
  for (const entry of sorted) {
    if (!entry.name || /[\\:\x00-\x1f]/.test(entry.name) || entry.name.startsWith('/') || entry.name.split('/').some(p => p === '..' || p === '.' || !p)) throw new Error('Unsafe ZIP entry');
    if (names.has(entry.name.toLowerCase())) throw new Error('Duplicate ZIP entry');
    names.add(entry.name.toLowerCase());
    assertSourceAncestors(entry.source);
    const stat = fs.lstatSync(entry.source);
    if (!stat.isFile() || stat.isSymbolicLink() || (!stat.size && !entry.allowEmpty)) throw new Error('Unsafe or empty source');
  }
  const manifest = sorted.map(e => ({name: e.name, bytes: fs.statSync(e.source).size, sha256: digest(e.source)}));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-zip-'));
  try {
    const manifestPath = path.join(temp, 'entries.json');
    fs.writeFileSync(manifestPath, JSON.stringify(sorted), 'utf8');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(scriptDir, 'r7-write-zip.ps1'), '-ManifestPath', manifestPath, '-OutputPath', output], {encoding:'utf8', windowsHide:true});
    if (result.status !== 0) throw new Error(`ZIP creation failed: ${result.error?.message ?? result.stderr}`);
    return manifest;
  } finally { fs.rmSync(temp, {recursive:true, force:true}); }
}

export function validateTemplate(value: any, deviceId: string, role: string) {
  assert.equal(value.deviceId, deviceId);
  assert.equal(value.role, role);
  assert.deepEqual(Object.keys(value.sessions).sort(), ['official']);
  const required = {apiBaseUrl:'__NAS_RECORD_API_URL__', sessionId:'__OFFICIAL_SESSION_ID__', dayNo:'__OFFICIAL_DAY_NO__', roundNo:'__OFFICIAL_ROUND_NO__'};
  assert.equal(value.apiBaseUrl, required.apiBaseUrl);
  for (const key of ['sessionId','dayNo','roundNo']) assert.equal(value.sessions.official[key], required[key as keyof typeof required]);
  const candidate = structuredClone(value);
  candidate.apiBaseUrl = 'https://127.0.0.1:9443';
  candidate.sessions.official = {...candidate.sessions.official, sessionId:'r7-synthetic-official', dayNo:1, roundNo:1};
  validateDeviceProfile(candidate);
  return {deviceId, role, templateSchema:'PASS', numericSubstitutionSchema:'PASS', runtimeReady:false, actualNas:'NOT_RUN', pending:required};
}

export function publicResources(projectRoot: string) {
  // Explicit builder filters are the runtime allowlist, never a recursive release-directory glob.
  const yml = fs.readFileSync(path.join(projectRoot, 'electron-builder.geumcheon-ai.yml'), 'utf8');
  const resources: string[] = [];
  let base = '';
  let inResources = false;
  for (const line of yml.split(/\r?\n/)) {
    if (line === 'extraResources:') { inResources = true; continue; }
    if (inResources && /^\S/.test(line)) break;
    const from = line.match(/^  - from: (.+)$/);
    if (from) base = from[1];
    const filter = line.match(/^      - (.+)$/);
    if (filter && inResources) {
      const name = `${base}/${filter[1]}`;
      if (!/^(assets\/ai_challenge\/[^/]+\.png|events\/geumcheon-2026\/(event\.config\.json|stage_texts\.csv|assets\/(?:ai_challenge\/)?[^/]+\.png))$/.test(name) || name.includes('..')) throw new Error(`Unsafe resource: ${name}`);
      resources.push(name);
    }
  }
  assert.ok(resources.length > 0);
  return resources;
}

function regularFiles(directory: string, skipNestedModules = false): string[] {
  assertSourceAncestors(directory);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe package directory: ${directory}`);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unsafe package link: ${file}`);
    if (entry.isDirectory()) return skipNestedModules && entry.name === 'node_modules' ? [] : regularFiles(file, skipNestedModules);
    if (!entry.isFile()) throw new Error(`Unsafe package source: ${file}`);
    return [file];
  });
}

export function serverRuntimeEntries(projectRoot: string): Entry[] {
  projectRoot = path.resolve(projectRoot);
  const service = path.join(projectRoot, 'services/nas-record-api');
  const prefix = 'server/services/nas-record-api/';
  const entry = (name: string, allowEmpty = false) => ({ name: prefix + name, source: path.join(service, name), allowEmpty });
  const entries = ['dist/server.cjs', 'package.json', 'package-lock.json'].map(name => entry(name));
  for (const file of entries) {
    if (!fs.existsSync(file.source)) throw new Error(`Server runtime missing: ${file.name}`);
    assertSourceAncestors(file.source);
    const stat = fs.lstatSync(file.source);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error(`Unsafe server runtime: ${file.name}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(service, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(service, 'package-lock.json'), 'utf8'));
  assert.equal(lock.lockfileVersion, 3, 'Server package-lock v3 required');
  // The isolated R7 checkout intentionally reuses its installed dependency
  // root through a junction. Resolve that root once; reject links below it.
  const modulesRoot = fs.realpathSync(path.join(service, 'node_modules'));
  const dependencies: Array<{ source: string; dependencies: Record<string, string> }> = [{ source: path.join(service, 'package.json'), dependencies: manifest.dependencies ?? {} }];
  for (const [name, metadata] of Object.entries(lock.packages) as Array<[string, any]>) {
    if (!name || metadata.dev) continue;
    if (!/^(?:node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/.test(name) || name.split('/').some(part => part === '.' || part === '..')) throw new Error('Unsafe locked package path');
    if (metadata.link || metadata.os || metadata.cpu || metadata.hasInstallScript) throw new Error(`Server package requires target-platform preparation: ${name}`);
    const directory = path.join(modulesRoot, name.slice('node_modules/'.length));
    for (let current = directory; current !== modulesRoot; current = path.dirname(current)) {
      if (!fs.existsSync(current)) throw new Error(`Server dependency missing: ${name}`);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Unsafe package ancestor: ${name}`);
      if (current === path.dirname(current)) throw new Error('Unsafe server dependency root');
    }
    const packageJson = path.join(directory, 'package.json');
    if (!fs.existsSync(packageJson)) throw new Error(`Server dependency missing: ${name}`);
    assertSourceAncestors(packageJson);
    const installed = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    assert.equal(installed.version, metadata.version, `Server dependency version mismatch: ${name}`);
    assert.deepEqual(installed.dependencies ?? {}, metadata.dependencies ?? {}, `Server dependency manifest mismatch: ${name}`);
    dependencies.push({ source: packageJson, dependencies: installed.dependencies ?? {} });
    entries.push(...regularFiles(directory, true).map(source => ({ name: prefix + 'node_modules/' + path.relative(modulesRoot, source).split(path.sep).join('/'), source, allowEmpty: true })));
  }
  assert.deepEqual(manifest.dependencies ?? {}, lock.packages['']?.dependencies ?? {}, 'Server package and lock dependency mismatch');
  const selected = new Set(entries.map(file => path.resolve(file.source)));
  for (const owner of dependencies) for (const dependency of Object.keys(owner.dependencies)) {
    const resolved = createRequire(owner.source).resolve(dependency);
    if (!selected.has(path.resolve(resolved))) throw new Error(`Server dependency missing from package: ${dependency}`);
  }
  return entries;
}

export function validateServerMounts(compose: any, confirmedDataRoot: string) {
  const mounts = compose.services?.['record-api']?.volumes;
  assert.ok(Array.isArray(mounts) && mounts.length === 3, 'Exactly three separate bind mounts required');
  const modes: Record<string, boolean> = { '/opt/typingking/server': true, '/var/lib/typingking/records': false, '/run/typingking-private': true };
  assert.deepEqual(mounts.map((mount: any) => mount.target).sort(), Object.keys(modes).sort());
  for (const mount of mounts) {
    assert.equal(mount.type, 'bind');
    assert.equal(mount.read_only, modes[mount.target]);
    assert.equal(mount.bind?.create_host_path, false, 'Missing host folders must not be silently created');
    assert.equal(typeof mount.source, 'string');
    if (/__[A-Z0-9_]+__/.test(mount.source)) throw new Error('Unresolved host path placeholder');
    if (!path.posix.isAbsolute(mount.source) || path.posix.normalize(mount.source) !== mount.source || mount.source === '/' || /[\x00-\x1f]/.test(mount.source)) throw new Error('Unsafe host path');
  }
  assert.equal(mounts.find((mount: any) => mount.target === '/var/lib/typingking/records').source, confirmedDataRoot, 'Record mount must exactly match the user-confirmed typingking child path');
  for (let first = 0; first < mounts.length; first++) for (let second = first + 1; second < mounts.length; second++) {
    const a = mounts[first].source, b = mounts[second].source;
    if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) throw new Error('Runtime, data and protected secret mount paths overlap');
  }
  return mounts;
}

export function serverTemplateEntries(projectRoot: string): Entry[] {
  const directory = path.join(projectRoot, 'deployment/nas-production/server');
  const entries = [
    ...['config/event-config.production.template.json', 'config/token-manifest.production.template.json', 'container/compose.review-only.template.yaml', 'README_STORAGE_AND_CONTAINER.md'].map(name => ({ name: 'server/' + name, source: path.join(directory, name) })),
    { name: 'server/config/stage_texts.csv', source: path.join(projectRoot, 'events/geumcheon-2026/stage_texts.csv') }
  ];
  entries.forEach(entry => assertSourceAncestors(entry.source));
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(directory, 'config', name), 'utf8'));
  const event = read('event-config.production.template.json');
  assert.deepEqual(Object.keys(event).sort(), ['schemaVersion', 'eventId', 'recordBaseFolderName', 'stageTextCatalogPath', 'allowedSessions', 'aiRanges'].sort());
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.eventId, 'geumcheon-science-festival-2026');
  assert.equal(event.recordBaseFolderName, '기록저장');
  assert.equal(event.stageTextCatalogPath, '__ABSOLUTE_STAGE_TEXT_CATALOG_PATH__');
  assert.deepEqual(event.allowedSessions, { official: [{ sessionId: '__OFFICIAL_SESSION_ID__', dayNo: '__OFFICIAL_DAY_NO__', roundNo: '__OFFICIAL_ROUND_NO__' }] });
  assert.deepEqual(event.aiRanges, { official: [[100,125],[125,150],[150,200]], practice: [[100,125],[125,150],[150,200]] });
  const tokens = read('token-manifest.production.template.json');
  assert.deepEqual(Object.keys(tokens).sort(), ['manifestVersion', 'eventId', 'tokens'].sort());
  assert.equal(tokens.manifestVersion, 1);
  assert.equal(tokens.eventId, event.eventId);
  assert.deepEqual(tokens.tokens.map((token: any) => [token.deviceId, token.role]), [['PC01','writer'],['PC02','writer'],['PC03','writer'],['PC04','writer'],['LEADERBOARD01','leaderboard'],['LEADERBOARD01','operator']]);
  for (const token of tokens.tokens) {
    assert.deepEqual(Object.keys(token).sort(), ['tokenId','tokenHash','deviceId','role','allowedSessions','expiresAt','revokedAt'].sort());
    assert.match(token.tokenId, /^(writer-pc0[1-4]|leaderboard-read|leaderboard-operator)$/);
    assert.match(token.tokenHash, /^__SHA256_OF_[A-Z0-9_]+_TOKEN__$/);
    assert.deepEqual(token.allowedSessions, ['official']);
    assert.equal(token.expiresAt, '__TOKEN_EXPIRY_ISO8601__');
    assert.equal(token.revokedAt, null);
  }
  const compose = createRequire(import.meta.url)('js-yaml').load(fs.readFileSync(path.join(directory, 'container/compose.review-only.template.yaml'), 'utf8'));
  const mounts = [
    ['__ABSOLUTE_CONFIRMED_SERVER_RUNTIME_PATH__', '/opt/typingking/server', true],
    ['__ABSOLUTE_CONFIRMED_TEMP_SHARE_TYPINGKING_DATA_PATH__', '/var/lib/typingking/records', false],
    ['__ABSOLUTE_PROTECTED_TYPINGKING_SECRETS_PATH__', '/run/typingking-private', true]
  ].map(([source, target, read_only]) => ({ type: 'bind', source, target, read_only, bind: { create_host_path: false } }));
  // Reject populated deployment values and extra fields before they can enter
  // a public ZIP. Operational copies are prepared separately after approval.
  assert.deepEqual(compose, {
    'x-typingking-status': 'REVIEW_ONLY_NOT_APPLIED',
    services: { 'record-api': {
      image: '__APPROVED_NODE24_IMAGE_WITH_DIGEST__', user: '__APPROVED_CONTAINER_UID__:__APPROVED_CONTAINER_GID__',
      network_mode: 'host', read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], restart: 'no',
      command: ['node', '/opt/typingking/server/services/nas-record-api/dist/server.cjs'],
      environment: {
        NAS_EVENT_CONFIG: '/run/typingking-private/event-config.production.json',
        NAS_TOKEN_MANIFEST: '/run/typingking-private/token-manifest.production.json',
        NAS_PARTICIPANT_HMAC_KEY_FILE: '/run/typingking-private/participant-hmac.key',
        NAS_DATA_ROOT: '/var/lib/typingking/records', NAS_BIND_HOST: '127.0.0.1', NAS_PORT: '8787'
      }, volumes: mounts
    } }
  });
  return entries;
}

export function serverReleaseManifest(projectRoot: string, sourceCommit: string) {
  assert.match(sourceCommit, /^[0-9a-f]{40}$/, 'A final source commit is required');
  const service = path.join(projectRoot, 'services/nas-record-api');
  const built = path.join(service, 'dist/server.cjs');
  const inputs = [
    ...regularFiles(path.join(service, 'src')),
    ...regularFiles(path.join(projectRoot, 'shared')),
    path.join(service, 'package.json'), path.join(service, 'package-lock.json')
  ].sort();
  const buildTime = fs.statSync(built).mtimeMs;
  for (const source of inputs) {
    if (fs.statSync(source).mtimeMs > buildTime) throw new Error('Server build is older than its inputs; rebuild after the source freeze');
  }
  const lock = JSON.parse(fs.readFileSync(path.join(service, 'package-lock.json'), 'utf8'));
  return {
    schemaVersion: 1, sourceCommit, measuredAt: new Date().toISOString(),
    serverSha256: digest(built), lockfileSha256: digest(path.join(service, 'package-lock.json')),
    runtimeRequirement: 'Approved Node 24 runtime/image; not included in this ZIP',
    buildProvenance: 'Source hashes and timestamp guard; pair with the final build run evidence',
    runtimeDependencies: Object.entries(lock.packages).filter(([name, metadata]: [string, any]) => name && !metadata.dev).map(([name, metadata]: [string, any]) => ({ name, version: metadata.version })),
    sourceFiles: inputs.map(source => ({ name: path.relative(projectRoot, source).split(path.sep).join('/'), sha256: digest(source) })),
    actualNas: 'NOT_RUN', actualContainer: 'NOT_RUN', productionRelease: 'HOLD'
  };
}

export async function packageRelease(relative = 'delivery') {
  const output = safeNewOutput(path.join(root, 'Codex/Outputs/R7'), relative);
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const sourceCommit = git(['rev-parse', 'HEAD']);
  assert.equal(git(['status', '--porcelain', '--untracked-files=normal', '--', 'apps', 'electron', 'shared', 'events', 'services/nas-record-api', 'scripts/r7-package-release.ts', 'deployment/nas-production', 'package.json', 'package-lock.json']), '', 'Freeze and commit the client/server source before creating delivery packages');
  const serverEntries = [...serverRuntimeEntries(root), ...serverTemplateEntries(root)];
  const serverManifest = serverReleaseManifest(root, sourceCommit);
  const exeEntries = officialArtifacts.map(([folder,name]) => ({name, source:path.join(root,'release-build',folder,name)}));
  for (const e of exeEntries) assert.ok(fs.statSync(e.source).size > 0);
  const resources = publicResources(root).map(name => ({name, source:path.join(root,name)}));
  const config = JSON.parse(fs.readFileSync(path.join(root,'events/geumcheon-2026/event.config.json'),'utf8'));
  assert.deepEqual(Object.entries(config.variants).filter(([,v]: [string,any]) => v.enabled).map(([k]) => k).sort(), ['ai','ai-leaderboard']);
  const profiles = ['leaderboard_01', 'player_01', 'player_02', 'player_03', 'player_04'].map((stem,i) => {
    const name = `${stem}.device-profile.json`;
    const source = path.join(root,'deployment/nas-production/device-profiles',name);
    const validation = validateTemplate(JSON.parse(fs.readFileSync(source,'utf8')), i ? `PC0${i}` : 'LEADERBOARD01', i ? 'player' : 'leaderboard');
    return {name,source,validation};
  });
  fs.mkdirSync(output, {recursive:true});
  const generated = path.join(output,'profile-support');
  fs.mkdirSync(generated);
  const serverSupport = path.join(output, 'server-support');
  fs.mkdirSync(serverSupport);
  const serverManifestPath = path.join(serverSupport, 'SERVER_RELEASE_MANIFEST.json');
  fs.writeFileSync(serverManifestPath, JSON.stringify(serverManifest, null, 2)+'\n');
  fs.writeFileSync(path.join(generated,marker), JSON.stringify({schemaVersion:1,kind:'typingking-geumcheon-client-release'})+'\n');
  fs.writeFileSync(path.join(generated,'VALIDATION.json'), JSON.stringify(profiles.map(p => p.validation), null, 2)+'\n');
  fs.writeFileSync(path.join(generated,'README.md'), '# R7 공식 전용 장치 프로필 5개\n\n기존 운영 설정을 백업한 뒤 해당 장치 파일을 적용하세요. 이번 패키지는 자동 적용하지 않습니다. endpoint, 공식 sessionId, dayNo, roundNo 및 별도 인증정보가 미확정입니다. dayNo/roundNo는 JSON 숫자로 입력한 뒤 실제 스키마로 재검사하세요. 토큰·비밀번호·개인키는 별도 안전한 기존 인증 절차로 설정하며 ZIP에 넣지 않습니다.\n\nNAS 실행본은 EXE와 동봉 부속파일의 폴더 구조 전체를 유지합니다. 검토 EXE는 단독 실행용입니다. 실제 NAS/물리 5대 적용·저장 검증은 NOT_RUN, PRODUCTION_RELEASE=HOLD입니다. Container Manager Record API 배포는 후속 미확정 단계이며 현재 설치 완료가 아닙니다.\n');
  const groups = [
    {name:'R7_OFFICIAL_REVIEW_EXE_2종.zip', entries:exeEntries.slice(0,2)},
    {name:'R7_OFFICIAL_NAS_CLIENT_RELEASE.zip', entries:[...exeEntries.slice(2),...resources,{name:marker,source:path.join(generated,marker)}]},
    {name:'R7_OFFICIAL_DEVICE_PROFILES.zip', entries:[...profiles.map(({name,source}) => ({name,source})), ...['README.md','VALIDATION.json'].map(name => ({name,source:path.join(generated,name)}))]},
    {name:'R7_OFFICIAL_NAS_SERVER_RELEASE.zip', entries:[...serverEntries,{name:'SERVER_RELEASE_MANIFEST.json',source:serverManifestPath}]},
  ];
  const manifest = [];
  for (const group of groups) {
    const target = path.join(output,group.name);
    const files = await writeZip(target,group.entries);
    manifest.push({name:group.name,bytes:fs.statSync(target).size,sha256:digest(target),files});
  }
  fs.writeFileSync(path.join(output,'R7_PACKAGE_MANIFEST.json'), JSON.stringify({releaseCandidate:'R7-ppt-official-only-20260909', sourceCommit, productionRelease:'HOLD', packages:manifest},null,2)+'\n');
  return output;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packageRelease(process.argv[2]).then(console.log).catch(error => {console.error(error);process.exitCode=1;});
