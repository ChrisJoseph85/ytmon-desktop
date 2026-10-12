import type { VideoQuery } from '@shared/types';

export interface LibraryFilterInput {
  view: 'all' | 'new' | 'unwatched' | 'watched' | 'downloading' | 'completed' | 'failed' | 'discovered';
  kind: 'all' | 'video' | 'short';
  mediaType?: 'all' | 'video' | 'audio';
  search: string;
  channelId: string;
  sort: string;
  order: 'asc' | 'desc';
  page: number;
  page_size: number;
}

/**
 * Translates the library UI state into the server's documented GET /videos
 * query parameters. The server filters; we never filter a page client-side.
 *
 * NOTE: `new` has no dedicated server parameter in the contract, so it is
 * expressed as the documented (unwatched + published) combination.
 */
export function downloadUrlForSearch(f: LibraryFilterInput): VideoQuery {
  const q: VideoQuery = {
    sort: (f.sort || 'published_at') as VideoQuery['sort'],
    order: f.order,
    page: Math.max(1, f.page),
    page_size: Math.min(200, Math.max(1, f.page_size)),
  };

  if (f.search) q.search = f.search;
  if (f.channelId) q.channel_id = f.channelId;
  if (f.kind !== 'all') q.kind = f.kind;
  // NOTE: GET /videos does NOT expose a media_type query parameter (verified
  // against the live schema), so sending one is silently ignored by the server.
  // The Audio/Video filter is therefore applied to the page in the renderer —
  // see filterByMediaType — rather than pretending the server filtered it.

  switch (f.view) {
    case 'unwatched':
      q.watched = false;
      break;
    case 'watched':
      q.watched = true;
      break;
    case 'downloading':
      q.status = 'downloading';
      break;
    case 'completed':
      q.status = 'completed';
      break;
    case 'failed':
      q.status = 'failed';
      break;
    case 'discovered':
      // Manual / not-yet-due channels leave their uploads in this state.
      q.status = 'discovered';
      break;
    case 'new':
      // Approximated with the documented filters: unwatched, newest first.
      q.watched = false;
      q.sort = 'published_at';
      q.order = 'desc';
      break;
    case 'all':
    default:
      break;
  }
  return q;
}

/**
 * Applies the media_type filter to a page of results.
 *
 * The server has no media_type query parameter, so this filters the loaded
 * page. The UI says so, because a server-filtered count would be a lie.
 */
export function filterByMediaType<T extends { media_type?: string }>(items: T[], mediaType: 'all' | 'video' | 'audio'): T[] {
  if (!mediaType || mediaType === 'all') return items;
  return items.filter((i) => (i.media_type ?? 'video') === mediaType);
}

/** Date filtering is expressed via the sort + the server's window on the
 * Channels screen; the library offers published-date sorting. */
export function isDateFilterActive(_f: LibraryFilterInput): boolean {
  return false;
}