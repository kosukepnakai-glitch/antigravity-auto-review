/** Candidate only. Trusted launcher/policy and a quiescent source tree are required. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const LIMITS = Object.freeze({ files: 20000, bytes: 256 * 1024 * 1024, oneFile: 32 * 1024 * 1024, tracked: 10000, totalMs: 30000, childMs: 10000, output: 4 * 1024 * 1024 });
const PROTECTED = new Set(['.git', '.agents', '.codex', '.gemini', '.ssh', '.aws', '.vscode', '.idea']);
const SENSITIVE = /^(?:\.env.*|\.(?:npmrc|pypirc|netrc|gitconfig|bashrc|bash_profile|bash_login|zshrc|zshenv|zprofile|profile)|(?:.*_)?profile\.ps1|auth\.json|id_(?:rsa|ed25519|ecdsa)(?:\..*)?|.*(?:credential|secret|token).*|.*\.(?:pem|key|pfx|p12|keystore))$/i;
const sha = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest('hex');
function stop(code, detail) { const e = new Error(detail); e.code = code; throw e; }
function segments(value) { return value.slice(path.parse(value).root.length).split(/[\\/]/).filter(Boolean); }
function ordinaryAbsolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) return false;
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || /[:<>"|?*]/.test(value.slice(2)))) return false;
  return segments(value).every(x => x !== '.' && x !== '..' && !/[. ]$/.test(x) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(x));
}
function checkedChain(value, allowMissing = false, trustedBinary = false) {
  if (!ordinaryAbsolute(value)) stop('PATH_UNSUPPORTED', 'Only ordinary absolute local paths are supported.');
  let cursor = path.parse(value).root;
  const parts = segments(value), chain = [];
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) cursor = path.join(cursor, parts[i]);
    let stat;
    try { stat = fs.lstatSync(cursor, { bigint: true }); }
    catch (e) { if (allowMissing && e.code === 'ENOENT') return { chain, missing: true }; throw e; }
    if (stat.isSymbolicLink()) stop('LINK_UNSUPPORTED', 'A symbolic link or junction is unsupported.');
    if (i < parts.length - 1 && !stat.isDirectory()) stop('PATH_UNSUPPORTED', 'A path ancestor is not a directory.');
    if (!trustedBinary && stat.isFile() && stat.nlink !== 1n) stop('HARDLINK_UNSUPPORTED', 'Multiple source file links are unsupported.');
    chain.push({ path: cursor, dev: stat.dev, ino: stat.ino });
  }
  return { chain, stat: fs.lstatSync(value, { bigint: true }), missing: false };
}
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function checkChainAgain(chain) {
  for (const expected of chain) {
    const stat = fs.lstatSync(expected.path, { bigint: true });
    if (stat.isSymbolicLink() || !sameIdentity(expected, stat)) stop('SOURCE_CHANGED', 'A source ancestor changed during snapshot.');
  }
}
function safeRelative(name, tracked = false) {
  if (!name || name.includes('\\') || name.startsWith('/') || name.endsWith('/') || /[\x00-\x1f\x7f:<>"|?*]/.test(name)) stop('PATH_UNSUPPORTED', 'Unsupported relative path.');
  const parts = name.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(p))) stop('PATH_UNSUPPORTED', 'Ambiguous relative path.');
  if (tracked && parts.some(p => PROTECTED.has(p.toLowerCase()) || p.toLowerCase()==='.gitmodules' || SENSITIVE.test(p))) stop('TRACKED_PATH_PROTECTED', 'A tracked file has a protected, sensitive or submodule configuration path; no summary was produced.');
  return name;
}
function parseIndex(bytes) {
  if (bytes.length < 32 || bytes.toString('ascii', 0, 4) !== 'DIRC' || sha(bytes.subarray(0, -20), 'sha1') !== bytes.subarray(-20).toString('hex')) stop('INDEX_UNSUPPORTED', 'Invalid SHA-1 index.');
  const version = bytes.readUInt32BE(4), count = bytes.readUInt32BE(8);
  if (![2, 3].includes(version) || count > LIMITS.tracked) stop('INDEX_UNSUPPORTED', 'Only bounded index versions 2 and 3 are supported.');
  const entries = [], records = [], seen = new Set();
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const start = offset;
    if (offset + 62 > bytes.length - 20) stop('INDEX_UNSUPPORTED', 'Truncated index.');
    const mode = bytes.readUInt32BE(offset + 24), flags = bytes.readUInt16BE(offset + 60), oid = bytes.subarray(offset + 40, offset + 60).toString('hex');
    if (![0o100644, 0o100755].includes(mode) || (flags & 0xb000)) stop('INDEX_UNSUPPORTED', 'Submodules, symlinks, conflicts and assume-unchanged entries are unsupported.');
    offset += 62;
    if (flags & 0x4000) {
      if (version !== 3 || offset + 2 > bytes.length - 20 || bytes.readUInt16BE(offset) !== 0) stop('INDEX_UNSUPPORTED', 'Sparse, skip-worktree and intent-to-add entries are unsupported.');
      offset += 2;
    }
    const end = bytes.indexOf(0, offset);
    if (end < offset || end >= bytes.length - 20) stop('INDEX_UNSUPPORTED', 'Invalid index path.');
    let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, end)); } catch { stop('INDEX_UNSUPPORTED', 'Non-UTF-8 index path.'); }
    if(!name)stop('INDEX_UNSUPPORTED','Split index entries are unsupported.');
    safeRelative(name, true);
    if ((flags & 0xfff) !== Math.min(end - offset, 0xfff) || seen.has(name.toLowerCase())) stop('INDEX_UNSUPPORTED', 'Index name length or case collision is unsupported.');
    seen.add(name.toLowerCase());
    const length = Math.ceil((62 + Buffer.byteLength(name) + 1) / 8) * 8;
    const record = Buffer.alloc(length); // Reset stat cache and drop all optimization extensions.
    record.writeUInt32BE(mode, 24); Buffer.from(oid, 'hex').copy(record, 40); record.writeUInt16BE(Math.min(Buffer.byteLength(name), 0xfff), 60); record.write(name, 62);
    entries.push({ name, mode: mode.toString(8), oid }); records.push(record);
    offset = start + Math.ceil((end + 1 - start) / 8) * 8;
  }
  while (offset < bytes.length - 20) {
    if (offset + 8 > bytes.length - 20) stop('INDEX_UNSUPPORTED', 'Invalid index extension.');
    const signature = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32BE(offset + 4);
    if (!['TREE', 'REUC', 'EOIE', 'IEOT', 'UNTR', 'FSMN'].includes(signature) || offset + 8 + length > bytes.length - 20) stop('INDEX_UNSUPPORTED', 'Split or unknown index extension is unsupported.');
    offset += 8 + length;
  }
  if (offset !== bytes.length - 20) stop('INDEX_UNSUPPORTED', 'Invalid index bounds.');
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4); header.writeUInt32BE(count, 8);
  const body = Buffer.concat([header, ...records]);
  return { entries, sanitized: Buffer.concat([body, Buffer.from(sha(body, 'sha1'), 'hex')]) };
}
function validRefName(name) { return name.startsWith('refs/') && !name.includes('..') && !name.includes('@{') && !/[ ~^:?*\[\\\x00-\x20\x7f]/.test(name) && name.split('/').every(p => p && !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock')); }
function validateRef(bytes) { const v = bytes.toString('utf8').trimEnd(); if (!/^[a-f0-9]{40}$/.test(v) && !(v.startsWith('ref: ') && validRefName(v.slice(5)))) stop('REF_UNSUPPORTED', 'Unsupported SHA-1 reference.'); }
function bool(value) { if (['true','yes','on','1',''].includes(value.toLowerCase())) return 'true'; if (['false','no','off','0'].includes(value.toLowerCase())) return 'false'; stop('CONFIG_UNSUPPORTED','Unsupported boolean configuration.'); }

export async function summarizeTracked({ repoPath, gitPath, gitSha256, defaults, onPhase } = {}) {
  let temp;
  const started = Date.now(), sourceFiles = [], absent = [], sourceDirs = new Map(), ignoredAccelerationMetadata=[];
  let fileCount = 0, copiedBytes = 0;
  const tick = () => { if (Date.now() - started > LIMITS.totalMs) stop('LIMIT_EXCEEDED', 'Snapshot deadline exceeded.'); };
  function readChecked(file, cap = LIMITS.oneFile, remember = true, trustedBinary = false) {
    tick(); const inspected = checkedChain(file,false,trustedBinary);
    if (!inspected.stat?.isFile() || inspected.stat.size > BigInt(cap)) stop('FILE_UNSUPPORTED', 'Source is not a bounded regular file.');
    const fd = fs.openSync(file, 'r');
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size > BigInt(cap) || !sameIdentity(inspected.stat, before) || before.size !== inspected.stat.size || before.mtimeNs !== inspected.stat.mtimeNs || before.ctimeNs !== inspected.stat.ctimeNs || !trustedBinary && before.nlink !== 1n) stop('SOURCE_CHANGED', 'Source changed while opening.');
      checkChainAgain(inspected.chain);
      const buffer=Buffer.alloc(Number(before.size)+1);let filled=0;
      while(filled<buffer.length){tick();const n=fs.readSync(fd,buffer,filled,buffer.length-filled,null);if(!n)break;filled+=n;}
      const bytes=buffer.subarray(0,filled), after = fs.fstatSync(fd, { bigint: true });
      if (bytes.length !== Number(before.size) || bytes.length > cap || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) stop('SOURCE_CHANGED', 'Source changed while reading.');
      checkChainAgain(inspected.chain);
      if (remember) {
        if (++fileCount > LIMITS.files || (copiedBytes += bytes.length) > LIMITS.bytes) stop('LIMIT_EXCEEDED', 'Snapshot file or byte limit exceeded.');
        sourceFiles.push({ file, cap, digest: sha(bytes), identity: before });
      }
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  try {
    if (!ordinaryAbsolute(repoPath) || segments(repoPath).some(p => PROTECTED.has(p.toLowerCase()) || SENSITIVE.test(p))) stop('ROOT_UNSUPPORTED','Protected, sensitive or non-local repository root.');
    repoPath = path.resolve(repoPath);
    if (!checkedChain(repoPath).stat?.isDirectory()) stop('ROOT_UNSUPPORTED','Repository root is not an ordinary directory.');
    if (!ordinaryAbsolute(gitPath) || !/^[a-f0-9]{64}$/i.test(gitSha256 ?? '')) stop('POLICY_INVALID','Trusted absolute Git path and SHA-256 are required.');
    if (!defaults || typeof defaults!=='object' || Array.isArray(defaults) || Object.keys(defaults).some(k=>!['autocrlf','eol','attributes'].includes(k)) || !['true','false','input'].includes(defaults.autocrlf) || !['native','lf','crlf'].includes(defaults.eol) || defaults.attributes!=='disabled-external') stop('POLICY_INVALID','An explicit isolated autocrlf/eol/attributes profile is required.');
    const executableHash = sha(readChecked(gitPath, 128 * 1024 * 1024, false, true));
    if (executableHash !== gitSha256.toLowerCase()) stop('BINARY_MISMATCH','Git executable SHA-256 does not match trusted policy.');
    const meta = path.join(repoPath, '.git');
    if (!checkedChain(meta).stat?.isDirectory()) stop('GITDIR_UNSUPPORTED','Only an ordinary .git directory is supported.');
    const optional = relative => {
      safeRelative(relative); const file = path.join(meta, ...relative.split('/')); const checked = checkedChain(file, true);
      if (checked.missing) { absent.push(file); return null; } return file;
    };
    for (const forbidden of ['commondir','config.worktree','shallow','info/grafts','info/attributes','info/sparse-checkout','objects/info/alternates','objects/info/http-alternates']) if (optional(forbidden)) stop('REPOSITORY_UNSUPPORTED',`Unsupported repository feature: ${forbidden}`);
    temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ag-restricted-git-'));
    const view = path.join(temp, 'worktree'), gitdir = path.join(view, '.git'), home = path.join(temp, 'home'), hooks = path.join(temp, 'empty-hooks');
    for (const dir of [gitdir,home,hooks]) fs.mkdirSync(dir,{recursive:true});
    const env = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', WINDIR: process.env.SystemRoot ?? 'C:\\Windows', PATH: '', HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, TMP: temp, TEMP: temp, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '' };
    const commandRecords = [];
    const git = args => {
      tick(); if (sha(readChecked(gitPath,128*1024*1024,false,true)) !== executableHash) stop('BINARY_CHANGED','Trusted Git executable changed.');
      const argv = ['--no-pager','--no-optional-locks','--no-lazy-fetch',`--git-dir=${gitdir}`,`--work-tree=${view}`,...args];
      commandRecords.push({args:[...args],cwd:view});
      const child=spawnSync(gitPath,argv,{cwd:view,env,shell:false,windowsHide:true,encoding:'utf8',timeout:Math.min(LIMITS.childMs,LIMITS.totalMs-(Date.now()-started)),maxBuffer:LIMITS.output});
      if(child.error || child.status!==0) stop('GIT_FAILED','Isolated Git failed or exceeded an output/time limit.');
      return child.stdout;
    };
    // This file is only input to config --no-includes; never the active git config.
    const configData = path.join(temp,'repository-config-data');
    const configFile = optional('config');
    fs.writeFileSync(configData,configFile ? readChecked(configFile,1024*1024) : '');
    const parsed = git(['config','--no-includes','--file',configData,'--list','-z']);
    const settings = new Map([['core.autocrlf',defaults.autocrlf],['core.eol',defaults.eol],['core.filemode','false'],['core.ignorecase','true']]);
    const ignored = [];
    for (const entry of parsed.split('\0').filter(Boolean)) {
      const split = entry.indexOf('\n'), key = (split < 0 ? entry : entry.slice(0,split)).toLowerCase(), value = split < 0 ? '' : entry.slice(split+1);
      if (key==='core.repositoryformatversion' && value==='0' || key==='core.bare' && bool(value)==='false') continue;
      if (['core.filemode','core.ignorecase','core.symlinks','core.logallrefupdates','core.quotepath'].includes(key)) { const v=bool(value); if(['core.filemode','core.ignorecase'].includes(key)) settings.set(key,v); else ignored.push(key); continue; }
      if (key==='core.autocrlf' && ['true','false','input'].includes(value.toLowerCase())) {settings.set(key,value.toLowerCase());continue;}
      if (key==='core.eol' && ['native','lf','crlf'].includes(value.toLowerCase())) {settings.set(key,value.toLowerCase());continue;}
      if (key==='core.safecrlf' && ['true','false','warn'].includes(value.toLowerCase())) {settings.set(key,value.toLowerCase());continue;}
      if (/^(?:user\.(?:name|email)|remote\.[^.]+\.(?:url|fetch)|branch\.[^.]+\.(?:remote|merge))$/.test(key)) {ignored.push(key);continue;}
      stop('CONFIG_UNSUPPORTED',`Unsupported repository configuration key: ${key}`);
    }
    let active='[core]\n\tbare = false\n\tfsmonitor = false\n\tquotePath = false\n\tattributesFile = '+JSON.stringify(process.platform==='win32'?'NUL':'/dev/null')+'\n\thooksPath = '+JSON.stringify(hooks.replaceAll('\\','/'))+'\n';
    for (const [key,value] of settings) active+=`\t${key.slice(5)} = ${value}\n`;
    fs.writeFileSync(path.join(gitdir,'config'),active);
    const put=(relative,cap=LIMITS.oneFile,validate)=>{const from=path.join(meta,...relative.split('/')),bytes=readChecked(from,cap); if(validate)validate(bytes);const dest=path.join(gitdir,...relative.split('/'));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes,{flag:'wx'});};
    put('HEAD',4096,validateRef);
    const indexFile=optional('index');
    const index=indexFile?parseIndex(readChecked(indexFile)):parseIndex((()=>{const h=Buffer.alloc(12);h.write('DIRC');h.writeUInt32BE(2,4);return Buffer.concat([h,Buffer.from(sha(h,'sha1'),'hex')]);})());
    fs.writeFileSync(path.join(gitdir,'index'),index.sanitized);
    function namesBounded(dir) {const names=[],handle=fs.opendirSync(dir);try{for(let e;(e=handle.readSync());){tick();if(names.length>=LIMITS.files)stop('LIMIT_EXCEEDED','Metadata directory entry limit exceeded.');names.push(e.name);}}finally{handle.closeSync();}return names.sort();}
    function list(relative) {
      const dir=path.join(meta,...relative.split('/'));
      if(!checkedChain(dir).stat?.isDirectory())stop('METADATA_UNSUPPORTED','Metadata path is not a directory.');
      const names=namesBounded(dir); sourceDirs.set(dir,names.join('\0'));return names;
    }
    function refs(relative) { for(const name of list(relative)){safeRelative(name);const child=relative+'/'+name;if(child.startsWith('refs/replace'))stop('REPOSITORY_UNSUPPORTED','Replacement refs are unsupported.');const f=path.join(meta,...child.split('/')),s=checkedChain(f).stat;if(s.isDirectory())refs(child);else{if(!validRefName(child))stop('REF_UNSUPPORTED','Unsupported ref name.');put(child,4096,validateRef);}} }
    fs.mkdirSync(path.join(gitdir,'refs'));
    if(optional('refs'))refs('refs');
    if(optional('packed-refs'))put('packed-refs',LIMITS.oneFile,bytes=>{for(const line of bytes.toString('utf8').split('\n')){if(!line || /^# pack-refs with: [a-z -]+$/.test(line) || /^\^[a-f0-9]{40}$/.test(line))continue;const m=/^([a-f0-9]{40}) (.+)$/.exec(line);if(!m||!validRefName(m[2])||m[2].startsWith('refs/replace/'))stop('REF_UNSUPPORTED','Unsupported packed reference.');}});
    fs.mkdirSync(path.join(gitdir,'objects'),{recursive:true});
    for(const name of list('objects')) {
      if(/^[a-f0-9]{2}$/.test(name)){for(const leaf of list('objects/'+name)){if(!/^[a-f0-9]{38}$/.test(leaf))stop('OBJECTS_UNSUPPORTED','Unexpected loose object path.');put('objects/'+name+'/'+leaf);}}
      else if(name==='info'){for(const leaf of list('objects/info')){if(!['packs','commit-graph'].includes(leaf))stop('OBJECTS_UNSUPPORTED','Unknown objects/info metadata is unsupported.');readChecked(path.join(meta,'objects','info',leaf));ignoredAccelerationMetadata.push('objects/info/'+leaf);}}
      else if(name==='pack'){for(const leaf of list('objects/pack')){if(!/^pack-[a-f0-9]{40}\.(?:pack|idx|rev|bitmap|keep)$/.test(leaf))stop('OBJECTS_UNSUPPORTED','Partial or unknown pack metadata is unsupported.');put('objects/pack/'+leaf);}}
      else stop('OBJECTS_UNSUPPORTED','Unknown object storage path.');
    }
    await onPhase?.('metadata-copied');
    let objectCount=0,expandedObjectBytes=0;
    const objectInfo=git(['cat-file','--batch-all-objects','--batch-check=%(objectname) %(objecttype) %(objectsize)']);
    for(const line of objectInfo.split('\n').filter(Boolean)){
      const m=/^[a-f0-9]{40} (?:blob|tree|commit|tag) (\d+)$/.exec(line),size=m?Number(m[1]):NaN;
      if(!Number.isSafeInteger(size)||size>LIMITS.oneFile||++objectCount>LIMITS.files||(expandedObjectBytes+=size)>LIMITS.bytes)stop('OBJECTS_LIMIT_EXCEEDED','Expanded Git object size/count limit exceeded or invalid object metadata.');
    }
    const tracked=git(['ls-files','--stage','-z']).split('\0').filter(Boolean).map(line=>{const m=/^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/.exec(line);if(!m)stop('INDEX_UNSUPPORTED','Unexpected staged entry.');safeRelative(m[3],true);return {name:m[3],mode:m[1],oid:m[2]};});
    if(JSON.stringify(tracked)!==JSON.stringify(index.entries))stop('INDEX_UNSUPPORTED','Isolated tracked entries differ from validated index.');
    // Staged deletions have left the index; validate their HEAD-side modes and
    // paths as well, without showing file contents or consulting external drivers.
    const stagedRaw=git(['diff','--cached','--raw','-z','--abbrev=40','--no-renames','--no-ext-diff','--no-textconv','--']).split('\0');
    if(stagedRaw.at(-1)==='')stagedRaw.pop();
    if(stagedRaw.length%2)stop('INDEX_UNSUPPORTED','Unexpected staged metadata format.');
    const stagedPaths=new Set();
    for(let i=0;i<stagedRaw.length;i+=2){if(!/^:(?:000000|100644|100755) (?:000000|100644|100755) [a-f0-9]{40} [a-f0-9]{40} [ADMT]$/.test(stagedRaw[i]))stop('INDEX_UNSUPPORTED','Staged symlinks, submodules or unsupported modes are not supported.');safeRelative(stagedRaw[i+1],true);stagedPaths.add(stagedRaw[i+1]);}
    let present=0,deleted=0;
    const copiedPaths=new Set(),attributePaths=new Set(['.gitattributes']);
    const collectAttributeAncestors=name=>{const components=name.split('/');for(let i=1;i<components.length;i++)attributePaths.add(components.slice(0,i).join('/')+'/.gitattributes');};
    for(const name of stagedPaths)collectAttributeAncestors(name);
    for(const entry of tracked){
      const components=entry.name.split('/');collectAttributeAncestors(entry.name);
      tick();const source=path.join(repoPath,...components);const checked=checkedChain(source,true);if(checked.missing){absent.push(source);deleted++;continue;}const bytes=readChecked(source);const dest=path.join(view,...components);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes,{flag:'wx'});copiedPaths.add(entry.name.toLowerCase());present++;
    }
    let additionalAttributeFiles=0;
    for(const relative of attributePaths){
      if(copiedPaths.has(relative.toLowerCase()))continue;
      const source=path.join(repoPath,...relative.split('/')),checked=checkedChain(source,true);
      if(checked.missing){absent.push(source);continue;}
      const bytes=readChecked(source,1024*1024),dest=path.join(view,...relative.split('/'));
      fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes,{flag:'wx'});copiedPaths.add(relative.toLowerCase());additionalAttributeFiles++;
    }
    await onPhase?.('worktree-copied');
    const statusShort=git(['status','--short','--untracked-files=no']);
    const unstagedStat=git(['diff','--no-ext-diff','--no-textconv','--stat','--no-color','--']);
    const stagedStat=git(['diff','--cached','--no-ext-diff','--no-textconv','--stat','--no-color','--']);
    await onPhase?.('summary-ready');
    for(const item of sourceFiles){const current=checkedChain(item.file).stat;if(!sameIdentity(item.identity,current)||sha(readChecked(item.file,item.cap,false))!==item.digest)stop('SOURCE_CHANGED','Source changed during snapshot; results discarded.');}
    for(const file of absent)if(!checkedChain(file,true).missing)stop('SOURCE_CHANGED','A previously absent source path appeared.');
    for(const [dir,names]of sourceDirs)if(namesBounded(dir).join('\0')!==names)stop('SOURCE_CHANGED','Source metadata directory changed.');
    return {ok:true,scope:'isolated-tracked-changes',trackedOnly:true,message:'追跡済みファイルを隔離設定で比較した概要です。外部のglobal/system設定・属性と未追跡ファイルの変更は対象外です。通常のGit全体との一致やリポジトリ全体がcleanであることを示しません。',statusShort,unstagedStat,stagedStat,tracked:{total:tracked.length,present,deleted},snapshot:{files:fileCount,bytes:copiedBytes,additionalAttributeFiles,objectCount,expandedObjectBytes},semantics:{isolatedDefaults:{...defaults},effectiveAutocrlf:settings.get('core.autocrlf'),effectiveEol:settings.get('core.eol'),externalGlobalSystemConfig:'not applied',externalGlobalSystemAttributes:'not applied',localAttributes:'tracked and applicable untracked ancestor .gitattributes captured',untrackedChanges:'excluded; ancestor attribute inputs still captured',ignoredNonoperativeConfigKeys:[...new Set(ignored)],ignoredAccelerationMetadata},commands:commandRecords,gitSha256:executableHash};
  } catch(e) { return {ok:false,code:e.code??'SNAPSHOT_FAILED',message:['EACCES','EPERM','ENOENT','ENOTDIR'].includes(e.code)?'Source path could not be safely inspected.':e.message}; }
  finally { if(temp){const resolved=path.resolve(temp),parent=fs.realpathSync.native(os.tmpdir());if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('ag-restricted-git-')||fs.lstatSync(resolved).isSymbolicLink())throw new Error('Refusing unsafe snapshot cleanup');fs.rmSync(resolved,{recursive:true,force:true});} }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const args=JSON.parse(await new Promise((resolve,reject)=>{let s='',size=0,settled=false;const finish=e=>{if(settled)return;settled=true;clearTimeout(timer);process.stdin.removeAllListeners();process.stdin.pause();if(e){process.stdin.destroy();reject(e);}else resolve(s);};const timer=setTimeout(()=>finish(new Error('Input timeout')),3000);process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{size+=Buffer.byteLength(c);if(size>32000){finish(new Error('Input too large'));return;}s+=c;});process.stdin.on('end',()=>finish());process.stdin.on('error',finish);}));if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['repoPath','gitPath','gitSha256','defaults'].includes(k)))throw new Error('Unknown request field');const result=await summarizeTracked(args);process.stdout.write(JSON.stringify(result)+'\n');if(!result.ok)process.exitCode=2;}catch{process.stdout.write(JSON.stringify({ok:false,code:'INVALID_INPUT',message:'A trusted policy and repository request are required.'})+'\n');process.exitCode=2;}
}
