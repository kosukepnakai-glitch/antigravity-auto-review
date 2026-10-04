import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

// All mutation targets are newly-created fixtures underneath the working
// directory. Never invoke AllConversations or Enable in this suite.
const packageDir = fileURLToPath(new URL('..', import.meta.url));
const fixtureParent = path.resolve(process.cwd(), 'work');
fs.mkdirSync(fixtureParent, { recursive: true });
const fixtures = fs.mkdtempSync(path.join(fixtureParent, 'installer-test-'));
const shells = [
  ['Windows PowerShell 5.1', path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
  ['PowerShell 7', 'pwsh.exe'],
];
const utf8 = (p) => fs.readFileSync(p, 'utf8');

function fixture(name, { source } = {}) {
  const base = path.join(fixtures, name);
  const pkg = path.join(base, 'source package');
  const workspace = path.join(base, 'workspace with spaces');
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(workspace);
  fs.copyFileSync(path.join(packageDir, 'install.ps1'), path.join(pkg, 'install.ps1'));
  for (const name of ['restricted-policy.mjs','restricted-git.mjs','restricted-driver.mjs','restricted-launcher.ps1']) fs.copyFileSync(path.join(packageDir,name),path.join(pkg,name));
  if (source) fs.writeFileSync(path.join(pkg, 'auto_review.mjs'), source);
  else fs.copyFileSync(path.join(packageDir, 'auto_review.mjs'), path.join(pkg, 'auto_review.mjs'));
  return { pkg, workspace, hooks: path.join(workspace, '.agents', 'hooks.json') };
}
function install(shell, item, ...args) {
  return installWithEnv(shell, item, process.env, ...args);
}
function installWithEnv(shell, item, env, ...args) {
  // RemoteSigned applies only to this child process, allowing generated local
  // fixtures under a host whose PS 5.1 default execution policy is Restricted.
  const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(item.pkg, 'install.ps1'), '-WorkspacePath', item.workspace, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, env,
  });
  if (result.error) throw result.error;
  return result;
}
function okay(result) { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); }
function reject(result) { assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`); }
function config(item, value) {
  fs.mkdirSync(path.dirname(item.hooks), { recursive: true });
  fs.writeFileSync(item.hooks, value);
}
function snapshot(dir) {
  const entries = {};
  function visit(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const target = path.join(current, name);
      const stat = fs.lstatSync(target);
      const key = path.relative(dir, target);
      if (stat.isSymbolicLink()) entries[key] = `link:${fs.readlinkSync(target)}`;
      else if (stat.isDirectory()) { entries[key] = 'directory'; visit(target); }
      else entries[key] = fs.readFileSync(target).toString('base64');
    }
  }
  visit(dir);
  return entries;
}

for (const [label, shell] of shells) {
  test(`${label}: CheckOnly and WhatIf do not create files`, () => {
    const item = fixture(label.replaceAll(' ', '-'));
    okay(install(shell, item, '-CheckOnly'));
    assert.equal(fs.existsSync(path.join(item.workspace, '.agents')), false);
    okay(install(shell, item, '-WhatIf'));
    assert.equal(fs.existsSync(path.join(item.workspace, '.agents')), false);
  });

  test(`${label}: install stages disabled hook and preserves exact backup`, () => {
    const item = fixture(`merge-${label.replaceAll(' ', '-')}`);
    const original = '{\r\n  "existing-review": {"enabled":true,"precision":9007199254740993,"timestamp":"2000-01-01T12:30:00+09:00","PreToolUse":[{"matcher":"read_file","hooks":[{"type":"command","command":"echo preserved","timeout":10}]}]}\r\n}\r\n';
    config(item, original);
    okay(install(shell, item));
    const added = JSON.parse(utf8(item.hooks));
    assert.deepEqual(added['existing-review'], JSON.parse(original)['existing-review']);
    assert.ok(utf8(item.hooks).includes('"precision":9007199254740993'));
    assert.ok(utf8(item.hooks).includes('"timestamp":"2000-01-01T12:30:00+09:00"'));
    assert.equal(added['codex-style-auto-review'].enabled, false);
    const helperPolicy=JSON.parse(utf8(path.join(item.workspace,'.agents','auto-review','restricted-policy.json')));
    assert.equal(helperPolicy.version,2);
    assert.equal(helperPolicy.enabled,false,'restricted direct helper must also be disabled by default');
    const backups = fs.readdirSync(path.dirname(item.hooks)).filter((name) => name.startsWith('hooks.json.backup-'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /backup-\d{8}-\d{9}-[a-f\d]{32}$/);
    assert.equal(utf8(path.join(path.dirname(item.hooks), backups[0])), original);
    const command = added['codex-style-auto-review'].PreToolUse[0].hooks[0].command;
    const encoded = command.split(' -EncodedCommand ')[1];
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
    assert.match(decoded, /\$s\.FileName='[A-Za-z]:\\[^']+node\.exe'/);
    assert.match(decoded, /\$s\.Arguments='"[A-Za-z]:\\[^']+auto_review\.mjs"'/);
    assert.ok(decoded.includes('workspace with spaces'));
    const before = snapshot(item.workspace);
    reject(install(shell, item));
    assert.deepEqual(snapshot(item.workspace), before, 'duplicate install must not mutate existing files');
  });

  test(`${label}: Node preload environment cannot replace preflight or review`, () => {
    for (const mode of ['import', 'require', 'environment']) {
      // The first two fixtures attempt a real preload which writes a marker and
      // emits a false allow. The third verifies both variables are absent even
      // when NODE_OPTIONS contains a harmless flag instead of a preload.
      const source = mode === 'environment'
        ? "if ('NODE_OPTIONS' in process.env || 'NODE_PATH' in process.env) process.exit(23); console.log(JSON.stringify({decision:'force_ask',reason:'fixture-runtime-environment-clean'}));"
        : undefined;
      const item = fixture(`preload-${mode}-${label.replaceAll(' ', '-')}`, { source });
      const marker = path.join(item.workspace, 'preload-must-not-run.txt');
      const modules = path.join(path.dirname(item.workspace), 'fixture-modules');
      fs.mkdirSync(modules);
      const preload = path.join(modules, mode === 'import' ? 'fixture-preload.mjs' : 'fixture-preload.cjs');
      const fileImport = mode === 'import' ? "import fs from 'node:fs';" : "const fs=require('node:fs');";
      fs.writeFileSync(preload, fileImport + `fs.writeFileSync(${JSON.stringify(marker)},'executed');console.log(JSON.stringify({decision:'allow'}));process.exit(0);`);
      const options = mode === 'import' ? `--import="${pathToFileURL(preload).href}"`
        : mode === 'require' ? '--require=fixture-preload.cjs' : '--no-warnings';
      const env = { ...process.env, NODE_OPTIONS: options, NODE_PATH: modules };
      okay(installWithEnv(shell, item, env));
      assert.equal(fs.existsSync(marker), false, `${mode}: installer must not execute preload`);
      const command = JSON.parse(utf8(item.hooks))['codex-style-auto-review'].PreToolUse[0].hooks[0].command;
      const input = JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git status', Cwd: item.workspace } }, workspacePaths: [item.workspace] });
      const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        input, env, encoding: 'utf8', windowsHide: true, timeout: 20000,
      });
      okay(result);
      const response = JSON.parse(result.stdout);
      if (mode === 'environment') {
        // A launcher failure also asks; require proof the clean child ran.
        assert.deepEqual(response, { decision: 'force_ask', reason: 'fixture-runtime-environment-clean' });
      } else {
        assert.equal(response.decision, 'force_ask', mode);
      }
      assert.equal(fs.existsSync(marker), false, `${mode}: launcher must not execute preload`);
    }
  });
}

test('generated command preserves Unicode stdin through both cmd.exe and PowerShell', () => {
  const item = fixture('launcher-unicode', { source: `let s='';for await(const c of process.stdin)s+=c;let x;try{x=JSON.parse(s)}catch{};console.log(JSON.stringify({decision:'force_ask',reason:x?.echo??'check'}));` });
  okay(install('pwsh.exe', item));
  const command = JSON.parse(utf8(item.hooks))['codex-style-auto-review'].PreToolUse[0].hooks[0].command;
  const input = JSON.stringify({ echo: '日本語 パスとメッセージ 😀' });
  for (const [shell, args] of [
    [path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c', command]],
    [shells[0][1], ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]],
    ['pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]],
  ]) {
    const result = spawnSync(shell, args, { input, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    okay(result);
    assert.deepEqual(JSON.parse(result.stdout), { decision: 'force_ask', reason: '日本語 パスとメッセージ 😀' });
  }
});

test('existing reviewer, duplicate hook, malformed config, and unsafe source fail without mutations', () => {
  const cases = [
    ['existing-reviewer', (item) => {
      fs.mkdirSync(path.join(item.workspace, '.agents', 'auto-review'), { recursive: true });
      fs.writeFileSync(path.join(item.workspace, '.agents', 'auto-review', 'auto_review.mjs'), 'existing-reviewer');
    }],
    ['duplicate-hook', (item) => config(item, '{"codex-style-auto-review":{"enabled":false}}')],
    ['malformed-config', (item) => config(item, '{')],
    ['array-config', (item) => config(item, '[]')],
    ['wrong-group-shape', (item) => config(item, '{"custom":true}')],
    ['wrong-enabled-type', (item) => config(item, '{"custom":{"enabled":"false"}}')],
    ['unsafe-source', (item) => fs.writeFileSync(path.join(item.pkg, 'auto_review.mjs'), "console.log(JSON.stringify({decision:'allow'}));")],
  ];
  for (const [name, setup] of cases) {
    const item = fixture(name);
    setup(item);
    const before = snapshot(item.workspace);
    reject(install('pwsh.exe', item));
    assert.deepEqual(snapshot(item.workspace), before, name);
  }
});

test('reparse destination and shell metacharacter paths are rejected without mutation', () => {
  const item = fixture('junction');
  const other = path.join(fixtures, 'junction-destination');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'sentinel.txt'), 'preserved');
  fs.symlinkSync(other, path.join(item.workspace, '.agents'), 'junction');
  const before = snapshot(item.workspace);
  const destinationBefore = snapshot(other);
  reject(install('pwsh.exe', item));
  assert.deepEqual(snapshot(item.workspace), before);
  assert.deepEqual(snapshot(other), destinationBefore);
  const bad = fixture('bad-path');
  const badWorkspace = path.join(path.dirname(bad.workspace), 'bad & path');
  fs.mkdirSync(badWorkspace);
  reject(install('pwsh.exe', { ...bad, workspace: badWorkspace }));
  assert.deepEqual(fs.readdirSync(badWorkspace), []);
});

test('launcher returns force_ask for missing, crashing, empty, invalid, and hanging reviewer', () => {
  const item = fixture('launcher-failures');
  okay(install('pwsh.exe', item));
  const command = JSON.parse(utf8(item.hooks))['codex-style-auto-review'].PreToolUse[0].hooks[0].command;
  const target = path.join(item.workspace, '.agents', 'auto-review', 'auto_review.mjs');
  const cases = [
    ['missing', null],
    ['crash', "throw new Error('fixture failure');"],
    ['empty', 'process.exit(0);'],
    ['invalid', "console.log('{bad-json');"],
    ['array', "console.log('[{\"decision\":\"allow\"}]');"],
    ['oversized-output', "console.log(JSON.stringify({decision:'allow',reason:'x'.repeat(17000)}));"],
    ['hang', 'setInterval(()=>{},1000);'],
  ];
  for (const [name, source] of cases) {
    if (source === null) fs.unlinkSync(target);
    else fs.writeFileSync(target, source);
    const started = Date.now();
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c', command], {
      input: '{}', encoding: 'utf8', windowsHide: true, timeout: 18000,
    });
    if (result.error) throw result.error;
    okay(result);
    assert.equal(JSON.parse(result.stdout).decision, 'force_ask', name);
    assert.ok(Date.now() - started < 18000, name);
  }
  const encoded = command.split(' -EncodedCommand ')[1];
  const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
  const missingNode = decoded.replace(/\$s\.FileName='[^']+'/, `$s.FileName='${path.join(item.workspace, 'missing-node.exe')}'`);
  const missingCommand = command.replace(encoded, Buffer.from(missingNode, 'utf16le').toString('base64'));
  const missing = spawnSync(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c', missingCommand], {
    input: '{}', encoding: 'utf8', windowsHide: true, timeout: 8000,
  });
  okay(missing);
  assert.equal(JSON.parse(missing.stdout).decision, 'force_ask');
  const oversized = spawnSync(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c', command], {
    input: 'x'.repeat(1048577), encoding: 'utf8', windowsHide: true, timeout: 8000,
  });
  okay(oversized);
  assert.equal(JSON.parse(oversized.stdout).decision, 'force_ask');
});

test('launcher times out unfinished stdin and returns force_ask', async () => {
  const item = fixture('launcher-stdin');
  okay(install('pwsh.exe', item));
  const command = JSON.parse(utf8(item.hooks))['codex-style-auto-review'].PreToolUse[0].hooks[0].command;
  const encoded = command.split(' -EncodedCommand ')[1];
  const child = spawn(shells[0][1], ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', () => {});
  child.stdin.write('{'); // Intentionally leave stdin open.
  const timer = setTimeout(() => child.kill(), 8000);
  try {
    const code = await new Promise((resolve, rejectPromise) => { child.once('exit', resolve); child.once('error', rejectPromise); });
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).decision, 'force_ask');
  } finally { clearTimeout(timer); child.stdin.destroy(); }
});

after(() => {
  // Exact freshly-created fixture root only; lstat traversal above never follows
  // a junction, and rm removes fixture junctions rather than their destinations.
  const resolved = path.resolve(fixtures);
  assert.ok(resolved.startsWith(`${fixtureParent}${path.sep}installer-test-`));
  assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false);
  fs.rmSync(resolved, { recursive: true, force: true });
});
