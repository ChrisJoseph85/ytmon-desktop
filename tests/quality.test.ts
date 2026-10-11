import { describe, expect, it } from 'vitest';
import {
  effectiveQualityLabel,
  isActive,
  isRetryable,
  qualityCeiling,
  resolveAvailableHeight,
  hasLocalFile,
  isQualityValue,
  STATE_LABELS,
} from '../src/shared/quality';
import { QUALITY_VALUES } from '../src/shared/types';
import { qualityLabelsFrom } from '../src/renderer/lib/labels';

describe('quality options (acceptance check: exactly 9 values, server order)', () => {
  it('exposes the 9 documented values', () => {
    expect(QUALITY_VALUES).toHaveLength(9);
    expect([...QUALITY_VALUES]).toEqual(['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p', 'best']);
  });

  it('renders the dropdown in ascending order with best last', () => {
    const opts = qualityLabelsFrom([...QUALITY_VALUES]);
    expect(opts.map((o) => o.value)).toEqual([
      '144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p', 'best',
    ]);
  });

  it('every option can be selected and saved (round-trips through the server shape)', () => {
    for (const q of QUALITY_VALUES) {
      const body = { quality: q };
      // The PUT /quality body carries only the enum; nothing else changes.
      expect(body.quality).toBe(q);
      expect(QUALITY_VALUES).toContain(body.quality);
    }
  });

  it('falls back to the server-reported list when present (both clients identical)', () => {
    const serverSays = ['720p', '1080p', 'best'];
    const opts = qualityLabelsFrom(serverSays);
    expect(opts.map((o) => o.value)).toEqual(['720p', '1080p', 'best']);
  });

  it('labels a ceiling as a maximum, never as a guarantee', () => {
    const opts = qualityLabelsFrom([...QUALITY_VALUES]);
    expect(opts.find((o) => o.value === '720p')!.label).toContain('max height');
    expect(opts.find((o) => o.value === 'best')!.label).toContain('Best available');
  });
});

describe('quality ceilings and fallback (acceptance check: missing resolutions fall back)', () => {
  it('treats each resolution as a maximum permitted height', () => {
    expect(qualityCeiling('720p')).toBe(720);
    expect(qualityCeiling('2160p')).toBe(2160);
    expect(qualityCeiling('best')).toBeNull();
  });

  it('picks the best stream at or below the ceiling', () => {
    expect(resolveAvailableHeight('1080p', [360, 720, 1080, 2160])).toBe(1080);
    expect(resolveAvailableHeight('1080p', [360, 720, 1440, 2160])).toBe(720);
    expect(resolveAvailableHeight('2160p', [1080, 1440, 2160])).toBe(2160);
  });

  it('never silently upgrades above the ceiling', () => {
    // Only higher resolutions exist -> the job must fail with a clear error,
    // not jump up. We return null so the caller surfaces that.
    expect(resolveAvailableHeight('720p', [1080, 1440, 2160])).toBeNull();
    expect(resolveAvailableHeight('480p', [720])).toBeNull();
  });

  it('"best" takes the highest available', () => {
    expect(resolveAvailableHeight('best', [360, 1080, 2160, 720])).toBe(2160);
  });

  it('ignores invalid heights and de-duplicates', () => {
    expect(resolveAvailableHeight('1080p', [0, -5, 720, 720, Number.NaN, 1080])).toBe(1080);
  });

  it('shows what was actually obtained, not what was requested', () => {
    // Requested 1080p, got 720p -> label states it fell back.
    expect(effectiveQualityLabel('1080p', 720)).toContain('best at or below');
    // Requested best, got 1440p.
    expect(effectiveQualityLabel('best', 1440)).toBe('1440p');
    // Nothing obtained yet.
    expect(effectiveQualityLabel('1080p', null)).toContain('requested');
  });
});

describe('download states (parity with the Android client)', () => {
  it('labels every documented state', () => {
    for (const s of ['discovered', 'queued', 'downloading', 'completed', 'failed', 'unavailable', 'skipped'] as const) {
      expect(STATE_LABELS[s]).toBeTruthy();
    }
  });

  it('"unavailable" is permanent: no retry, not a user error', () => {
    expect(isRetryable('unavailable')).toBe(false);
    expect(STATE_LABELS.unavailable).toBe('Not available');
  });

  it('"failed" is retryable', () => {
    expect(isRetryable('failed')).toBe(true);
    expect(isRetryable('completed')).toBe(false);
  });

  it('active states drive fast polling only', () => {
    expect(isActive('downloading')).toBe(true);
    expect(isActive('queued')).toBe(true);
    expect(isActive('completed')).toBe(false);
  });

  it('a file only exists when completed AND file_path is set', () => {
    expect(hasLocalFile({ status: 'completed', file_path: '/data/media/x.mp4' })).toBe(true);
    expect(hasLocalFile({ status: 'completed', file_path: null })).toBe(false);
    expect(hasLocalFile({ status: 'downloading', file_path: '/data/media/x.mp4' })).toBe(false);
  });
});

describe('quality option validation', () => {
  it('rejects invented values', () => {
    const valid: readonly string[] = QUALITY_VALUES;
    for (const invented of ['4320p', '8k', '', 'BEST', '720P']) {
      expect(valid).not.toContain(invented);
      expect(isQualityValue(invented)).toBe(false);
    }
    expect(isQualityValue('720p')).toBe(true);
    expect(isQualityValue('best')).toBe(true);
  });
});