import axios from 'axios'

/**
 * Look up a song's release date via iTunes Search API (free, no auth).
 * Returns ISO date string (YYYY-MM-DD) or null if not found.
 */
export async function lookupReleaseDate(title: string, artist: string): Promise<string | null> {
  // Skip obviously bad titles (CSS, JS, numbers, very short strings)
  if (!title || title.length < 2 || /^[\d\s]+$/.test(title) || title.includes('{') || title.includes('opacity')) {
    return null
  }

  try {
    const res = await axios.get('https://itunes.apple.com/search', {
      params: { term: `${title} ${artist}`, entity: 'song', limit: 1 },
      timeout: 8000,
    })
    const item = res.data?.results?.[0]
    if (!item?.releaseDate) return null
    // Normalize to YYYY-MM-DD
    return item.releaseDate.split('T')[0]
  } catch {
    return null
  }
}

/** Returns true if the release date is within the last N days */
export function isRecent(releaseDate: string, days: number): boolean {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  return parseReleaseDate(releaseDate) >= cutoff
}

/** Parse a release_date string (YYYY-MM-DD or YYYY) into a Date */
export function parseReleaseDate(releaseDate: string): Date {
  if (releaseDate.length === 4) return new Date(`${releaseDate}-01-01`)
  return new Date(releaseDate)
}

// Keep for Spotify chart crawling (still used for token in spotify.ts)
export async function getSpotifyToken(): Promise<string | null> { return null }
