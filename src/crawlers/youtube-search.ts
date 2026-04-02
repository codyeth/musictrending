import axios from 'axios'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { classifyTrend } from '../utils/classify.js'
import { config } from '../config.js'

// YouTube Data API v3 — search for trending music videos by keyword
// Quota cost: 100 units per search request, 10,000 units/day free
// With 3 crawls/day × ~10 keywords = 30 requests = 3,000 units (30% of daily quota)

const YT_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search'
const YT_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos'

// Keywords targeting phonk/funk/slowed content — same genres as our 6 sample videos
// Each keyword maps to a market for CPM scoring context
const SEARCH_QUERIES: Array<{ q: string; market: string }> = [
  { q: 'phonk music 2025',               market: 'US' },
  { q: 'slowed reverb phonk',            market: 'US' },
  { q: 'montagem funk 2025',             market: 'BR' },
  { q: 'brazilian phonk viral',          market: 'BR' },
  { q: 'funk instrumental trending',     market: 'US' },
  { q: 'dark phonk drift music',         market: 'US' },
  { q: 'phonk remix viral 2025',         market: 'US' },
  { q: 'lofi funk beats',                market: 'US' },
  { q: 'kpop phonk remix',              market: 'KR' },
  { q: 'japanese phonk trending',        market: 'JP' },
]

// Only fetch videos published in the last N days
const RECENCY_DAYS = 45

// Min view count to be worth tracking (filter noise)
const MIN_VIEWS = 50_000

interface YTSearchItem {
  id: { videoId: string }
  snippet: {
    title: string
    channelTitle: string
    publishedAt: string
    thumbnails: { high?: { url: string }; default?: { url: string } }
  }
}

interface YTVideoStats {
  id: string
  statistics: {
    viewCount?: string
    likeCount?: string
    commentCount?: string
  }
  snippet: {
    publishedAt: string
    title: string
    channelTitle: string
    thumbnails: { high?: { url: string }; default?: { url: string } }
  }
}

export async function crawlYoutubeSearch(): Promise<void> {
  if (!config.youtube.apiKey) {
    logger.warn('youtube-search', 'YOUTUBE_API_KEY not set — skipping')
    return
  }

  logger.info('youtube-search', `Starting YouTube keyword search crawl (${SEARCH_QUERIES.length} keywords)...`)
  let saved = 0
  let skipped = 0
  const cutoff = new Date(Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000)
  const publishedAfter = cutoff.toISOString()

  for (const { q, market } of SEARCH_QUERIES) {
    try {
      // Step 1: Search for videos (costs 100 quota units)
      const searchRes = await axios.get(YT_SEARCH_URL, {
        params: {
          part: 'snippet',
          q,
          type: 'video',
          videoCategoryId: '10',  // Music category
          order: 'viewCount',      // Most viewed first = proven viral
          publishedAfter,
          maxResults: 10,
          key: config.youtube.apiKey,
        },
        timeout: 10000,
      })

      const items: YTSearchItem[] = searchRes.data?.items ?? []
      if (items.length === 0) continue

      const videoIds = items.map(i => i.id.videoId).join(',')

      // Step 2: Get video statistics (costs 1 quota unit per video, ~10 total)
      const statsRes = await axios.get(YT_VIDEOS_URL, {
        params: {
          part: 'statistics,snippet',
          id: videoIds,
          key: config.youtube.apiKey,
        },
        timeout: 10000,
      })

      const videoStats: YTVideoStats[] = statsRes.data?.items ?? []

      for (const video of videoStats) {
        const views = parseInt(video.statistics.viewCount ?? '0')
        const likes = parseInt(video.statistics.likeCount ?? '0')
        const comments = parseInt(video.statistics.commentCount ?? '0')

        if (views < MIN_VIEWS) { skipped++; continue }

        const publishedAt = video.snippet.publishedAt
        const releaseDate = publishedAt.split('T')[0]!

        const externalId = `ytsearch_${video.id}`
        const existing = await prisma.trend.findUnique({ where: { externalId } })
        if (existing) { skipped++; continue }

        const likeRate = views > 0 ? Math.round((likes / views) * 10000) / 100 : 0
        const thumbnail = video.snippet.thumbnails.high?.url ?? video.snippet.thumbnails.default?.url ?? null

        // Estimate daily views: views / days since published
        const daysSincePublish = Math.max(1, Math.floor((Date.now() - new Date(publishedAt).getTime()) / 86400000))
        const dailyViews = Math.round(views / daysSincePublish)

        // Velocity score: ratio of daily views to total views (higher = still accelerating)
        const velocityScore = daysSincePublish <= 7
          ? Math.round((dailyViews / Math.max(views, 1)) * 1000)
          : Math.round((dailyViews / Math.max(views / daysSincePublish, 1)) * 100)

        await prisma.trend.create({
          data: {
            externalId,
            source: 'YOUTUBE',
            title: video.snippet.title,
            artist: video.snippet.channelTitle,
            url: `https://www.youtube.com/watch?v=${video.id}`,
            thumbnail,
            market,
            type: classifyTrend('YOUTUBE', market),
            rawData: JSON.stringify({
              videoId: video.id,
              views,
              likes,
              comments,
              likeRate,
              dailyViews,
              velocityScore,
              releaseDate,
              publishedAt,
              daysSincePublish,
              searchQuery: q,
              platform: 'youtube',
              velocityData: { dailyViews, velocityScore, plays: views, engagementScore: likeRate },
            }),
          },
        })
        saved++
      }

      // Polite delay between keyword searches (avoid quota burst)
      await new Promise(r => setTimeout(r, 500))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Quota exceeded — stop crawling to preserve remaining quota
      if (msg.includes('403') || msg.includes('quota')) {
        logger.warn('youtube-search', `Quota exceeded or forbidden — stopping: ${msg.slice(0, 100)}`)
        break
      }
      logger.warn('youtube-search', `Failed "${q}": ${msg.slice(0, 100)}`)
    }
  }

  logger.info('youtube-search', `Done. Saved: ${saved}, skipped: ${skipped}`)
}
