import { describe, expect, it } from 'vitest';
import { pickCanonicalUrl, pickChannelId, isHandleUrl } from '../src/renderer/lib/channel-url';

/**
 * Regression tests for the bug where adding a channel with an @handle stored
 * channel_id="@handle". Discovered videos carry the canonical UC id, so every
 * scan returned { discovered: 0, filtered: N } and the channel silently never
 * found anything.
 */
describe('canonical channel URL', () => {
  it('recognises the /channel/UC… form the server needs', () => {
    expect(pickCanonicalUrl('https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA')).toBe(
      'https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA',
    );
    expect(pickCanonicalUrl('https://youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA/videos')).toBe(
      'https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA',
    );
  });

  it('rejects @handles — the server would store "@handle" as channel_id', () => {
    expect(pickCanonicalUrl('https://www.youtube.com/@veritasium')).toBeNull();
    expect(isHandleUrl('https://www.youtube.com/@veritasium')).toBe(true);
    expect(isHandleUrl('https://www.youtube.com/channel/UCBa659QWEk661j4Dbkc8URw')).toBe(false);
  });

  it('extracts the UC id from any channel URL', () => {
    expect(pickChannelId('https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA')).toBe('UCHnyfMqiRRG1u-2MsSQLbXA');
    expect(pickChannelId('https://youtube.com/channel/UCBa659QWEk661j4Dbkc8URw/videos')).toBe('UCBa659QWEk661j4Dbkc8URw');
    expect(pickChannelId('https://www.youtube.com/@veritasium')).toBeNull();
    expect(pickChannelId(null)).toBeNull();
    expect(pickChannelId(undefined)).toBeNull();
  });

  it('normalises so the same channel always gets the same stored id', () => {
    const forms = [
      'https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA',
      'https://youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA/videos?view=0',
    ];
    const ids = forms.map((u) => pickCanonicalUrl(u));
    expect(new Set(ids).size).toBe(1);
  });

  it('never derives a non-UC id (uploads playlists and handles must not leak in)', () => {
    // A UC-prefixed 24-char id is the only valid form.
    expect(pickChannelId('https://www.youtube.com/channel/UC123')).toBeNull();
    expect(pickChannelId('https://www.youtube.com/user/someone')).toBeNull();
    expect(pickChannelId('https://www.youtube.com/playlist?list=PL123')).toBeNull();
  });
});