import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateDeviceProfile } from '../shared/events/eventProfile';

type Entry = { name: string; source: string };
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const marker = '.typingking-geumcheon-client-release.json';
export const officialArtifacts = [
  ['geumcheon-review/ai', 'G-Science AI 타자왕_검토용.exe'],
  ['geumcheon-review/ai-leaderboard', 'G-Science AI 타자왕_리더보드_검토용.exe'],
  ['geumcheon/ai', 'G-Science AI 타자왕.exe'],
  ['geumcheon/ai-leaderboard', 'G-Science AI 타자왕 리더보드.exe'],
] as const;
const digest = (source: string) => crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');

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
    const stat = fs.lstatSync(entry.source);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error('Unsafe or empty source');
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
  candidate.sessions.official = {sessionId:'r7-synthetic-official', dayNo:1, roundNo:1};
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

export async function packageRelease(relative = 'delivery') {
  const output = safeNewOutput(path.join(root, 'Codex/Outputs/R7'), relative);
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
  fs.writeFileSync(path.join(generated,marker), JSON.stringify({schemaVersion:1,kind:'typingking-geumcheon-client-release'})+'\n');
  fs.writeFileSync(path.join(generated,'VALIDATION.json'), JSON.stringify(profiles.map(p => p.validation), null, 2)+'\n');
  fs.writeFileSync(path.join(generated,'README.md'), '# R7 공식 전용 장치 프로필 5개\n\n기존 운영 설정을 백업한 뒤 해당 장치 파일을 적용하세요. 이번 패키지는 자동 적용하지 않습니다. endpoint, 공식 sessionId, dayNo, roundNo 및 별도 인증정보가 미확정입니다. dayNo/roundNo는 JSON 숫자로 입력한 뒤 실제 스키마로 재검사하세요. 토큰·비밀번호·개인키는 별도 안전한 기존 인증 절차로 설정하며 ZIP에 넣지 않습니다.\n\nNAS 실행본은 EXE와 동봉 부속파일의 폴더 구조 전체를 유지합니다. 검토 EXE는 단독 실행용입니다. 실제 NAS/물리 5대 적용·저장 검증은 NOT_RUN, PRODUCTION_RELEASE=HOLD입니다. Container Manager Record API 배포는 후속 미확정 단계이며 현재 설치 완료가 아닙니다.\n');
  const groups = [
    {name:'R7_OFFICIAL_REVIEW_EXE_2종.zip', entries:exeEntries.slice(0,2)},
    {name:'R7_OFFICIAL_NAS_CLIENT_RELEASE.zip', entries:[...exeEntries.slice(2),...resources,{name:marker,source:path.join(generated,marker)}]},
    {name:'R7_OFFICIAL_DEVICE_PROFILES.zip', entries:[...profiles.map(({name,source}) => ({name,source})), ...['README.md','VALIDATION.json'].map(name => ({name,source:path.join(generated,name)}))]},
  ];
  const manifest = [];
  for (const group of groups) {
    const target = path.join(output,group.name);
    const files = await writeZip(target,group.entries);
    manifest.push({name:group.name,bytes:fs.statSync(target).size,sha256:digest(target),files});
  }
  fs.writeFileSync(path.join(output,'R7_PACKAGE_MANIFEST.json'), JSON.stringify({releaseCandidate:'R7-ppt-official-only-20260909', packages:manifest},null,2)+'\n');
  return output;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packageRelease(process.argv[2]).then(console.log).catch(error => {console.error(error);process.exitCode=1;});
