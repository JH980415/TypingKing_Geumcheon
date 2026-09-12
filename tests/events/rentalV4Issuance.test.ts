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

    const originals=buildRentalProfiles(input,{now}).profiles.map(({fileName})=>{
      const file=path.join(privateInputs,fileName);
      return {file,fileName,bytes:fs.readFileSync(file)};
    });
    const renewalRequest={...request,deploymentId:request.deploymentId+'-renewed',renewalProfilePaths:originals.map(p=>p.file),outputDirectory:path.join(base,'renewed')};
    const renewalRequestFile=write('synthetic-renewal-request.json',JSON.stringify(renewalRequest));
    const renewalCli=spawnSync(process.execPath,[path.resolve('node_modules/tsx/dist/cli.mjs'),path.resolve('scripts/rental-v4-issue-profiles.ts'),renewalRequestFile],{encoding:'utf8',windowsHide:true,timeout:60000});
    assert.equal(renewalCli.status,0,renewalCli.stderr);
    assert.equal(JSON.parse(renewalCli.stdout).deploymentId,renewalRequest.deploymentId);
    for(const original of originals){
      assert.ok(fs.readFileSync(original.file).equals(original.bytes));
      const renewed=JSON.parse(fs.readFileSync(path.join(renewalRequest.outputDirectory,original.fileName),'utf8'));
      assert.ok(JSON.stringify(renewed.administrator)===JSON.stringify(JSON.parse(original.bytes.toString()).administrator));
      assert.ok(!renewalCli.stdout.includes(original.file));
    }
    for(const key of input.keys)assert.ok(!renewalCli.stdout.includes(key.token)&&!renewalCli.stderr.includes(key.token));
    assert.ok(!renewalCli.stdout.includes(input.administratorPassword));
    const refusedRequest={...renewalRequest,renewalProfilePaths:[path.resolve('package.json'),...renewalRequest.renewalProfilePaths.slice(1)],outputDirectory:path.join(base,'rejected-renewal')};
    const refusedFile=write('synthetic-refused-renewal.json',JSON.stringify(refusedRequest));
    const refused=spawnSync(process.execPath,[path.resolve('node_modules/tsx/dist/cli.mjs'),path.resolve('scripts/rental-v4-issue-profiles.ts'),refusedFile],{encoding:'utf8',windowsHide:true,timeout:60000});
    assert.equal(refused.status,1);
    assert.equal(fs.existsSync(refusedRequest.outputDirectory),false);

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


test('explicit renewal from two actual issuer batches is accepted by the cold runtime', async context=>{
  const first=syntheticInput(), renewal=syntheticInput();
  const current=new Date(), previousTime=new Date(current.getTime()-7200000);
  first.input.issuedAt=first.input.notBefore=previousTime.toISOString();
  first.input.expiresAt=new Date(current.getTime()-3600000).toISOString();
  renewal.input.issuedAt=renewal.input.notBefore=current.toISOString();
  renewal.input.expiresAt=new Date(current.getTime()+3600000).toISOString();
  renewal.input.deploymentId+='-renewed';
  renewal.input.administratorPassword=first.input.administratorPassword;
  for(const input of [first.input,renewal.input])for(const token of input.tokenManifest.tokens)token.expiresAt=new Date(current.getTime()+7200000).toISOString();
  const oldBatch=buildRentalProfiles(first.input,{now:previousTime});
  const nextBatch=buildRentalProfiles({...renewal.input,renewalProfiles:oldBatch.profiles},{now:current});
  const normalSecondBatch=buildRentalProfiles(renewal.input,{now:current});
  const old=oldBatch.profiles[0]!, next=nextBatch.profiles[0]!;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rental-v4-issued-renewal-'));
  context.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'client'),runtimeRoot=path.join(root,'runtime');
  fs.mkdirSync(directory);fs.mkdirSync(path.join(runtimeRoot,'nas'),{recursive:true});
  const selectedFilePath=path.join(directory,old.fileName),selectionPath=path.join(root,'selected-profile.bin');
  const protectedPath=path.join(runtimeRoot,'nas','deployment-profile.bin');
  const storage={isEncryptionAvailable:()=>true,encryptString:(value:string)=>Buffer.from('synthetic-protected:'+value),
    decryptString:(value:Buffer)=>{assert.equal(value.subarray(0,20).toString(),'synthetic-protected:');return value.subarray(20).toString();}};
  const runtime=await import('../../electron/deploymentProfile');
  fs.writeFileSync(selectedFilePath,JSON.stringify(old.profile));
  runtime.saveDeploymentSelection(selectionPath,directory,old.profile,selectedFilePath,storage);
  fs.writeFileSync(protectedPath,storage.encryptString(JSON.stringify(old.profile)));
  const before=[fs.readFileSync(selectionPath),fs.readFileSync(protectedPath)];
  fs.writeFileSync(selectedFilePath,JSON.stringify(normalSecondBatch.profiles[0]!.profile));
  await assert.rejects(()=>runtime.renewExpiredAdjacentDeployment({selectionPath,directory,safeStorage:storage,runtimeRootForProfile:()=>runtimeRoot}),/PROFILE_PENDING_SCOPE_CHANGE/);
  assert.ok(fs.readFileSync(selectionPath).equals(before[0]!)&&fs.readFileSync(protectedPath).equals(before[1]!));
  fs.writeFileSync(selectedFilePath,JSON.stringify(next.profile));
  assert.equal(await runtime.renewExpiredAdjacentDeployment({selectionPath,directory,safeStorage:storage,runtimeRootForProfile:()=>runtimeRoot}),true);
  assert.ok(JSON.stringify(next.profile.administrator)===JSON.stringify(old.profile.administrator));
  assert.ok(new runtime.DeploymentProfileStore(protectedPath,storage).token('writer')===next.profile.credentials.writer!.token);
});


function explicitRenewalFixture(){
  const {input,now}=syntheticInput();
  const previous=buildRentalProfiles(input,{now}).profiles;
  const renewal={...syntheticInput().input,administratorPassword:input.administratorPassword,renewalProfiles:structuredClone(previous)};
  renewal.deploymentId+='-renewed';
  return {input:renewal,previous,now};
}
test('explicit renewal preserves each distinct verifier and only rotates approved credential and validity fields',()=>{
  const {input,previous,now}=explicitRenewalFixture();
  const before=JSON.stringify(previous);
  const next=buildRentalProfiles(input,{now});
  assert.equal(new Set(previous.map(p=>p.profile.administrator.salt)).size,5);
  assert.equal(JSON.stringify(previous),before);
  for(const original of previous){
    const renewed=next.profiles.find(p=>p.fileName===original.fileName)!;
    assert.ok(JSON.stringify(renewed.profile.administrator)===JSON.stringify(original.profile.administrator));
    assert.deepEqual(renewed.profile.device,original.profile.device);
    assert.deepEqual(renewed.profile.allowedSessions,original.profile.allowedSessions);
    for(const role of Object.keys(original.profile.credentials) as Array<'writer'|'leaderboard'>){
      assert.ok(renewed.profile.credentials[role]!.token!==original.profile.credentials[role]!.token);
      assert.deepEqual({...renewed.profile.credentials[role],token:'redacted'},{...original.profile.credentials[role],token:'redacted'});
    }
  }
  const receipt=JSON.stringify(next.receipt);
  for(const old of previous)for(const credential of Object.values(old.profile.credentials))assert.ok(!receipt.includes(credential.token));
});
test('explicit renewal refuses wrong administrator, incomplete original set and any scope change',()=>{
  const changes:Array<{name:string;edit:(input:any)=>void}>=[
    {name:'wrong password',edit:i=>i.administratorPassword='AnotherStrongAdministrator2026!'},
    {name:'one verifier mismatch',edit:i=>i.renewalProfiles[4].profile.administrator.hash='0'.repeat(128)},
    {name:'missing original',edit:i=>i.renewalProfiles.pop()},
    {name:'extra original',edit:i=>i.renewalProfiles.push(structuredClone(i.renewalProfiles[0]))},
    {name:'duplicate device',edit:i=>i.renewalProfiles[4]=structuredClone(i.renewalProfiles[0])},
    {name:'renamed original',edit:i=>i.renewalProfiles[0].fileName='renamed.device-profile.json'},
    {name:'API change',edit:i=>i.apiBaseUrl='https://127.0.0.1:9555'},
    {name:'default session change',edit:i=>i.defaultSessionId='v4-round-2'},
    {name:'session scope change',edit:i=>i.eventConfig.allowedSessions.official.push({sessionId:'new-round',dayNo:2,roundNo:1})},
    {name:'device timeout change',edit:i=>i.renewalProfiles[2].profile.device.requestTimeoutMs=6000},
    {name:'wrong credential role',edit:i=>i.renewalProfiles[3].profile.credentials.writer.role='leaderboard'},
    {name:'malformed old profile',edit:i=>i.renewalProfiles[0].profile.extra='not-allowed'},
    {name:'future new activation',edit:i=>i.notBefore='2026-09-12T01:00:00.000Z'},
    {name:'expired new profile',edit:i=>i.expiresAt='2026-09-11T00:00:00.000Z'}
  ];
  for(const change of changes){
    const {input,now}=explicitRenewalFixture();change.edit(input);let result:unknown;
    assert.throws(()=>{result=buildRentalProfiles(input,{now});},undefined,change.name);
    assert.equal(result,undefined,change.name+' must not return a partial batch');
  }
});
test('failed explicit renewal creates no output and leaves all five local originals unchanged',async context=>{
  const {input,previous,now}=explicitRenewalFixture();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rental-v4-renewal-output-'));
  context.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  const originals=previous.map(p=>{const file=path.join(root,p.fileName),bytes=Buffer.from(JSON.stringify(p.profile));fs.writeFileSync(file,bytes);return {file,bytes};});
  for(const [index,edit] of [
    (value:any)=>value.administratorPassword='AnotherStrongAdministrator2026!',
    (value:any)=>value.renewalProfiles[4].profile.administrator.hash='0'.repeat(128),
    (value:any)=>value.defaultSessionId='v4-round-2',
    (value:any)=>value.renewalProfiles.pop()
  ].entries()){
    const candidate=structuredClone(input);edit(candidate);
    const outputDirectory=path.join(root,'rejected-'+index);
    await assert.rejects(()=>issueRentalProfiles({input:candidate,approvedOutputRoot:root,outputDirectory,now}));
    assert.equal(fs.existsSync(outputDirectory),false);
    for(const original of originals)assert.ok(fs.readFileSync(original.file).equals(original.bytes));
  }
});
