import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as packaging from '../../scripts/rental-v4-package-release';

const asar=createRequire(import.meta.url)('@electron/asar');
const stage=(root:string,out:string)=>(packaging as any).stageRentalApplication(root,out);
const verify=(root:string,archive:string)=>(packaging as any).verifyRentalRuntimeArchive(root,archive);

function fixture(){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rental-runtime-'));
  const root=path.join(temp,'source'),installed=path.join(temp,'installed','node_modules');
  fs.mkdirSync(root);fs.mkdirSync(installed,{recursive:true});
  const write=(name:string,value:string)=>{
    const target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);
  };
  const packages={
    '':{dependencies:{parent:'1.0.0'}},
    'node_modules/parent':{version:'1.0.0',dependencies:{child:'1.0.0'}},
    'node_modules/child':{version:'1.0.0'},
    'node_modules/dev-only':{version:'1.0.0',dev:true}
  };
  write('package.json',JSON.stringify({name:'fixture',version:'1.0.0',dependencies:{parent:'1.0.0'}}));
  write('package-lock.json',JSON.stringify({lockfileVersion:3,packages}));
  fs.symlinkSync(installed,path.join(root,'node_modules'),'junction');
  for(const [name,metadata] of Object.entries(packages)){
    if(!name)continue;
    write(name+'/package.json',JSON.stringify({name:name.slice(13),...metadata}));
    write(name+'/index.js',name.endsWith('/parent')?"module.exports=require('child');":"module.exports='runtime-ready';");
  }
  write('node_modules/unlocked-secret.txt','must-not-ship');
  write('dist-electron/electron/main.js',"module.exports=require('parent');");
  write('dist-renderer/index.html','renderer');
  return {root,temp,write,app:path.join(temp,'application')};
}

test('junction staging carries locked transitive runtime and excludes development or unlisted files',()=>{
  const f=fixture();
  try{
    stage(f.root,f.app);
    assert.equal(fs.lstatSync(path.join(f.app,'node_modules')).isSymbolicLink(),false);
    assert.equal(createRequire(path.join(f.app,'package.json'))('parent'),'runtime-ready');
    assert.equal(fs.existsSync(path.join(f.app,'node_modules/dev-only')),false);
    assert.equal(fs.existsSync(path.join(f.app,'node_modules/unlocked-secret.txt')),false);
    assert.equal(fs.readFileSync(path.join(f.app,'dist-renderer/index.html'),'utf8'),'renderer');
    assert.throws(()=>stage(f.root,f.app),/OUTPUT_EXISTS/);
  }finally{fs.rmSync(f.temp,{recursive:true,force:true});}
});

test('staging rejects missing, version-drifted and linked runtime files',()=>{
  for(const kind of ['missing','version','link']){
    const f=fixture();
    try{
      const target=path.join(f.root,'node_modules/child');
      if(kind==='missing')fs.renameSync(target,path.join(f.temp,'removed-child'));
      if(kind==='version')f.write('node_modules/child/package.json',JSON.stringify({name:'child',version:'2.0.0'}));
      if(kind==='link')fs.symlinkSync(f.root,path.join(target,'injected'),'junction');
      assert.throws(()=>stage(f.root,f.app),/RUNTIME_/);
    }finally{fs.rmSync(f.temp,{recursive:true,force:true});}
  }
});

test('ASAR gate rejects a direct-only archive and accepts the complete isolated closure',async()=>{
  const f=fixture();
  try{
    stage(f.root,f.app);
    const complete=path.join(f.temp,'complete.asar');
    await asar.createPackage(f.app,complete);
    assert.equal(verify(f.root,complete).packages,2);
    fs.renameSync(path.join(f.app,'node_modules/child'),path.join(f.temp,'removed-child'));
    const incomplete=path.join(f.temp,'incomplete.asar');
    await asar.createPackage(f.app,incomplete);
    assert.throws(()=>verify(f.root,incomplete),/RUNTIME_PACKAGE_MISSING/);
  }finally{fs.rmSync(f.temp,{recursive:true,force:true});}
});

test('ASAR gate cannot resolve an undeclared import through host NODE_PATH',async()=>{
  const f=fixture(),oldPath=process.env.NODE_PATH;
  try{
    const host=path.join(f.temp,'host/node_modules/host-only');
    fs.mkdirSync(host,{recursive:true});fs.writeFileSync(path.join(host,'index.js'),"module.exports='host';");
    process.env.NODE_PATH=path.dirname(host);
    f.write('node_modules/child/index.js',"module.exports=require('host-only');");
    stage(f.root,f.app);
    const archive=path.join(f.temp,'host-fallback.asar');await asar.createPackage(f.app,archive);
    assert.throws(()=>verify(f.root,archive),/RUNTIME_REQUIRE_FAILED/);
  }finally{
    if(oldPath===undefined)delete process.env.NODE_PATH;else process.env.NODE_PATH=oldPath;
    fs.rmSync(f.temp,{recursive:true,force:true});
  }
});
