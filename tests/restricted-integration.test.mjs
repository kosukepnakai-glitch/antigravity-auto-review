import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test, after } from 'node:test';

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = fs.mkdtempSync(path.join(path.resolve('work'), 'restricted-integration-'));
const workspace = path.join(base, 'repo space');
const fixtureHome = path.join(base, 'home');
const emptyHooks = path.join(base, 'empty-hooks');
for (const p of [workspace, fixtureHome, emptyHooks]) fs.mkdirSync(p);
const shell = path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const cleanEnv = {...process.env, HOME:fixtureHome, USERPROFILE:fixtureHome, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'NUL', GIT_CONFIG_SYSTEM:'NUL', GIT_ATTR_NOSYSTEM:'1'};
delete cleanEnv.NODE_OPTIONS; delete cleanEnv.NODE_PATH;
for (const key of Object.keys(cleanEnv)) if (/^GIT_/i.test(key) && !['GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM','GIT_ATTR_NOSYSTEM'].includes(key)) delete cleanEnv[key];
function git(args) {
  const r=spawnSync('git.exe',['-c',`core.hooksPath=${emptyHooks}`,'-c',`init.templateDir=${emptyHooks}`,...args],{cwd:workspace,env:cleanEnv,encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(r.status,0,r.stderr); return r.stdout;
}
git(['init']); git(['config','core.autocrlf','false']); git(['config','user.name','Fixture']); git(['config','user.email','fixture@example.invalid']);
fs.writeFileSync(path.join(workspace,'tracked.txt'),'before\n');git(['add','tracked.txt']);git(['commit','-m','fixture']);fs.writeFileSync(path.join(workspace,'tracked.txt'),'after\n');
const installed=spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',path.join(source,'install.ps1'),'-WorkspacePath',workspace],{env:cleanEnv,encoding:'utf8',windowsHide:true,timeout:30000});
assert.equal(installed.status,0,installed.stdout+installed.stderr);
const home=path.join(workspace,'.agents','auto-review');
const {review}=await import(pathToFileURL(path.join(home,'auto_review.mjs')).href);
const {loadPolicy,commandFor,projectGrantPlan}=await import(pathToFileURL(path.join(home,'restricted-policy.mjs')).href);
const policyPath=path.join(home,'restricted-policy.json');
const policy=loadPolicy({requireEnabled:false});
const writePolicy=value=>fs.writeFileSync(policyPath,JSON.stringify(value,null,2)+'\n');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
async function withEnabled(body){const bytes=fs.readFileSync(policyPath);try{writePolicy({...JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')),enabled:true});return await body();}finally{fs.writeFileSync(policyPath,bytes);}}
const make=(operation='tracked-status',extra={})=>({toolCall:{name:'run_command',args:{CommandLine:commandFor(policy,operation,workspace),Cwd:workspace,IsDaemon:false,WaitMsBeforeAsync:5000,toolAction:'Inspecting tracked changes',toolSummary:'Tracked summary',...extra}},workspacePaths:[workspace]});
const verdict=async p=>(await review(p,cleanEnv)).decision;
// The parent test shell is Restricted; only the fixed child has the authorized RemoteSigned flag.
const invoke=(operation='tracked-status',env=cleanEnv,cwd=workspace)=>spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Restricted','-Command',commandFor(policy,operation,workspace)],{cwd,env,encoding:'utf8',windowsHide:true,timeout:45000});
const invokeDriver=()=>spawnSync(policy.assets.node.path,[path.join(home,'restricted-driver.mjs')],{cwd:workspace,env:cleanEnv,input:JSON.stringify({operation:'tracked-status',repoPath:workspace}),encoding:'utf8',windowsHide:true,timeout:10000});
function refused(result){assert.notEqual(result.status,0,result.stdout+result.stderr);assert.equal(JSON.parse(result.stdout).ok,false);}

test('installation is disabled by default and malformed enable flags cannot grant',async()=>{
  assert.equal(policy.version,2);assert.equal(policy.enabled,false);assert.throws(()=>loadPolicy());assert.equal(loadPolicy({requireEnabled:false}).enabled,false);
  const original=fs.readFileSync(policyPath);
  try{
    for(const enabled of [false,undefined,'true','false',1,0,null]){
      const candidate={...policy};if(enabled===undefined)delete candidate.enabled;else candidate.enabled=enabled;writePolicy(candidate);
      assert.equal(await verdict(make()),'force_ask',String(enabled));refused(invoke());refused(invokeDriver());assert.throws(()=>loadPolicy());
      if(enabled===false)assert.equal(loadPolicy({requireEnabled:false}).enabled,false);else assert.throws(()=>loadPolicy({requireEnabled:false}));
    }
  }finally{fs.writeFileSync(policyPath,original);}
});

test('only exact tracked operations are allowed, including host lowercase drive Cwd',async()=>withEnabled(async()=>{
  assert.equal(loadPolicy().enabled,true);
  assert.equal(await verdict(make()),'allow');assert.equal(await verdict(make('tracked-diff-stat')),'allow');
  const p=make();p.toolCall.args.Cwd=workspace[0].toLowerCase()+workspace.slice(1);assert.equal(await verdict(p),'allow');
  const exact=commandFor(policy,'tracked-status',workspace);assert.ok(exact.endsWith(' 2>&1'));assert.equal(exact.split('-ExecutionPolicy RemoteSigned').length,2);assert.ok(exact.includes('-ExecutionPolicy RemoteSigned -File '));
  for(const command of ['git status','git diff --stat','npm test',exact+'; echo forged',exact.replace(/ 2>&1$/,''),exact+' 2>&1',exact+' > another.txt',exact.replace('tracked-status','status'),exact.replace('-NoProfile ',''),exact.replace('-ExecutionPolicy RemoteSigned ',''),exact.replace('RemoteSigned','Bypass'),exact.replace('RemoteSigned','Unrestricted'),exact.replace('-File ','-ExecutionPolicy RemoteSigned -File '),exact.toLowerCase()])assert.equal(await verdict(make('tracked-status',{CommandLine:command})),'force_ask',command);
}));

test('daemon, persistent, unknown and argument/path aliases cannot grant',async()=>withEnabled(async()=>{
  for(const extra of [{IsDaemon:true},{IsDaemon:'false'},{RunPersistent:true},{RunPersistent:0},{RunPersistent:null},{Blocking:false},{WaitMsBeforeAsync:10001},{WaitMsBeforeAsync:'5000'},{policy:{allow:true}},{Environment:{NODE_OPTIONS:'--import=x'}},{Cwd:path.join(workspace,'..','repo space')+'\\.'},{Cwd:base}])assert.equal(await verdict(make('tracked-status',extra)),'force_ask',JSON.stringify(extra));
  const p=make();p.workspacePaths=[fixtureHome];assert.equal(await verdict(p),'force_ask');
  const absent=make();delete absent.toolCall.args.IsDaemon;delete absent.toolCall.args.WaitMsBeforeAsync;assert.equal(await verdict(absent),'allow');
}));

test('real fixed launcher uses child-only RemoteSigned from a Restricted parent and scrubs Node preload environment',async()=>withEnabled(async()=>{
  const marker=path.join(base,'preload-marker.txt');const preload=path.join(base,'preload.cjs');
  fs.writeFileSync(preload,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad');console.log('{}');process.exit(0);`);
  const injected={...cleanEnv,NODE_OPTIONS:`--require="${preload}"`,NODE_PATH:base,AG_REVIEW_POLICY:path.join(base,'fake-policy.json')};
  for(const operation of ['tracked-status','tracked-diff-stat']){
    const r=invoke(operation,injected);assert.equal(r.status,0,r.stdout+r.stderr);const output=JSON.parse(r.stdout);assert.equal(output.ok,true);assert.equal(output.operation,operation);assert.equal(output.profile,'isolated-tracked-git-v1');assert.match(output.scope,/External global\/system/);if(operation==='tracked-status')assert.match(output.statusShort,/tracked\.txt/);else assert.match(output.unstagedStat,/tracked\.txt/);
  }
  assert.equal(fs.existsSync(marker),false);
  const r=invoke('tracked-status',cleanEnv,base);assert.notEqual(r.status,0);assert.equal(JSON.parse(r.stdout).ok,false);
}));

test('disabled policy prevents driver and runner sentinels as well as preloads',async()=>{
  const originalPolicy=fs.readFileSync(policyPath),driver=path.join(home,'restricted-driver.mjs'),runner=path.join(home,'restricted-git.mjs');
  const originalDriver=fs.readFileSync(driver),originalRunner=fs.readFileSync(runner);
  const driverMarker=path.join(base,'disabled-driver-marker.txt'),runnerMarker=path.join(base,'disabled-runner-marker.txt'),preloadMarker=path.join(base,'disabled-preload-marker.txt'),preload=path.join(base,'disabled-preload.cjs');
  const runnerSentinel=`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(runnerMarker)},'runner-started');export async function summarizeTracked(){return {ok:false,code:'FIXTURE_RUNNER_RAN',message:'Synthetic runner sentinel.'};}`;
  const driverSentinel=`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(driverMarker)},'driver-started');console.log(JSON.stringify({ok:false,code:'FIXTURE_DRIVER_RAN',message:'Synthetic driver sentinel.'}));process.exitCode=2;`;
  fs.writeFileSync(preload,`require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)},'preload-started');process.exit(19);`);
  const injected={...cleanEnv,NODE_OPTIONS:`--require="${preload}"`,NODE_PATH:base};
  try{
    fs.writeFileSync(runner,runnerSentinel);const runnerPolicy=structuredClone(policy);runnerPolicy.assets.runner.sha256=digest(runnerSentinel);runnerPolicy.enabled=true;writePolicy(runnerPolicy);
    // Positive control: this would prove a runner import if the disabled check failed.
    const runnerControl=invokeDriver();assert.equal(JSON.parse(runnerControl.stdout).code,'FIXTURE_RUNNER_RAN');assert.equal(fs.readFileSync(runnerMarker,'utf8'),'runner-started');fs.unlinkSync(runnerMarker);
    runnerPolicy.enabled=false;writePolicy(runnerPolicy);refused(invokeDriver());refused(invoke('tracked-status',injected));assert.equal(await verdict(make()),'force_ask');assert.equal(fs.existsSync(runnerMarker),false);assert.equal(fs.existsSync(preloadMarker),false);
    fs.writeFileSync(driver,driverSentinel);const driverPolicy=structuredClone(runnerPolicy);driverPolicy.assets.driver.sha256=digest(driverSentinel);driverPolicy.enabled=true;writePolicy(driverPolicy);
    const driverControl=invoke('tracked-status',injected);assert.equal(JSON.parse(driverControl.stdout).code,'FIXTURE_DRIVER_RAN');assert.equal(fs.readFileSync(driverMarker,'utf8'),'driver-started');assert.equal(fs.existsSync(preloadMarker),false);fs.unlinkSync(driverMarker);
    driverPolicy.enabled=false;writePolicy(driverPolicy);refused(invoke('tracked-status',injected));assert.equal(fs.existsSync(driverMarker),false,'launcher must refuse before starting the Node driver');assert.equal(fs.existsSync(runnerMarker),false);assert.equal(fs.existsSync(preloadMarker),false);
  }finally{fs.writeFileSync(driver,originalDriver);fs.writeFileSync(runner,originalRunner);fs.writeFileSync(policyPath,originalPolicy);}
});

test('project grant plan is read-only and emits two literal full-command rules',()=>{
  const beforePolicy=fs.readFileSync(policyPath),hooksPath=path.join(workspace,'.agents','hooks.json'),beforeHooks=fs.readFileSync(hooksPath),beforeNames=fs.readdirSync(home).sort();
  const plan=projectGrantPlan(loadPolicy({requireEnabled:false}),workspace);
  assert.equal(plan.schemaVersion,1);assert.equal(plan.scope,'project-only');assert.equal(plan.workspacePath,workspace);assert.equal(plan.helperEnabled,false);
  assert.deepEqual(plan.rules.map(r=>r.operation),['tracked-status','tracked-diff-stat']);
  for(const rule of plan.rules){
    assert.equal(rule.command,commandFor(policy,rule.operation,workspace));assert.ok(rule.command.endsWith(' 2>&1'));assert.ok(rule.terminalCommandsUiRule.startsWith('regex:^'));assert.ok(rule.terminalCommandsUiRule.endsWith('$'));assert.ok(!rule.terminalCommandsUiRule.includes(' '));assert.ok(rule.terminalCommandsUiRule.includes('\\x20'));assert.ok(rule.terminalCommandsUiRule.includes('restricted-launcher\\.ps1'));assert.ok(rule.terminalCommandsUiRule.includes('repo\\x20space'));assert.ok(rule.terminalCommandsUiRule.includes('-ExecutionPolicy\\x20RemoteSigned\\x20-File'));assert.equal(rule.permissionResource,`command(${rule.terminalCommandsUiRule})`);
    assert.ok(fs.readFileSync(path.join(home,'COMMANDS.ja.md'),'utf8').includes(rule.command.replace(`-WorkspacePath "${workspace}"`,'-WorkspacePath "WORKSPACE"')),'installed guide must contain the exact fixed command');
    const pattern=new RegExp(rule.terminalCommandsUiRule.slice('regex:'.length));assert.equal(pattern.test(rule.command),true);
    for(const changed of [rule.command.replace(/ 2>&1$/,''),rule.command+' 2>&1',rule.command+'; echo suffix','prefix '+rule.command,rule.command.replace('-ExecutionPolicy RemoteSigned ',''),rule.command.replace('RemoteSigned','Bypass'),rule.command.replace('RemoteSigned','Unrestricted'),rule.command.replace('-File ','-ExecutionPolicy RemoteSigned -File '),rule.command.replace(rule.operation,rule.operation==='tracked-status'?'tracked-diff-stat':'tracked-status'),rule.command.replace('restricted-launcher.ps1','restricted-launcherXps1'),rule.command.replace('repo space','repo\tspace'),rule.command.replace(workspace,workspace+'-other')])assert.equal(pattern.test(changed),false,changed);
  }
  const cli=spawnSync(policy.assets.node.path,[path.join(home,'restricted-policy.mjs'),'--project-grants',workspace],{cwd:workspace,env:cleanEnv,encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(cli.status,0,cli.stdout+cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),plan);assert.deepEqual(fs.readFileSync(policyPath),beforePolicy);assert.deepEqual(fs.readFileSync(hooksPath),beforeHooks);assert.deepEqual(fs.readdirSync(home).sort(),beforeNames);
});

test('missing and stale assets fail closed without accepting environment policy overrides',async()=>withEnabled(async()=>{
  const runner=path.join(home,'restricted-git.mjs'),original=fs.readFileSync(runner);
  try{fs.appendFileSync(runner,'\n// changed\n');assert.equal(await verdict(make()),'force_ask');const r=invoke();assert.notEqual(r.status,0);assert.equal(JSON.parse(r.stdout).ok,false);}finally{fs.writeFileSync(runner,original);}
  const bytes=fs.readFileSync(policyPath);const fake=path.join(base,'fake-policy.json');fs.writeFileSync(fake,bytes);
  try{fs.renameSync(policyPath,policyPath+'.saved');assert.equal((await review(make(),{...cleanEnv,AG_REVIEW_POLICY:fake})).decision,'force_ask');}finally{fs.renameSync(policyPath+'.saved',policyPath);}
  assert.equal(await verdict(make()),'allow');
}));

test('links, metacharacters and unsupported repository settings are refused',async()=>withEnabled(async()=>{
  const linked=path.join(base,'linked-repo');fs.symlinkSync(workspace,linked,'junction');
  assert.equal(await verdict(make('tracked-status',{Cwd:linked})),'force_ask');
  const meta=path.join(base,'repo & unusual');fs.mkdirSync(meta);const p=make('tracked-status',{Cwd:meta});p.workspacePaths=[base];assert.equal(await verdict(p),'force_ask');
  git(['config','core.fsmonitor','echo must-not-run']);const r=invoke();assert.notEqual(r.status,0);assert.equal(JSON.parse(r.stdout).ok,false);git(['config','--unset','core.fsmonitor']);
}));

after(()=>{
  const resolved=path.resolve(base),parent=path.resolve('work');
  if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('restricted-integration-'))throw new Error('Unsafe fixture cleanup');
  fs.rmSync(resolved,{recursive:true,force:true});
});
