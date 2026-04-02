import axios from 'axios'
import * as cheerio from 'cheerio'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { classifyTrend } from '../utils/classify.js'

// kworb.net realtime YouTube view counts — no API key needed
// Pages are regional, not per-country, so we map regions to markets
const CHARTS: Array<{ market: string; region: string; url: string }> = [
  { market: 'US', region: 'anglo',   url: 'https://kworb.net/youtube/realtime_anglo.html' },
  { market: 'BR', region: 'hispano', url: 'https://kworb.net/youtube/realtime_hispano.html' },
  { market: 'JP', region: 'asian',   url: 'https://kworb.net/youtube/realtime_asian.html' },
  { market: 'KR', region: 'asian',   url: 'https://kworb.net/youtube/realtime_asian.html' },
]

function parseViews(str: string): number {
  return parseInt(str.replace(/[^0-9]/g, ''), 10) || 0
}

interface ParsedTrack {
  rank: number
  title: string
  videoId: string
  views: number
  likes: number
}

function parseChart(html: string): ParsedTrack[] {
  const $ = cheerio.load(html)
  const tracks: ParsedTrack[] = []

  $('table tbody tr').each((_i, el) => {
    if (tracks.length >= 50) return false

    const cells = $(el).find('td')
    if (cells.length < 4) return

    // Structure: rank | change | title(link) | views | likes
    const titleCell = cells.eq(2)
    const link = titleCell.find('a').first()
    const title = link.text().trim()
    const href = link.attr('href') ?? ''                    // e.g. "video/XxYyZz.html"
    const videoId = href.match(/video\/([^.]+)\.html/)?.[1] ?? ''

    if (!title || title.length < 2) return

    const views = parseViews(cells.eq(3).text())
    const likes = parseViews(cells.eq(4).text())

    tracks.push({ rank: tracks.length + 1, title, videoId, views, likes })
  })

  return tracks
}

export async function crawlKworbYoutube() {
  logger.info('kworb-youtube', 'Starting Kworb YouTube realtime crawl...')
  let saved = 0
  const today = new Date().toISOString().split('T')[0]

  // Fetch each unique URL once to avoid duplicate requests for KR/JP sharing asian page
  const fetched = new Map<string, ParsedTrack[]>()

  for (const chart of CHARTS) {
    try {
      if (!fetched.has(chart.url)) {
        const res = await axios.get(chart.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; music-tool/1.0)',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          timeout: 15000,
        })
        fetched.set(chart.url, parseChart(res.data))
        await new Promise(r => setTimeout(r, 1000))
      }

      const tracks = fetched.get(chart.url) ?? []

      for (const track of tracks) {
        const externalId = `kworb_yt_${chart.market}_${track.rank}_${today}`
        const existing = await prisma.trend.findUnique({ where: { externalId } })
        if (existing) continue

        await prisma.trend.create({
          data: {
            externalId,
            source: 'YOUTUBE',
            title: track.title,
            artist: 'YouTube',   // kworb doesn't expose artist; scorer/AI can infer
            url: track.videoId ? `https://www.youtube.com/watch?v=${track.videoId}` : null,
            market: chart.market,
            type: classifyTrend('YOUTUBE', chart.market),
            rawData: JSON.stringify({
              rank: track.rank,
              dailyViews: track.views,
              likes: track.likes,
              videoId: track.videoId,
              date: today,
              platform: 'youtube',
              region: chart.region,
            }),
          },
        })
        saved++
      }

      logger.info('kworb-youtube', `${chart.market}: processed ${tracks.length} tracks`)
    } catch (err) {
      logger.warn('kworb-youtube', `Failed ${chart.market}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  logger.info('kworb-youtube', `Crawl complete. New: ${saved}`)
}
