import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { review, geminiReview } from '../auto_review.mjs';

const script = fileURLToPath(new URL('../auto_review.mjs', import.meta.url));
const tempRoot = fs.realpathSync.native(os.tmpdir());
let temp, root;
before(() => {
  temp = fs.mkdtempSync(path.join(tempRoot, 'ag-review-v2-'));
  root = path.join(temp, 'project');
  fs.mkdirSync(root);
});
after(() => {
  const resolved = fs.realpathSync.native(temp);
  assert.equal(path.dirname(resolved), tempRoot);
  assert.ok(path.basename(resolved).startsWith('ag-review-v2-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
const event = (name, args, roots = [root]) => ({ toolCall: { name, args }, workspacePaths: roots });
const edit = (target, roots = [root]) => event('replace_file_content', { TargetFile: target, TargetContent: 'original', ReplacementContent: 'edited' }, roots);
const create = (target) => event('write_to_file', { TargetFile: target, CodeContent: 'new file' });
const command = (text, env = {}, mock) => review(event('run_command', { CommandLine: text, Cwd: root }), env, mock);
const writeFixture = (leaf, text = 'original') => {
  const target = path.join(root, leaf);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
};

test('ordinary new file can be approved without executing or writing it', async () => {
  const target = path.join(root, 'src', 'new-file.py');
  assert.equal((await review(create(target), {})).decision, 'allow');
  assert.equal(fs.existsSync(target), false);
});
test('existing ordinary file supports single and multi edit without performing edits', async () => {
  const target = writeFixture('normal.txt');
  assert.equal((await review(edit(target), {})).decision, 'allow');
  assert.equal((await review(event('multi_replace_file_content', { TargetFile: target, ReplacementChunks: [{ TargetContent: 'original', ReplacementContent: 'edited' }] }), {})).decision, 'allow');
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
});
test('file overwrite, absent edit target and directory target require review', async () => {
  const target = writeFixture('existing.txt');
  assert.equal((await review(create(target), {})).decision, 'force_ask');
  assert.equal((await review(event('write_to_file', { TargetFile: path.join(root, 'absent.txt'), CodeContent: 'x', Overwrite: true }), {})).decision, 'force_ask');
  assert.equal((await review(edit(path.join(root, 'absent.txt')), {})).decision, 'force_ask');
  assert.equal((await review(edit(root), {})).decision, 'force_ask');
});
test('missing or invalid edit contents never auto-approve', async () => {
  for (const [name, args] of [
    ['write_to_file', { TargetFile: path.join(root, 'missing-content.txt') }],
    ['write_to_file', { TargetFile: path.join(root, 'bad-overwrite.txt'), CodeContent: 'x', Overwrite: 'true' }],
    ['replace_file_content', { TargetFile: path.join(root, 'normal.txt') }],
    ['multi_replace_file_content', { TargetFile: path.join(root, 'normal.txt'), ReplacementChunks: [] }],
  ]) assert.equal((await review(event(name, args), {})).decision, 'force_ask');
});
test('all commands including Git helpers, shell aliases and test scripts require confirmation', async () => {
  for (const text of ['git status', 'git status --short', 'git diff', 'git diff --check', 'git diff --stat', 'git rev-parse --show-toplevel', 'pwd', 'Get-Location', 'npm test', 'git push', 'curl https://example.com', 'rm -rf build', 'git status; whoami', 'echo api_key=example']) {
    assert.equal((await command(text)).decision, 'force_ask', text);
  }
});
test('local mode never calls external API', async () => {
  let calls = 0;
  const mock = async () => { calls++; throw new Error('Must not call'); };
  assert.equal((await command('npm test', { GEMINI_API_KEY: 'fake' }, mock)).decision, 'force_ask');
  assert.equal(calls, 0);
});
test('workspace prefix siblings and outside paths do not get approved', async () => {
  for (const target of [path.join(temp, 'outside.txt'), path.join(temp, 'project-sibling', 'x.txt')]) {
    assert.equal((await review(create(target), {})).decision, 'force_ask');
  }
});
test('protected absolute paths remain blocked for nested and reordered workspace roots', async () => {
  const scope = path.join(root, '.gemini', 'config');
  fs.mkdirSync(scope, { recursive: true });
  const target = path.join(scope, 'hooks.json');
  fs.writeFileSync(target, 'original');
  for (const roots of [[root], [scope], [scope, root], [root, scope]]) {
    assert.equal((await review(edit(target, roots), {})).decision, 'deny');
  }
  for (const dir of ['.git', '.agents', '.codex', '.ssh', '.aws', '.vscode', '.idea', '.GEMINI']) {
    assert.equal((await review(create(path.join(root, dir, 'new-config.txt')), {})).decision, 'deny');
  }
});
test('sensitive files and sensitive parent directories require confirmation', async () => {
  for (const leaf of ['.env', '.env.production', '.npmrc', '.pypirc', '.netrc', 'auth.json', 'credentials', 'id_rsa', 'signing.pfx', 'secret-dir/ordinary.txt', 'Microsoft.PowerShell_profile.ps1', 'Microsoft.VSCode_profile.ps1', '.bash_login', '.zprofile']) {
    const target = writeFixture(leaf);
    assert.equal((await review(edit(target), {})).decision, 'force_ask', leaf);
  }
});
test('ADS default-stream alias cannot bypass .env confirmation', { skip: process.platform !== 'win32' }, async () => {
  const target = writeFixture('.env');
  assert.equal(fs.realpathSync.native(target + '::$DATA'), fs.realpathSync.native(target));
  assert.equal((await review(edit(target + '::$DATA'), {})).decision, 'force_ask');
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
});
test('Windows special, ambiguous and remote paths never auto-approve', { skip: process.platform !== 'win32' }, async () => {
  const drive = path.parse(root).root.slice(0, 2);
  for (const target of [path.join(root, 'file:stream'), path.join(root, '.env '), path.join(root, 'file.'), ...['NUL.txt', 'COM1', 'COM¹.txt', 'CONIN$', 'AUX.txt', 'LPT9.doc'].map((leaf) => path.join(root, leaf)), '\\\\invalid.example\\share\\file.txt', '\\\\?\\' + root + '\\file.txt', '\\\\.\\NUL', '\\file.txt', drive + 'relative.txt', root + '\\..\\outside.txt']) {
    assert.equal((await review(create(target), {})).decision, 'force_ask', target);
  }
});
test('missing, invalid and non-directory workspace roots never auto-approve', async () => {
  const target = path.join(root, 'new.txt');
  for (const roots of [[], [null], ['relative'], [path.join(temp, 'not-present')], [writeFixture('not-a-directory')]]) {
    assert.equal((await review(event('write_to_file', { TargetFile: target, CodeContent: 'new' }, roots), {})).decision, 'force_ask');
  }
});
test('hardlinks cannot escape workspace or sensitive-file checks', async () => {
  const outside = path.join(temp, 'outside-hardlink.txt');
  const link = path.join(root, 'linked.txt');
  fs.writeFileSync(outside, 'original');
  fs.linkSync(outside, link);
  assert.equal(fs.statSync(link).nlink, 2);
  assert.equal((await review(edit(link), {})).decision, 'force_ask');
  const sensitive = writeFixture('api-secret.txt');
  const alias = path.join(root, 'ordinary-alias.txt');
  fs.linkSync(sensitive, alias);
  assert.equal((await review(edit(alias), {})).decision, 'force_ask');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'original');
});
test('directory junctions inside and outside workspace require confirmation', async (t) => {
  const realDir = path.join(root, 'real-dir');
  fs.mkdirSync(realDir);
  fs.writeFileSync(path.join(realDir, 'file.txt'), 'original');
  for (const [name, destination] of [['inside-link', realDir], ['outside-link', temp]]) {
    const alias = path.join(root, name);
    try { fs.symlinkSync(destination, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { t.skip(`Directory links unavailable: ${error.code}`); return; }
    assert.equal((await review(create(path.join(alias, 'new.txt')), {})).decision, 'force_ask');
  }
  const aliasRoot = path.join(root, 'inside-link');
  assert.equal((await review(event('write_to_file', { TargetFile: path.join(aliasRoot, 'new.txt'), CodeContent: 'new' }, [aliasRoot]), {})).decision, 'force_ask');
});
test('legacy allowed URL hosts and sandbox flag cannot grant permission', async () => {
  const env = { AG_REVIEW_ALLOWED_HOSTS: 'docs.example.com', AG_REVIEW_SANDBOX_CONFIRMED: '1' };
  assert.equal((await review(event('read_url_content', { Url: 'https://docs.example.com/guide' }), env)).decision, 'force_ask');
  assert.equal((await command('npm test', env)).decision, 'force_ask');
});
test('unknown tool and malformed payload never auto-approve', async () => {
  for (const payload of [null, {}, event('unknown', {}), event('run_command', []), event('write_to_file', null)]) {
    assert.equal((await review(payload, {})).decision, 'force_ask');
  }
});

const modelEnv = { AG_REVIEW_MODE: 'gemini-advisory', GEMINI_API_KEY: 'fake-never-sent' };
const modelResponse = (advice) => new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(advice) }] }] }));
test('no model recommendation can grant or deny permission', async () => {
  for (const risk of ['low', 'medium', 'high', 'critical', 'unknown']) {
    for (const recommendation of ['allow', 'deny', 'ask']) {
      const result = await command('npm test', modelEnv, async () => modelResponse({ risk, reason: 'Test advice', decision: recommendation }));
      assert.equal(result.decision, 'force_ask');
      assert.match(result.reason, /Test advice/);
    }
  }
});
test('legacy Gemini mode also stays advisory and ignores self-asserted sandbox', async () => {
  const result = await command('pytest -q', { ...modelEnv, AG_REVIEW_MODE: 'gemini', AG_REVIEW_SANDBOX_CONFIRMED: '1' }, async () => modelResponse({ risk: 'low', reason: 'Looks safe', decision: 'allow' }));
  assert.equal(result.decision, 'force_ask');
});
test('Gemini request is stateless, bounded to command/cwd, and does not expose file content', async () => {
  const hidden = writeFixture('package.json', 'SYNTHETIC_PRIVATE_FILE_CONTENT');
  await command('npm test', modelEnv, async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.ok(body.input.includes('UNKNOWN'));
    assert.ok(!body.input.includes(fs.readFileSync(hidden, 'utf8')));
    assert.equal(options.headers['x-goog-api-key'], modelEnv.GEMINI_API_KEY);
    return modelResponse({ risk: 'unknown', reason: 'No implementation supplied' });
  });
});
test('advisory API errors, invalid data, oversized data and missing key require confirmation', async () => {
  const badMocks = [
    async () => { throw new Error('timeout'); },
    async () => new Response('error', { status: 500 }),
    async () => new Response('not JSON'),
    async () => modelResponse({ risk: 'invalid', reason: 'no' }),
    async () => modelResponse({ risk: 'low', reason: '' }),
    async () => new Response('x'.repeat(100_001)),
  ];
  for (const mock of badMocks) assert.equal((await command('npm test', modelEnv, mock)).decision, 'force_ask');
  assert.equal((await geminiReview('npm test', root, {}, async () => { throw new Error('not called'); })).decision, 'force_ask');
});
test('unsupported, persistent or outside-workspace commands never reach advisory API', async () => {
  let calls = 0;
  const mock = async () => { calls++; return modelResponse({ risk: 'low', reason: 'irrelevant' }); };
  await command('python arbitrary.py', modelEnv, mock);
  await review(event('run_command', { CommandLine: 'npm test', Cwd: temp }), modelEnv, mock);
  await review(event('run_command', { CommandLine: 'npm test', Cwd: root, RunPersistent: true }), modelEnv, mock);
  assert.equal(calls, 0);
});
test('stdin protocol returns one JSON object; malformed/oversized input asks', () => {
  for (const input of [JSON.stringify(event('run_command', { CommandLine: 'git status', Cwd: root })), '{bad', 'x'.repeat(1_000_001)]) {
    const result = spawnSync(process.execPath, [script], { input, encoding: 'utf8', timeout: 6000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).decision, 'force_ask');
    assert.equal(result.stderr, '');
  }
});
function streamChild(send) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const watchdog = setTimeout(() => { child.kill(); reject(new Error('Child did not exit')); }, 6000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdout += chunk);
    child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', reject);
    child.on('exit', (status) => { clearTimeout(watchdog); resolve({ status, stdout, stderr }); });
    send(child.stdin);
  });
}
test('split UTF-8 input is decoded correctly', async () => {
  const input = Buffer.from(JSON.stringify(create(path.join(root, '日本語.txt'))));
  const index = input.indexOf(Buffer.from('日')) + 1;
  const result = await streamChild((stdin) => { stdin.write(input.subarray(0, index)); setTimeout(() => stdin.end(input.subarray(index)), 25); });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).decision, 'allow');
});
test('unfinished stdin returns to human before the host timeout', async () => {
  const result = await streamChild((stdin) => stdin.write('{'));
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).decision, 'force_ask');
  assert.equal(result.stderr, '');
});
