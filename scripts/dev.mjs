import { spawn } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));
const procs = [];
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) if (!p.killed) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function run(cmd, args, name) {
  const p = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, YTMON_DEV: '1' } });
  p.on('exit', (code) => {
    if (code) console.error(`[${name}] exited with code ${code}`);
    shutdown();
  });
  procs.push(p);
  return p;
}

// 1) bundle main + preload in watch mode
run('node', [r('./scripts/build-main.mjs'), '--watch'], 'esbuild');

// 2) vite dev server for the renderer
setTimeout(() => run('npx', ['vite'], 'vite'), 700);

// 3) launch electron once the bundles exist
setTimeout(() => run('npx', ['electron', '.'], 'electron'), 2200);