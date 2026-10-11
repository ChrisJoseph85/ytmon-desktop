import { build } from 'esbuild';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const r = (p) => fileURLToPath(new URL(p, new URL('..', import.meta.url)));
const watch = process.argv.includes('--watch');

const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron'],
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
};

const targets = [
  { entryPoints: ['src/main/index.ts'], outfile: 'dist/main/main.cjs' },
  { entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/preload.cjs' },
];

for (const t of targets) {
  await build({ ...common, ...t, minify: !watch });
}