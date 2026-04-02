import axios from 'axios'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { classifyTrend } from '../utils/classify.js'
import { isRecent } from '../utils/spotify-lookup.js'

// SoundCloud unofficial API v2 — public endpoint, no OAuth needed
// client_id rotates periodically, so we fetch it dynamically from the page
// Focus: phonk, funk, electronic genres — SoundCloud is where these originate
// before spreading to YouTube/TikTok (avg 2-4 week lead time)

const SC_API = 'https://api-v2.soundcloud.com'

let cachedClientId: string | null = null

async function fetchClientId(): Promise<string | null> {
  if (cachedClientId) return cachedClientId
  try {
    // Fetch SoundCloud homepage, find the JS bundle URLs
    const homeRes = await axios.get('https://soundcloud.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; music-tool/1.0)' },
      timeout: 10000,
    })
    const html: string = homeRes.data

    // Find script URLs in the HTML
    const scriptUrls = [...html.matchAll(/https?:\/\/[^"]+\.js/g)].map(m => m[0])

    // Look through the last few scripts for client_id
    for (const url of scriptUrls.slice(-5)) {
      try {
        const scriptRes = await axios.get(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; music-tool/1.0)' },
          timeout: 8000,
        })
        const match = (scriptRes.data as string).match(/client_id:"([a-zA-Z0-9]{32})"/)
        if (match?.[1]) {
          cachedClientId = match[1]
          logger.info('soundcloud', `Fetched fresh client_id`)
          return cachedClientId
        }
      } catch {
        // Try next script
      }
    }
  } catch (err) {
    logger.warn('soundcloud', `Failed to fetch client_id: ${err instanceof Error ? err.message : String(err)}`)
  }
  return null
}

// SoundCloud Charts API no longer accepts genre/region params (returns 400 since mid-2024)
// We use the global trending chart which returns a cross-genre mix
// Market is set to 'US' as the primary label (SoundCloud is US-dominant)
const SC_LIMIT = 50

interface SCTrack {
  id: number
  title: string
  permalink_url: string
  playback_count: number
  likes_count: number
  reposts_count: number
  comment_count: number
  created_at: string
  release_date?: string
  genre?: string
  tag_list?: string
  user: { username: string; permalink_url: string }
  artwork_url?: string
}

export async function crawlSoundCloud() {
  logger.info('soundcloud', 'Starting SoundCloud charts crawl...')
  let saved = 0
  let skipped = 0
  const today = new Date().toISOString().split('T')[0]

  const clientId = await fetchClientId()
  if (!clientId) {
    logger.warn('soundcloud', 'Could not obtain client_id, skipping')
    return
  }

  try {
    const res = await axios.get(`${SC_API}/charts`, {
      params: {
        kind: 'trending',
        limit: SC_LIMIT,
        client_id: clientId,
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; music-tool/1.0)',
        'Origin': 'https://soundcloud.com',
        'Referer': 'https://soundcloud.com/',
      },
      timeout: 15000,
    })

    const collection: Array<{ track: SCTrack }> = res.data?.collection ?? []

    for (let rank = 0; rank < collection.length; rank++) {
      const track = collection[rank]?.track
      if (!track?.title || !track?.user?.username) continue

      const releaseDate = track.release_date
        ? track.release_date.split('T')[0]!
        : track.created_at.split('T')[0]!

      if (!isRecent(releaseDate, 30)) {
        skipped++
        continue
      }

      const externalId = `sc_${track.id}`
      const existing = await prisma.trend.findUnique({ where: { externalId } })
      if (existing) continue

      const engagement = track.playback_count > 0
        ? Math.round(((track.likes_count + track.reposts_count * 2 + track.comment_count) / track.playback_count) * 1000)
        : 0

      await prisma.trend.create({
        data: {
          externalId,
          source: 'SOUNDCLOUD',
          title: track.title,
          artist: track.user.username,
          url: track.permalink_url,
          thumbnail: track.artwork_url ?? null,
          market: 'US',
          type: classifyTrend('SOUNDCLOUD', 'US'),
          rawData: JSON.stringify({
            rank: rank + 1,
            genre: track.genre ?? '',
            tags: track.tag_list ?? '',
            plays: track.playback_count,
            likes: track.likes_count,
            reposts: track.reposts_count,
            engagementScore: engagement,
            releaseDate,
            date: today,
            platform: 'soundcloud',
          }),
        },
      })
      saved++
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('401') || msg.includes('403')) {
      cachedClientId = null
      logger.warn('soundcloud', `Auth error, will re-fetch client_id next run: ${msg}`)
      return
    }
    logger.warn('soundcloud', `Charts request failed: ${msg}`)
  }

  logger.info('soundcloud', `Crawl complete. New: ${saved}, skipped old: ${skipped}`)
}
