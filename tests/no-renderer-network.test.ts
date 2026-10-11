import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src', import.meta.url).pathname;

/**
 * The server rejects ANY request carrying an Origin header with 403
 * `origin_not_allowed` (anti-CSRF). A renderer loading from file:// sends
 * Origin automatically, so every API call MUST originate in the main process.
 *
 * This test makes that architectural rule enforceable rather than a convention.
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') || p.endsWith('.tsx') ? [p] : [];
  });
}

describe('no network calls from the renderer or preload', () => {
  const rendererFiles = files(join(SRC, 'renderer')).concat(files(join(SRC, 'preload')));

  it('scans a non-empty set of files', () => {
    expect(rendererFiles.length).toBeGreaterThan(10);
  });

  it('contains no fetch / XHR / WebSocket / EventSource usage', () => {
    const offenders: string[] = [];
    for (const file of rendererFiles) {
      const code = readFileSync(file, 'utf8');
      // Ignore type-only references to our own bridge types.
      const stripped = code
        .replace(/^\s*import[^;]+;$/gm, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      if (/\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|new\s+EventSource|navigator\.sendBeacon/.test(stripped)) {
        offenders.push(file.replace(SRC, 'src'));
      }
    }
    expect(
      offenders,
      `Network calls must live in the main process only (403 origin_not_allowed otherwise): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('the renderer reaches the server only through the preload bridge', () => {
    const bridgeFile = readFileSync(join(SRC, 'renderer', 'lib', 'bridge.ts'), 'utf8');
    expect(bridgeFile).toContain('window.ytmon');
    // Every api.* helper is a call() over the bridge, never a direct request.
    expect(bridgeFile).not.toMatch(/\bfetch\s*\(/);
  });

  it('the main process is where the token and the HTTP client live', () => {
    const main = readFileSync(join(SRC, 'main', 'api.ts'), 'utf8');
    expect(main).toContain('Authorization');
    expect(main).toContain('Bearer');
  });
});
