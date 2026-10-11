import { describe, expect, it } from 'vitest';
import { pickRange, upstreamHeaders, parseMediaUrl, mediaUrl, thumbUrl } from '../src/shared/media';

/**
 * Regression tests for the two playback bugs found against the real server:
 *
 *  1. The player never mounted a <video> element (a load-state gate deadlocked
 *     against the element that was supposed to clear it).
 *  2. The media protocol only read Range from the URL query, but a <video>
 *     element seeks with a Range REQUEST HEADER — so every seek returned a full
 *     body from byte 0 and scrubbing snapped back to the start.
 */
describe('media range negotiation', () => {
  it('reads Range from the request header, the way <video> sends it', () => {
    const headers = new Headers({ Range: 'bytes=5038439-' });
    expect(pickRange(headers)).toBe('bytes=5038439-');
  });

  it('is case-insensitive about the header name', () => {
    expect(pickRange({ get: (n: string) => (n === 'range' ? 'bytes=10-' : null) })).toBe('bytes=10-');
  });

  it('falls back to the URL query only when there is no header', () => {
    expect(pickRange(new Headers(), 'bytes=99-')).toBe('bytes=99-');
    // A header always wins over the URL.
    expect(pickRange(new Headers({ Range: 'bytes=5-' }), 'bytes=99-')).toBe('bytes=5-');
    expect(pickRange(new Headers())).toBeNull();
  });

  it('builds upstream headers that carry auth and the range', () => {
    const auth = { Authorization: 'Bearer tok' };
    expect(upstreamHeaders({ auth, range: 'bytes=100-' })).toEqual({
      Authorization: 'Bearer tok',
      Range: 'bytes=100-',
    });
    expect(upstreamHeaders({ auth })).toEqual({ Authorization: 'Bearer tok' });
    expect(upstreamHeaders({ auth, range: null, ifRange: '"abc"' })).toEqual({
      Authorization: 'Bearer tok',
      'If-Range': '"abc"',
    });
  });

  it('never leaks the token into the renderer-facing URL', () => {
    expect(mediaUrl('dQw4w9WgXcQ')).not.toContain('token');
    expect(mediaUrl('dQw4w9WgXcQ')).not.toContain('Bearer');
  });
});

describe('media URL parsing', () => {
  it('accepts the standard-scheme form and extracts the id', () => {
    expect(parseMediaUrl('ytmon-media://video/j9p3Sn8ROL4')).toEqual({
      kind: 'video',
      videoId: 'j9p3Sn8ROL4',
      range: null,
    });
  });

  it('routes thumbnails to the thumb handler', () => {
    expect(parseMediaUrl('ytmon-media://thumb/j9p3Sn8ROL4')).toMatchObject({ kind: 'thumb', videoId: 'j9p3Sn8ROL4' });
    expect(thumbUrl('j9p3Sn8ROL4')).toBe('ytmon-media://thumb/j9p3Sn8ROL4');
  });

  it('rejects anything that is not a video id', () => {
    expect(parseMediaUrl('ytmon-media://file//etc/passwd')).toBeNull();
    expect(parseMediaUrl('https://evil.example/video/x')).toBeNull();
  });
});