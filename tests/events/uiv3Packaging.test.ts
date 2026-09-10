import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import * as packager from '../../scripts/r7-package-release';

test('v3 delivery selects new official binaries rather than preserved R7 or stale practice files', async () => {
  const select = (packager as any).officialExecutableEntries;
  assert.equal(typeof select, 'function', 'Version-scoped executable selection is required');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'uiv3-selection-'));
  try {
    for (const [folder,name] of packager.officialArtifacts) {
      for (const [prefix,bytes] of [['', 'preserved-r7'], ['uiv3', 'new-ui-v3']]) {
        const file = path.join(temporary,'release-build',prefix,folder,name);
        fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,bytes);
      }
    }
    fs.writeFileSync(path.join(temporary,'release-build/uiv3/practice.exe'),'stale');
    const selected = select(temporary,'UIV3');
    assert.equal(selected.length,4);
    assert.ok(selected.every((entry:any)=>fs.readFileSync(entry.source,'utf8')==='new-ui-v3'));
    const archived = await packager.writeZip(path.join(temporary,'new.zip'), selected.slice(0,2));
    const expected = crypto.createHash('sha256').update('new-ui-v3').digest('hex');
    assert.ok(archived.every(entry=>entry.bytes===9&&entry.sha256===expected));
    assert.deepEqual(archived.map(entry=>entry.name).sort(),['G-Science AI 타자왕_검토용.exe','G-Science AI 타자왕_리더보드_검토용.exe'].sort());
    assert.ok(select(temporary,'R7').every((entry:any)=>fs.readFileSync(entry.source,'utf8')==='preserved-r7'));
    assert.throws(()=>select(temporary,'../escape'),/release flavor/);
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
});

test('all four v3 builder allowlists deliver the three approved assets with isolated output folders', () => {
  const yaml = createRequire(import.meta.url)('js-yaml');
  const files = ['electron-builder.geumcheon-ai-review.yml','electron-builder.geumcheon-ai-leaderboard-review.yml',
    'electron-builder.geumcheon-ai.yml','electron-builder.geumcheon-ai-leaderboard.yml'];
  for(const file of files){
    const config=yaml.load(fs.readFileSync(file,'utf8'));
    assert.ok(config.directories.output.startsWith('release-build/uiv3/'),file+' must preserve R7 builds');
    const resource=config.extraResources.find((entry:any)=>entry.from==='events/geumcheon-2026');
    for(const asset of ['title_logo_062843.png','geumnarae_main_052455_alpha.png','geumnarae_stage1_defeat_054108_alpha.png']){
      assert.ok(resource.filter.includes('assets/'+asset),file+' omits active '+asset);
    }
    assert.equal(config.extraMetadata.typingKingReleaseCandidate,'UI-v3-20260910');
    assert.equal(config.win.signExecutable,false);
  }
});
