import axios from 'axios'
import prisma from '../db.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'
import { classifyTrend } from '../utils/classify.js'

const MARKETS = ['JP', 'US', 'KR', 'BR', 'ID'] as const
type Market = typeof MARKETS[number]

const ONE_MONTH_AGO = () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

async function getAccessToken(): Promise<string> {
  const credentials = Buffer.from(
    `${config.spotify.clientId}:${config.spotify.clientSecret}`
  ).toString('base64')

  const res = await axios.post(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  )
  return res.data.access_token
}

async function fetchChart(token: string, market: Market, type: 'viral' | 'top') {
  const url = `https://charts.spotify.com/charts/view/${type}-50-${market.toLowerCase()}/latest`
  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'text/csv',
    },
    timeout: 10000,
  })
  return res.data as string
}

function parseCsv(csv: string): Array<{ rank: number; trackId: string; title: string; artist: string; url: string }> {
  const lines = csv.trim().split('\n').slice(1) // skip header
  return lines.map(line => {
    const cols = line.split(',')
    const trackUrl = cols[1]?.replace(/"/g, '') ?? ''
    const trackId = trackUrl.split('/').pop() ?? ''
    return {
      rank: parseInt(cols[0] ?? '0'),
      trackId,
      title: cols[3]?.replace(/"/g, '') ?? 'Unknown',
      artist: cols[4]?.replace(/"/g, '') ?? 'Unknown',
      url: trackUrl,
    }
  }).filter(t => t.trackId)
}

// Batch fetch release dates for up to 50 tracks at once
async function fetchReleaseDates(token: string, trackIds: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const chunks = []
  for (let i = 0; i < trackIds.length; i += 50) {
    chunks.push(trackIds.slice(i, i + 50))
  }
  for (const chunk of chunks) {
    try {
      const res = await axios.get('https://api.spotify.com/v1/tracks', {
        headers: { Authorization: `Bearer ${token}` },
        params: { ids: chunk.join(',') },
        timeout: 10000,
      })
      for (const track of res.data.tracks ?? []) {
        if (track?.id && track?.album?.release_date) {
          result[track.id] = track.album.release_date
        }
      }
    } catch {
      // non-critical, continue without release dates for this chunk
    }
    await new Promise(r => setTimeout(r, 300))
  }
  return result
}

export async function crawlSpotify() {
  if (!config.hasSpotify) {
    logger.warn('spotify', 'Spotify credentials not set, skipping')
    return
  }

  logger.info('spotify', 'Starting Spotify crawl...')
  let token: string

  try {
    token = await getAccessToken()
  } catch (err) {
    logger.error('spotify', `Failed to get access token: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  let saved = 0
  let skippedOld = 0
  const cutoff = ONE_MONTH_AGO()

  for (const market of MARKETS) {
    for (const type of ['viral', 'top'] as const) {
      try {
        const csv = await fetchChart(token, market, type)
        const tracks = parseCsv(csv).slice(0, 20)

        // Batch fetch release dates
        const trackIds = tracks.map(t => t.trackId).filter(Boolean)
        const releaseDates = await fetchReleaseDates(token, trackIds)

        for (const track of tracks) {
          const releaseDate = releaseDates[track.trackId]

          // Skip songs released more than 1 month ago
          if (releaseDate) {
            const released = new Date(releaseDate)
            if (released < cutoff) {
              skippedOld++
              continue
            }
          }

          const externalId = `spotify_${type}_${market}_${track.trackId}`
          const existing = await prisma.trend.findUnique({ where: { externalId } })
          if (existing) continue

          await prisma.trend.create({
            data: {
              externalId,
              source: 'SPOTIFY',
              title: track.title,
              artist: track.artist,
              url: track.url,
              market,
              type: classifyTrend('SPOTIFY', market),
              rawData: JSON.stringify({
                rank: track.rank,
                chartType: type,
                releaseDate: releaseDate ?? null,
              }),
            },
          })
          saved++
        }

        logger.info('spotify', `Saved from ${type}-50-${market}`)
      } catch (err) {
        logger.warn('spotify', `Failed ${type}-${market}: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        await new Promise(r => setTimeout(r, 500))
      }
    }
  }

  logger.info('spotify', `Crawl complete. New: ${saved}, skipped old: ${skippedOld}`)
}
