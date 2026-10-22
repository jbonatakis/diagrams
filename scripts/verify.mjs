import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

mkdirSync('.cache', { recursive: true });
const log = createWriteStream('.cache/verify.log');
const commands = [
  ['npm', ['run', 'build']],
  ['go', ['test', '-race', './...']],
  ['npm', ['test']],
];
let exitCode = 0;
try {
  for (const [command, args] of commands) {
    const label = `\nRunning ${command} ${args.join(' ')}\n`;
    process.stdout.write(label); log.write(label);
    const result = await new Promise((resolveCode) => {
      const child = spawn(command, args, { env: { ...process.env, GOCACHE: resolve('.cache/go-build') } });
      child.stdout.on('data', (data) => { process.stdout.write(data); log.write(data); });
      child.stderr.on('data', (data) => { process.stderr.write(data); log.write(data); });
      child.on('error', (error) => { log.write(error.message); resolveCode(1); });
      child.on('exit', (code) => resolveCode(code ?? 1));
    });
    if (result !== 0) { exitCode = result; break; }
  }
} finally {
  log.end(`\nVerification finished with exit code ${exitCode}.\n`);
  process.exitCode = exitCode;
}
