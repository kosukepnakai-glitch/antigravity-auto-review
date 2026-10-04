import { loadPolicy, canonicalPath, operations } from './restricted-policy.mjs';

try {
  const policy = loadPolicy();
  const payload = JSON.parse(await new Promise((resolve, reject) => {
    let text = '', size = 0, settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); process.stdin.removeAllListeners(); process.stdin.pause(); if (error) { process.stdin.destroy(); reject(error); } else resolve(text); };
    const timer = setTimeout(() => finish(new Error('Input timeout')), 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', part => { size += Buffer.byteLength(part); if (size > 32000) return finish(new Error('Oversized input')); text += part; });
    process.stdin.once('end', () => finish()); process.stdin.once('error', finish);
  }));
  if (!payload || Object.keys(payload).sort().join('|') !== 'operation|repoPath' || !operations.includes(payload.operation)) throw new Error('Invalid request');
  canonicalPath(payload.repoPath, 'directory');
  if (canonicalPath(process.cwd(), 'directory') !== payload.repoPath) throw new Error('Working directory mismatch');
  const { summarizeTracked } = await import('./restricted-git.mjs');
  const result = await summarizeTracked({ repoPath: payload.repoPath, gitPath: policy.assets.git.path, gitSha256: policy.assets.git.sha256, defaults: policy.defaults });
  if (!result.ok) { process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = 2; }
  else {
    const output = { ok: true, operation: payload.operation, profile: policy.profile, scope: 'Tracked files only, using isolated Git defaults. External global/system config and attributes are excluded. This does not establish repository cleanliness or equivalence to general Git.', trackedOnly: result.trackedOnly, message: result.message, semantics: result.semantics, tracked: result.tracked };
    if (payload.operation === 'tracked-status') output.statusShort = result.statusShort;
    else { output.unstagedStat = result.unstagedStat; output.stagedStat = result.stagedStat; }
    process.stdout.write(JSON.stringify(output) + '\n');
  }
} catch {
  process.stdout.write(JSON.stringify({ ok: false, code: 'TRUSTED_LAUNCH_REQUIRED', message: 'The fixed launcher, pinned assets and canonical workspace are required.' }) + '\n');
  process.exitCode = 2;
}
