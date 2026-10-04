/** Trusted sibling configuration; callers cannot select a policy or binary. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const names = Object.freeze({ reviewer: 'auto_review.mjs', support: 'restricted-policy.mjs', runner: 'restricted-git.mjs', driver: 'restricted-driver.mjs', launcher: 'restricted-launcher.ps1' });
export const operations = Object.freeze(['tracked-status', 'tracked-diff-stat']);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...expected].sort().join('|');

export function canonicalPath(value, kind, native = false) {
  if (typeof value !== 'string' || !/^[A-Za-z]:\\/.test(value) || /[\x00-\x1f\x7f"'`$%&|<>^!;(){}\[\]]/.test(value) || /[:?*]/.test(value.slice(2))) throw new Error('Unsupported path');
  const segments = value.slice(3).split('\\');
  if (segments.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(p))) throw new Error('Ambiguous path');
  let cursor = value.slice(0, 3);
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error('Linked path');
  }
  const stat = fs.lstatSync(value);
  if (kind === 'file' && (!stat.isFile() || !native && stat.nlink !== 1) || kind === 'directory' && !stat.isDirectory()) throw new Error('Unexpected path kind');
  const canonical = fs.realpathSync.native(value);
  if (canonical.toLowerCase() !== value.toLowerCase()) throw new Error('Noncanonical path');
  return canonical;
}

export function loadPolicy({ requireEnabled = true } = {}) {
  const policyPath = canonicalPath(path.join(here, 'restricted-policy.json'), 'file');
  if (fs.statSync(policyPath).size > 32000) throw new Error('Oversized policy');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!keys(policy, ['version', 'profile', 'enabled', 'assets', 'defaults']) || policy.version !== 2 || policy.profile !== 'isolated-tracked-git-v1' || typeof policy.enabled !== 'boolean') throw new Error('Invalid policy');
  if (requireEnabled && policy.enabled !== true) throw new Error('Restricted helper is disabled');
  if (!keys(policy.defaults, ['autocrlf', 'eol', 'attributes']) || policy.defaults.autocrlf !== 'false' || policy.defaults.eol !== 'native' || policy.defaults.attributes !== 'disabled-external') throw new Error('Invalid isolated profile');
  if (!keys(policy.assets, [...Object.keys(names), 'node', 'git', 'powershell'])) throw new Error('Invalid assets');
  for (const [role, asset] of Object.entries(policy.assets)) {
    if (!keys(asset, ['path', 'sha256']) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid asset');
    canonicalPath(asset.path, 'file', ['node', 'git', 'powershell'].includes(role));
    if (names[role] && asset.path !== path.join(here, names[role])) throw new Error('Asset outside installation');
    if (fs.statSync(asset.path).size > 128 * 1024 * 1024 || sha(fs.readFileSync(asset.path)) !== asset.sha256) throw new Error('Stale asset');
  }
  if (policy.assets.node.path !== fs.realpathSync.native(process.execPath)) throw new Error('Different Node runtime');
  if (/\s/.test(policy.assets.powershell.path)) throw new Error('Unsupported shell path');
  return policy;
}

export function commandFor(policy, operation, cwd) {
  if (!operations.includes(operation)) throw new Error('Unsupported operation');
  cwd = canonicalPath(cwd, 'directory');
  return `${policy.assets.powershell.path} -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "${policy.assets.launcher.path}" -Operation ${operation} -WorkspacePath "${cwd}" 2>&1`;
}

/** Generates proposed Project rules only; does not write native permissions. */
export function projectGrantPlan(policy, cwd) {
  cwd = canonicalPath(cwd, 'directory');
  const rules = operations.map(operation => {
    const command = commandFor(policy, operation, cwd);
    const literal = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '\\x20');
    const terminalCommandsUiRule = `regex:^${literal}$`;
    return { operation, command, terminalCommandsUiRule, permissionResource: `command(${terminalCommandsUiRule})` };
  });
  return { schemaVersion: 1, scope: 'project-only', workspacePath: cwd, helperEnabled: policy.enabled, rules,
    note: 'Register only for the named Project after native full-line matching and Deny tests. This output does not install a grant. Child filesystem access does not inherit arbitrary native file rules.' };
}

export function matchRestrictedCommand(args, checked) {
  try {
    if (!checked.inside || !checked.verified || checked.protectedPath || !checked.stat?.isDirectory() || checked.canonical !== canonicalPath(args.Cwd, 'directory')) return null;
    if (Object.keys(args).some(key => !['CommandLine', 'Cwd', 'RunPersistent', 'IsDaemon', 'Blocking', 'WaitMsBeforeAsync', 'SafeToAutoRun', 'toolAction', 'toolSummary'].includes(key))) return null;
    if (args.RunPersistent !== undefined && args.RunPersistent !== false) return null;
    if (args.IsDaemon !== undefined && args.IsDaemon !== false) return null;
    if (args.Blocking !== undefined && args.Blocking !== true) return null;
    if (args.WaitMsBeforeAsync !== undefined && (!Number.isSafeInteger(args.WaitMsBeforeAsync) || args.WaitMsBeforeAsync < 0 || args.WaitMsBeforeAsync > 10000)) return null;
    if (args.SafeToAutoRun !== undefined && typeof args.SafeToAutoRun !== 'boolean') return null;
    if (['toolAction', 'toolSummary'].some(key => args[key] !== undefined && (typeof args[key] !== 'string' || args[key].length > 2000))) return null;
    const policy = loadPolicy();
    const operation = operations.find(op => args.CommandLine === commandFor(policy, op, args.Cwd));
    return operation ? { operation, reason: '固定ランチャーによる隔離設定での追跡済みGit比較です。未追跡ファイルと外部Git設定は対象外です。' } : null;
  } catch { return null; }
}

// Read-only command generation also works while the helper is disabled.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--project-grants') throw new Error('Expected --project-grants and a canonical workspace');
    const plan = projectGrantPlan(loadPolicy({ requireEnabled: false }), process.argv[3]);
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, code: 'PROJECT_GRANT_PLAN_REFUSED', message: 'A valid pinned installation and canonical workspace are required.' }) + '\n');
    process.exitCode = 2;
  }
}
