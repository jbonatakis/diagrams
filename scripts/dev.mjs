import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import './assets.mjs';

if (existsSync('.env')) loadEnvFile('.env');

console.log(`Open ${process.env.DIAGRAMS_PUBLIC_URL ?? 'http://localhost:5173'} for your diagrams and agent pairing.`);

mkdirSync('bin', { recursive: true });
const binary = process.platform === 'win32' ? 'bin/diagrams.exe' : 'bin/diagrams';
const buildCode = await new Promise((resolveCode) => {
  const build = spawn('go', ['build', '-o', binary, './cmd/diagrams'], { stdio: 'inherit' });
  build.on('error', (error) => { console.error(error.message); resolveCode(1); });
  build.on('exit', (code) => resolveCode(code ?? 1));
});
if (buildCode !== 0) process.exit(buildCode);
const children = [
  spawn(`./${binary}`, { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}
for (const child of children) {
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code, signal) => stop(code ?? (signal ? 1 : 0)));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
