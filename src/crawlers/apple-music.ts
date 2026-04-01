import axios from 'axios'
import * as cheerio from 'cheerio'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { classifyTrend } from '../utils/classify.js'

// Apple Music RSS charts — no API key needed
const CHARTS: Array<{ market: string; url: string }> = [
  { market: 'US', url: 'https://rss.applemarketingtools.com/api/v2/us/music/most-played/25/songs.json' },
  { market: 'JP', url: 'https://rss.applemarketingtools.com/api/v2/jp/music/most-played/25/songs.json' },
  { market: 'KR', url: 'https://rss.applemarketingtools.com/api/v2/kr/music/most-played/25/songs.json' },
  { market: 'BR', url: 'https://rss.applemarketingtools.com/api/v2/br/music/most-played/25/songs.json' },
  { market: 'ID', url: 'https://rss.applemarketingtools.com/api/v2/id/music/most-played/25/songs.json' },
]

export async function crawlAppleMusic() {
  logger.info('apple-music', 'Starting Apple Music crawl...')
  let saved = 0
  const today = new Date().toISOString().split('T')[0]

  for (const chart of CHARTS) {
    try {
      const res = await axios.get(chart.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; music-tool/1.0)' },
        timeout: 15000,
      })

      const results: Array<{ name: string; artistName: string; id: string }> = res.data?.feed?.results ?? []

      for (let rank = 0; rank < results.length; rank++) {
        const item = results[rank]
        if (!item?.name || !item?.artistName) continue

        const externalId = `apple_${chart.market}_${rank + 1}_${today}`
        const existing = await prisma.trend.findUnique({ where: { externalId } })
        if (existing) continue

        await prisma.trend.create({
          data: {
            externalId,
            source: 'APPLE_MUSIC',
            title: item.name,
            artist: item.artistName,
            market: chart.market,
            type: classifyTrend('APPLE_MUSIC', chart.market),
            rawData: JSON.stringify({ rank: rank + 1, appleId: item.id, date: today }),
          },
        })
        saved++
      }

      await new Promise(r => setTimeout(r, 500))
    } catch (err) {
      logger.warn('apple-music', `Failed ${chart.market}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  logger.info('apple-music', `Crawl complete. Total new: ${saved}`)
}
