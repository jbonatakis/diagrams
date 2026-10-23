import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const target = process.env.DIAGRAMS_SSH_TARGET ?? 'deploy@46.225.76.155';
if (!/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/.test(target)) throw new Error('Invalid DIAGRAMS_SSH_TARGET');
const bundleOnly = process.argv.includes('--bundle-only');
const update = process.argv.includes('--update');
const migrateExports = process.argv.includes('--migrate-hosted-exports');
if (migrateExports && !update) throw new Error('--migrate-hosted-exports requires --update');
const archive = resolve('.cache/diagrams-deploy.tar.gz');
mkdirSync('.cache', { recursive: true });
const log = bundleOnly ? undefined : createWriteStream('.cache/deploy.log', { mode: 0o600 });
function output(data) { process.stdout.write(data); log?.write(data); }

async function run(command, args, input, env = process.env) {
  await new Promise((done, reject) => {
    const child = spawn(command, args, { env, stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    child.on('error', reject);
    child.on('exit', code => code === 0 ? done() : reject(new Error(`${command} exited ${code}`)));
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

// Explicit inputs keep local diagrams, credentials, README, Git metadata, and
// dependency/build caches out of the upload. Omit macOS forks and xattrs too.
try {
  process.env.COPYFILE_DISABLE = '1';
  await run('tar', ['--no-xattrs', '-czf', archive, 'Dockerfile', '.dockerignore', 'compose.yaml',
    'deploy', 'package.json', 'package-lock.json', 'go.mod', 'go.sum', 'index.html',
    'tsconfig.json', 'vite.config.ts', 'playwright.config.ts', 'scripts/assets.mjs',
    'src', 'shared', 'tests', 'cmd', 'internal']);
  output(`Deployment archive: ${archive}\n`);
  if (!bundleOnly) {
    const remoteArchive = `/tmp/diagrams-${randomUUID()}.tar.gz`;
    const sshOptions = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10'];
    output(`${update ? 'Updating' : 'Installing'} diagrams.bonatak.is on ${target}.\n`);
    await run('scp', [...sshOptions, archive, `${target}:${remoteArchive}`]);
    await run('ssh', [...sshOptions, target, 'bash', '-s', '--', remoteArchive,
      ...(migrateExports ? ['--migrate-hosted-exports'] : [])], readFileSync(update ? 'deploy/update.sh' : 'deploy/install.sh'));
    output('\nVerifying OAuth and visitor isolation over public HTTPS.\n');
    await run('npm', ['test', '--', 'tests/connections.spec.ts', 'tests/phase-one.spec.ts',
      '--grep', 'pairing survives reload|independent visitors'], undefined,
    { ...process.env, DIAGRAMS_TEST_URL: 'https://diagrams.bonatak.is', DIAGRAMS_TEST_COMPOSE_PROJECT: '' });
    output('\nDeployment and public browser checks passed.\n');
  }
} catch (error) {
  output(`\nDeployment stopped: ${error.message}\n`);
  process.exitCode = 1;
} finally { log?.end(); }
