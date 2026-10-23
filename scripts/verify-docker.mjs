import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync('.cache', { recursive: true });
const log = createWriteStream('.cache/verify-docker.log');
const project = 'diagrams-check-' + randomBytes(4).toString('hex');
async function unusedPort() {
  const listener = createServer();
  await new Promise((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
  const port = String(listener.address().port);
  await new Promise((done, reject) => listener.close(error => error ? reject(error) : done()));
  return port;
}
const port = process.env.DIAGRAMS_CHECK_PORT ?? await unusedPort();
if (!/^\d{4,5}$/.test(port) || Number(port) > 65535) throw new Error('Invalid DIAGRAMS_CHECK_PORT');
const env = { ...process.env, DIAGRAMS_PUBLIC_URL: `http://127.0.0.1:${port}`, DIAGRAMS_PORT: port,
  DIAGRAMS_IMAGE: `diagrams:${project}`, DIAGRAMS_TEST_URL: `http://127.0.0.1:${port}`, DIAGRAMS_TEST_COMPOSE_PROJECT: project };
const compose = ['compose', '--project-name', project, '--env-file', 'deploy/production.env.example'];
function output(data) { process.stdout.write(data); log.write(data); }
let activeChild;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = true;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    activeChild?.kill('SIGTERM');
  });
}
async function run(command, args, cleanup = false) {
  if (interrupted && !cleanup) throw new Error('Verification interrupted');
  output(`\nRunning ${command} ${args.join(' ')}\n`);
  return await new Promise((done, reject) => {
    let result = '';
    const child = spawn(command, args, { env });
    activeChild = child;
    child.stdout.on('data', data => { result += data; output(data); });
    child.stderr.on('data', output);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      activeChild = undefined;
      code === 0 ? done(result.trim()) : reject(new Error(`${command} exited ${signal ?? code}`));
    });
  });
}

let started = false;
try {
  await run('docker', [...compose, 'config', '--quiet']);
  await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  started = true;
  await run('docker', [...compose, 'up', '-d', '--build', '--wait', '--wait-timeout', '120']);
  const container = await run('docker', [...compose, 'ps', '-q', 'diagrams']);
  await run('docker', ['image', 'inspect', env.DIAGRAMS_IMAGE, '--format', 'Image size: {{.Size}} bytes']);
  await run('docker', ['stats', '--no-stream', container]);
  await run('npm', ['test', '--', ...process.argv.slice(2)]);
  const recreated = await run('docker', [...compose, 'ps', '-q', 'diagrams']);
  await run('docker', ['stats', '--no-stream', recreated]);
  output('\nDocker verification passed.\n');
} catch (error) {
  output(`\nDocker verification failed: ${error.message}\n`);
  process.exitCode ||= 1;
  if (started) await run('docker', [...compose, 'logs', '--tail', '60'], true).catch(() => {});
} finally {
  // The randomized project and image own only this disposable test volume.
  if (started) {
    await run('docker', [...compose, 'down', '--volumes', '--rmi', 'all'], true).catch(error => {
      output(`Cleanup failed for ${project}: ${error.message}\n`);
      process.exitCode = 1;
    });
  }
  log.end();
}
