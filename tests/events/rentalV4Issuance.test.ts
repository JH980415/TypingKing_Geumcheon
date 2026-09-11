import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildRentalProfiles, issueRentalProfiles, assertPrivateLocalPath } from '../../scripts/rental-v4-issue-profiles';

export function syntheticInput() {
  const now = new Date('2026-09-12T00:00:00.000Z');
  const eventId = 'geumcheon-science-festival-2026';
  const tokens: any[] = [], keys: any[] = [];
  for (const deviceId of ['PC01','PC02','PC03','PC04','LEADERBOARD01']) {
    for (const role of deviceId === 'LEADERBOARD01' ? ['leaderboard'] : ['writer','leaderboard']) {
      const tokenId = deviceId + '-' + role;
      const token = crypto.randomBytes(32).toString('base64url');
      keys.push({ tokenId, token });
      tokens.push({ tokenId, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), deviceId, role,
        allowedSessions: ['official'], expiresAt: '2026-09-14T00:00:00.000Z', revokedAt: null });
    }
  }
  return { now, input: {
    stage: 'synthetic' as const, deploymentId: 'rental-v4-synthetic-20260912',
    apiBaseUrl: 'https://127.0.0.1:9443', issuedAt: now.toISOString(),
    notBefore: now.toISOString(), expiresAt: '2026-09-13T00:00:00.000Z',
    defaultSessionId: 'v4-round-1',
    eventConfig: { schemaVersion: 1, eventId, recordBaseFolderName: '기록저장',
      stageTextCatalogPath: '/run/typingking-private/stage_texts.csv',
      allowedSessions: { official: [{sessionId:'v4-round-1',dayNo:1,roundNo:1},{sessionId:'v4-round-2',dayNo:1,roundNo:2}] },
      aiRanges: {official:[[100,125],[125,150],[150,200]],practice:[[100,125],[125,150],[150,200]]} },
    tokenManifest: { manifestVersion:1,eventId,tokens }, keys,
    administratorPassword: crypto.randomBytes(24).toString('base64url') + 'Aa1!'
  }};
}
test('batch creates five original-name profiles with nine separately bound credentials and no operator', () => {
  const {input,now}=syntheticInput();
  const result=buildRentalProfiles(input,{now});
  assert.deepEqual(result.profiles.map(p=>p.fileName), ['player_01.device-profile.json','player_02.device-profile.json',
    'player_03.device-profile.json','player_04.device-profile.json','leaderboard_01.device-profile.json']);
  const raw=JSON.stringify(result.receipt);
  for(const key of input.keys) assert.ok(!raw.includes(key.token));
  assert.ok(!raw.includes(input.administratorPassword));
  assert.ok(!raw.includes('"hash"'));
  assert.equal(result.receipt.stage,'SYNTHETIC');
  assert.equal(result.receipt.productionRelease,'HOLD');
  for(const {profile} of result.profiles) {
    assert.equal(profile.environment,'test');
    assert.equal(profile.credentials.leaderboard.deviceId,profile.device.deviceId);
    assert.equal(profile.allowedSessions.length,2);
    assert.equal(profile.device.sessions.official.sessionId,input.defaultSessionId);
    assert.equal(profile.credentials.writer?.role,profile.device.deviceId === 'LEADERBOARD01' ? undefined : 'writer');
    assert.notEqual(profile.credentials.writer?.token,profile.credentials.leaderboard.token);
    assert.deepEqual(Object.keys(profile.credentials).sort(), profile.device.deviceId === 'LEADERBOARD01' ? ['leaderboard'] : ['leaderboard','writer']);
    assert.equal(crypto.scryptSync(input.administratorPassword,Buffer.from(profile.administrator.salt,'hex'),64).toString('hex'),profile.administrator.hash);
  }
});
test('missing reader binding or key refuses entire batch',()=>{
  const {input,now}=syntheticInput();
  input.tokenManifest.tokens=input.tokenManifest.tokens.filter(t=>t.tokenId!=='PC03-leaderboard');
  assert.throws(()=>buildRentalProfiles(input,{now}),/CREDENTIAL_BINDING/);
  const other=syntheticInput(); other.input.keys.pop();
  assert.throws(()=>buildRentalProfiles(other.input,{now}),/KEY_MISSING/);
});
test('hash mismatch, expired, revoked and out-of-scope existing keys fail closed',()=>{
  for(const mutate of [
    (i:any)=>i.keys[0].token=crypto.randomBytes(32).toString('base64url'),
    (i:any)=>i.tokenManifest.tokens[0].expiresAt='2026-09-11T00:00:00.000Z',
    (i:any)=>i.tokenManifest.tokens[0].revokedAt='2026-09-10T00:00:00.000Z',
    (i:any)=>i.tokenManifest.tokens[0].allowedSessions=['practice'],
    (i:any)=>i.tokenManifest.tokens[0].allowedSessions=['official','practice'],
    (i:any)=>i.tokenManifest.tokens[0].deviceId='PC03',
  ]) {
    const {input,now}=syntheticInput(); mutate(input);
    assert.throws(()=>buildRentalProfiles(input,{now}),/CREDENTIAL|KEY/);
  }
});
test('refuses placeholders, weak admin, duplicate token reuse, event and session disagreement',()=>{
  for(const mutate of [
    (i:any)=>i.keys[0].token='__WRITER_PC01_TOKEN__',
    (i:any)=>i.administratorPassword='password',
    (i:any)=>{i.keys[1].token=i.keys[0].token;i.tokenManifest.tokens[1].tokenHash=i.tokenManifest.tokens[0].tokenHash;},
    (i:any)=>i.tokenManifest.eventId='other-event',
    (i:any)=>i.defaultSessionId='absent',
    (i:any)=>i.eventConfig.allowedSessions.official[0].roundNo=0,
    (i:any)=>i.eventConfig.allowedSessions.official.push(i.eventConfig.allowedSessions.official[0]),
  ]) {const {input,now}=syntheticInput();mutate(input);assert.throws(()=>buildRentalProfiles(input,{now}));}
});
test('existing operator manifest entries are permitted but their secrets are never exported or required',()=>{
  const {input,now}=syntheticInput();
  input.tokenManifest.tokens.push({...input.tokenManifest.tokens[0],tokenId:'existing-operator',
    tokenHash:crypto.randomBytes(32).toString('hex'),deviceId:'LEADERBOARD01',role:'operator'});
  const result=buildRentalProfiles(input,{now});
  assert.equal(JSON.stringify(result.profiles).includes('existing-operator'),false);
});
test('test, synthetic, production are distinct and production endpoint/approval are mandatory',()=>{
  const {input,now}=syntheticInput();
  const prod={...input,stage:'production' as const};
  assert.throws(()=>buildRentalProfiles(prod,{now}),/APPROVAL|ENDPOINT/);
  const approved={...prod,apiBaseUrl:'https://typingking.thepmd.synology.me',approvalReference:'operator-approved-local-issuance'};
  const result=buildRentalProfiles(approved,{now});
  assert.equal(result.receipt.stage,'PRODUCTION');
  assert.equal(result.profiles[0].profile.environment,'production');
  assert.equal(result.receipt.productionRelease,'HOLD');
  assert.equal(buildRentalProfiles({...input,stage:'test',approvalReference:'approved-test'},{now}).receipt.stage,'TEST');
});
test('future activation is issuable but expiry cannot exceed any selected server key',()=>{
  const {input,now}=syntheticInput();
  input.notBefore='2026-09-12T04:00:00.000Z';
  assert.equal(buildRentalProfiles(input,{now}).profiles.length,5);
  input.expiresAt='2026-09-15T00:00:00.000Z';
  assert.throws(()=>buildRentalProfiles(input,{now}),/CREDENTIAL_EXPIRY/);
});
test('private outputs reject network, sync, traversal and pre-existing paths', async()=>{
  const {input,now}=syntheticInput();
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'rental-v4-issuer-'));
  try {
    assert.throws(()=>assertPrivateLocalPath('\\\\server\\share\\profiles'),/PATH/);
    assert.throws(()=>assertPrivateLocalPath('C:\\Users\\test\\OneDrive - Company\\profiles'),/PATH/);
    assert.throws(()=>assertPrivateLocalPath('C:\\Users\\test\\Dropbox\\profiles'),/PATH/);
    const output=path.join(base,'profiles');
    const result=await issueRentalProfiles({input,approvedOutputRoot:base,outputDirectory:output,now});
    assert.equal(result.receipt.stage,'SYNTHETIC');
    assert.equal(fs.existsSync(path.join(output,'UIV3_OFFICIAL_DEVICE_PROFILES.zip')),true);
    for(const item of result.receipt.files) assert.equal(fs.existsSync(path.join(output,item.fileName)),true);
    await assert.rejects(()=>issueRentalProfiles({input,approvedOutputRoot:base,outputDirectory:output,now}),/OUTPUT_EXISTS/);
    await assert.rejects(()=>issueRentalProfiles({input,approvedOutputRoot:base,outputDirectory:path.join(base,'..','escape'),now}),/OUTPUT_PATH/);
  } finally {fs.rmSync(base,{recursive:true,force:true});}
});

test('operator local-file command emits only receipt and protects every generated profile', async()=>{
  const {spawnSync}=await import('node:child_process');
  const {input}=syntheticInput();
  const now=new Date();input.issuedAt=now.toISOString();input.notBefore=now.toISOString();
  input.expiresAt=new Date(now.getTime()+3600000).toISOString();
  for(const token of input.tokenManifest.tokens)token.expiresAt=new Date(now.getTime()+7200000).toISOString();
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'rental-v4-cli-'));
  try{
    const privateInputs=path.join(base,'private-inputs');
    await issueRentalProfiles({input,approvedOutputRoot:base,outputDirectory:privateInputs,now});
    const write=(name:string,value:string)=>{const p=path.join(privateInputs,name);fs.writeFileSync(p,value,{mode:0o600});return p;};
    const request={
      schemaVersion:1,stage:input.stage,deploymentId:input.deploymentId,apiBaseUrl:input.apiBaseUrl,
      issuedAt:input.issuedAt,notBefore:input.notBefore,expiresAt:input.expiresAt,defaultSessionId:input.defaultSessionId,
      eventConfigPath:write('synthetic-event.json',JSON.stringify(input.eventConfig)),
      tokenManifestPath:write('synthetic-manifest.json',JSON.stringify(input.tokenManifest)),
      keys:input.keys.map((k,i)=>({tokenId:k.tokenId,filePath:write('synthetic-key-'+i+'.txt',k.token)})),
      administratorPasswordFile:write('synthetic-password.txt',input.administratorPassword),
      approvedOutputRoot:base,outputDirectory:path.join(base,'issued')
    };
    const requestFile=write('synthetic-request.json',JSON.stringify(request));
    const cli=spawnSync(process.execPath,[path.resolve('node_modules/tsx/dist/cli.mjs'),path.resolve('scripts/rental-v4-issue-profiles.ts'),requestFile],{encoding:'utf8',windowsHide:true,timeout:60000});
    assert.equal(cli.status,0,cli.stderr);
    for(const key of input.keys)assert.ok(!cli.stdout.includes(key.token)&&!cli.stderr.includes(key.token));
    assert.ok(!cli.stdout.includes(input.administratorPassword));
    assert.equal(JSON.parse(cli.stdout).stage,'SYNTHETIC');
    if(process.platform==='win32'){
      const code="$p='"+path.join(request.outputDirectory,'player_01.device-profile.json').replace(/'/g,"''")+"'; $acl=[IO.File]::GetAccessControl($p); $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18'); foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed){exit 1}}";
      const acl=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true});
      assert.equal(acl.status,0);
    }
  }finally{fs.rmSync(base,{recursive:true,force:true});}
});

test('public metadata cannot smuggle any selected secret through the sanitized receipt',()=>{
  for(const field of ['deploymentId','defaultSessionId'] as const){
    const {input,now}=syntheticInput();
    // Canonical hex reaches a secret guard, independent of the ID character guard.
    input.keys[0]!.token=crypto.randomBytes(32).toString('hex');
    input.tokenManifest.tokens[0]!.tokenHash=crypto.createHash('sha256').update(input.keys[0]!.token).digest('hex');
    const normalReceipt=JSON.stringify(buildRentalProfiles(input,{now}).receipt);
    for(const key of input.keys)assert.ok(!normalReceipt.includes(key.token));
    assert.ok(!normalReceipt.includes(input.administratorPassword));
    if(field==='deploymentId')input.deploymentId=input.keys[0]!.token;
    else {input.defaultSessionId=input.keys[0]!.token;input.eventConfig.allowedSessions.official[0]!.sessionId=input.keys[0]!.token;}
    let returnedReceipt:string|undefined;
    assert.throws(()=>{
      returnedReceipt=JSON.stringify(buildRentalProfiles(input,{now}).receipt);
    },(error:unknown)=>{
      assert.ok(error instanceof Error);
      assert.match(error.message,/^(PUBLIC_RECEIPT_SECRET_MATCH|PROFILE_FIELDS_INVALID)$/);
      for(const key of input.keys)assert.ok(!error.message.includes(key.token));
      assert.ok(!error.message.includes(input.administratorPassword));
      return true;
    });
    assert.equal(returnedReceipt,undefined);
  }
});
test('issuer follows the shared parser canonical server token encoding',()=>{
  for(const token of ['Aabcde0123456789_-'.repeat(3),'Abcdef0123456789_-'.repeat(3)+'=']){
    const {input,now}=syntheticInput();
    input.keys[0]!.token=token;
    input.tokenManifest.tokens[0]!.tokenHash=crypto.createHash('sha256').update(token).digest('hex');
    assert.throws(()=>buildRentalProfiles(input,{now}));
  }
});

test('server manifest hash binds encoded bearer UTF-8 text, not decoded random bytes',()=>{
  const {input,now}=syntheticInput();
  const token=input.keys[0]!.token;
  assert.equal(buildRentalProfiles(input,{now}).profiles.length,5);
  input.tokenManifest.tokens[0]!.tokenHash=crypto.createHash('sha256').update(Buffer.from(token,'base64url')).digest('hex');
  assert.throws(()=>buildRentalProfiles(input,{now}),/KEY_HASH_MISMATCH/);
});
test('receipt refuses administrator raw password and server token hash in otherwise valid metadata',()=>{
  for(const kind of ['password','tokenHash']){
    const {input,now}=syntheticInput();
    input.administratorPassword='ChosenAdministratorSecret123';
    input.deploymentId=kind==='password'?input.administratorPassword:input.tokenManifest.tokens[0]!.tokenHash;
    assert.throws(()=>buildRentalProfiles(input,{now}),/PUBLIC_RECEIPT_SECRET_MATCH/);
  }
});
