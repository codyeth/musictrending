import axios from 'axios'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { classifyTrend } from '../utils/classify.js'
import { isRecent } from '../utils/spotify-lookup.js'

// TikTok Creative Center — endpoint requires auth as of early 2025, returns 404 unauthenticated
// Kept here for when/if a working public endpoint is found; gracefully skips if unavailable
const BASE_URL = 'https://ads.tiktok.com/creative_radar_api/v1/popular_trend/music/list'

const MARKETS: Array<{ market: string; countryCode: string }> = [
  { market: 'US', countryCode: 'US' },
  { market: 'KR', countryCode: 'KR' },
  { market: 'JP', countryCode: 'JP' },
  { market: 'ID', countryCode: 'ID' },
  { market: 'BR', countryCode: 'BR' },
]

interface TikTokMusicItem {
  music_id: string
  title: string
  author: string
  item_rank: number
  cover?: string
  release_date?: string  // epoch seconds or ISO string
}

export async function crawlTikTok() {
  logger.info('tiktok', 'Starting TikTok Creative Center crawl...')
  let saved = 0
  let skipped = 0
  const today = new Date().toISOString().split('T')[0]

  // Quick pre-check: verify API is still accessible before looping all markets
  try {
    const probe = await axios.get(BASE_URL, {
      params: { page: 1, limit: 1, period: 7, country_code: 'US', sort_by: 'popular' },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://ads.tiktok.com/business/creativecenter/inspiration/popular/music/',
        'Accept': 'application/json',
      },
      timeout: 8000,
    })
    if (probe.status === 404 || probe.data?.code === 40101) {
      logger.warn('tiktok', 'Creative Center API unavailable (requires auth) — skipping TikTok crawl')
      return
    }
  } catch (probeErr) {
    const status = (probeErr as { response?: { status: number } }).response?.status
    if (status === 404 || status === 403) {
      logger.warn('tiktok', `Creative Center API returned ${status} — skipping TikTok crawl`)
      return
    }
  }

  for (const { market, countryCode } of MARKETS) {
    try {
      const res = await axios.get(BASE_URL, {
        params: {
          page: 1,
          limit: 30,
          period: 7,          // last 7 days
          country_code: countryCode,
          sort_by: 'popular',
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://ads.tiktok.com/business/creativecenter/inspiration/popular/music/',
          'Accept': 'application/json',
        },
        timeout: 15000,
      })

      const items: TikTokMusicItem[] = res.data?.data?.music_list ?? []
      if (items.length === 0) {
        logger.warn('tiktok', `No data returned for ${market}`)
        continue
      }

      for (const item of items) {
        const title = item.title?.trim()
        const artist = item.author?.trim()
        if (!title || !artist) continue

        // Parse release date if available
        let releaseDate: string | null = null
        if (item.release_date) {
          const ts = Number(item.release_date)
          if (!isNaN(ts) && ts > 1000000000) {
            releaseDate = new Date(ts * 1000).toISOString().split('T')[0]!
          } else if (typeof item.release_date === 'string' && item.release_date.includes('-')) {
            releaseDate = item.release_date.split('T')[0]!
          }
        }

        // Skip if older than 30 days
        if (releaseDate && !isRecent(releaseDate, 30)) {
          skipped++
          continue
        }

        // Use music_id as primary key — stable across rank changes
        // Append market so same song can appear in multiple markets
        const externalId = `tiktok_${countryCode}_${item.music_id}`
        const existing = await prisma.trend.findUnique({ where: { externalId } })
        if (existing) continue

        await prisma.trend.create({
          data: {
            externalId,
            source: 'TIKTOK',
            title,
            artist,
            market,
            type: classifyTrend('TIKTOK', market),
            rawData: JSON.stringify({
              rank: item.item_rank,
              date: today,
              releaseDate,
              platform: 'tiktok',
            }),
          },
        })
        saved++
      }

      await new Promise(r => setTimeout(r, 800))
    } catch (err) {
      logger.warn('tiktok', `Failed ${market}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  logger.info('tiktok', `Crawl complete. New: ${saved}, skipped old: ${skipped}`)
}
