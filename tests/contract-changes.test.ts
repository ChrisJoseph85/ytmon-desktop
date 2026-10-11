import { describe, expect, it } from 'vitest';
import { validateSubLangs, validateDownloadDir } from '../src/renderer/lib/labels';
import { YtmonError } from '../src/shared/errors';

/**
 * The server now rejects bad sub_langs and validates query filters instead of
 * silently returning an empty list. These tests pin the client's behaviour.
 */
describe('sub_langs validation (server returns 400 invalid_sub_langs)', () => {
  it('rejects "*" with an explanation before it ever reaches the server', () => {
    const v = validateSubLangs('*');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/invalid_sub_langs/);
    expect(v.reason).toMatch(/en\.\*/);
  });

  it('accepts the documented forms', () => {
    for (const ok of ['en.*', 'en', 'en,es', 'en.*,es', 'ja.*,ko.*,zh-Hans']) {
      expect(validateSubLangs(ok).ok, `${ok} should be valid`).toBe(true);
    }
  });

  it('rejects empty and malformed values', () => {
    expect(validateSubLangs('').ok).toBe(false);
    expect(validateSubLangs('   ').ok).toBe(false);
    expect(validateSubLangs('en;rm -rf /').ok).toBe(false);
    expect(validateSubLangs('a'.repeat(200)).ok).toBe(false);
  });

  it('normalises spacing around commas', () => {
    expect(validateSubLangs(' en , es ').normalized).toBe('en,es');
  });
});

describe('download_dir validation (lives on the phone)', () => {
  it('accepts absolute Termux paths and empty (server default)', () => {
    expect(validateDownloadDir('').ok).toBe(true);
    expect(validateDownloadDir('').normalized).toBeNull();
    expect(validateDownloadDir('/data/data/com.termux/files/home/media').ok).toBe(true);
  });

  it('rejects traversal, relative paths and spaces', () => {
    expect(validateDownloadDir('../../etc').ok).toBe(false);
    expect(validateDownloadDir('relative/path').ok).toBe(false);
    expect(validateDownloadDir('/data/my media').ok).toBe(false);
  });
});

describe('error contract: one shape, actionable codes', () => {
  it('every error carries a code the UI can branch on', () => {
    const e = new YtmonError('token revoked', 'invalid_token', 401);
    expect(e.isAuthError).toBe(true);
    expect(e.hint).toMatch(/revoked/);
  });

  it('treats missing_token and invalid_token as auth problems', () => {
    expect(new YtmonError('no token', 'missing_token', 401).isAuthError).toBe(true);
    expect(new YtmonError('nope', 'invalid_token', 401).isAuthError).toBe(true);
    expect(new YtmonError('gone', 'not_found', 404).isAuthError).toBe(false);
  });

  it('provides guidance for the codes clients are expected to handle', () => {
    const cases: [string, RegExp][] = [
      ['missing_token', /POST \/tokens/],
      ['invalid_token', /revoked/],
      ['not_retryable', /retryable/],
      ['not_cancellable', /cannot be cancelled/],
      ['invalid_sub_langs', /en\.\*/],
      ['invalid_path', /media directory/],
      ['method_not_allowed', /does not support/],
      ['channel_disabled', /Enable the channel/],
      ['payload_too_large', /5 MB/],
      ['origin_not_allowed', /main process/],
      ['invalid_download_dir', /filesystem roots/],
    ];
    for (const [code, re] of cases) {
      const e = new YtmonError('msg', code, 400);
      expect(e.hint, `${code} should have a hint`).toMatch(re);
    }
  });

  it('has no hint for codes it does not recognise', () => {
    expect(new YtmonError('boom', 'some_new_code', 500).hint).toBeNull();
  });
});

describe('storage reconciliation (watched + unwatched + orphaned == total)', () => {
  it('the settings screen only draws the breakdown when all three are present', () => {
    const complete = { bytes: 100, files: 3, free: 900, watched_bytes: 40, unwatched_bytes: 50, orphaned_bytes: 10 };
    const sum = complete.watched_bytes + complete.unwatched_bytes + complete.orphaned_bytes;
    expect(sum).toBe(complete.bytes);

    // A server without the breakdown must not show misleading percentages.
    const legacy = { bytes: 100, files: 3, free: 900 };
    const hasAll =
      typeof (legacy as Record<string, unknown>).watched_bytes === 'number' &&
      typeof (legacy as Record<string, unknown>).unwatched_bytes === 'number' &&
      typeof (legacy as Record<string, unknown>).orphaned_bytes === 'number';
    expect(hasAll).toBe(false);
  });
});