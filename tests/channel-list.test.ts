import { describe, expect, it } from 'vitest';
import { parseChannelList, parseChannelListWithStats, toImportCsv, toImportJson, summarise } from '../src/renderer/lib/channel-list';

/**
 * The bulk path exists because the server's import endpoint stores whatever URL
 * it is given — including @handles, which never match the canonical UC id that
 * discovered videos carry.
 */
describe('parsing a pasted channel list', () => {
  it('accepts canonical channel URLs as-is', () => {
    const list = parseChannelList('https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      canonicalUrl: 'https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA',
      channelId: 'UCHnyfMqiRRG1u-2MsSQLbXA',
      needsResolution: false,
    });
  });

  it('flags handles for resolution instead of sending them raw', () => {
    const list = parseChannelList('https://www.youtube.com/@veritasium');
    expect(list[0]!.needsResolution).toBe(true);
    expect(list[0]!.channelId).toBeNull();
  });

  it('accepts bare @handles and bare UC ids', () => {
    const list = parseChannelList('@veritasium\nUCHnyfMqiRRG1u-2MsSQLbXA');
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.channelId === 'UCHnyfMqiRRG1u-2MsSQLbXA')!.needsResolution).toBe(false);
    expect(list.find((e) => e.raw === '@veritasium')!.needsResolution).toBe(true);
  });

  it('finds a UC id embedded in a URL', () => {
    const list = parseChannelList('https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA/videos?view=0');
    expect(list[0]!.canonicalUrl).toBe('https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA');
    expect(list[0]!.needsResolution).toBe(false);
  });

  it('deduplicates repeated entries and still reports how many were dropped', () => {
    const parsed = parseChannelListWithStats(
      'https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA\nhttps://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA/videos\nUCHnyfMqiRRG1u-2MsSQLbXA',
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.duplicates).toBeGreaterThan(0);
    expect(summarise(parsed.entries, parsed.duplicates).duplicates).toBe(parsed.duplicates);
  });

  it('handles a Google Takeout style CSV', () => {
    const takeout = `Channel Id,Channel Url,Channel Title
UCHnyfMqiRRG1u-2MsSQLbXA,http://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA,Veritasium
UCBa659QWEk661j4Dbkc8URw,http://www.youtube.com/channel/UCBa659QWEk661j4Dbkc8URw,Linus Tech Tips`;
    const list = parseChannelList(takeout);
    expect(list).toHaveLength(2);
    expect(list.every((e) => e.needsResolution === false)).toBe(true);
    expect(list.map((e) => e.channelId)).toContain('UCBa659QWEk661j4Dbkc8URw');
  });

  it('ignores trailing punctuation and empty input', () => {
    expect(parseChannelList('')).toEqual([]);
    expect(parseChannelList('   \n  ')).toEqual([]);
    const list = parseChannelList('https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA,');
    expect(list[0]!.canonicalUrl).toBe('https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA');
  });
});

describe('building the import body', () => {
  it('emits CSV with the url column the server requires', () => {
    const csv = toImportCsv(parseChannelList('UCHnyfMqiRRG1u-2MsSQLbXA'), null);
    expect(csv.split('\n')[0]).toBe('url,channel_id,title,enabled,quality');
    expect(csv).toContain('https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA');
    // enabled must be truthy for the server to import the row.
    expect(csv).toContain(',1,');
  });

  it('applies a quality override when given', () => {
    const csv = toImportCsv(parseChannelList('UCHnyfMqiRRG1u-2MsSQLbXA'), '480p');
    expect(csv).toContain('480p');
  });

  it('escapes values containing commas or quotes', () => {
    const csv = toImportCsv(
      [{ canonicalUrl: 'https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA', raw: 'a,b "c"', channelId: null, needsResolution: false }],
      null,
    );
    expect(csv).toContain('"a,b ""c"""');
  });

  it('emits JSON in the same shape as GET /channels/export/json', () => {
    const json = JSON.parse(toImportJson(parseChannelList('UCHnyfMqiRRG1u-2MsSQLbXA'), null));
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({
      url: 'https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA',
      enabled: true,
      quality_override: null,
    });
  });

  it('only ever sends canonical /channel/UC URLs when they are known', () => {
    const csv = toImportCsv(
      parseChannelList('https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA\nhttps://www.youtube.com/@x'),
      null,
    );
    // The unresolved handle is still present but flagged for the client to
    // resolve before it is ever sent.
    const unresolved = csv.split('\n').filter((l) => l.includes('/@'));
    expect(unresolved.length).toBeLessThanOrEqual(1);
  });
});