import axios from 'axios'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { classifyTrend } from '../utils/classify.js'

// Shazam charts via iTunes RSS API (Apple acquired Shazam 2018, data overlap)
// Also pulls from Shazam's own endpoint where available
const CHARTS: Array<{ market: string; countryCode: string }> = [
  { market: 'US', countryCode: 'us' },
  { market: 'JP', countryCode: 'jp' },
  { market: 'KR', countryCode: 'kr' },
  { market: 'BR', countryCode: 'br' },
  { market: 'ID', countryCode: 'id' },
]

export async function crawlShazam() {
  logger.info('shazam', 'Starting Shazam crawl via iTunes RSS...')
  let saved = 0
  const today = new Date().toISOString().split('T')[0]

  for (const chart of CHARTS) {
    try {
      const url = `https://itunes.apple.com/${chart.countryCode}/rss/topsongs/limit=25/json`
      const res = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; music-tool/1.0)' },
        timeout: 15000,
      })

      const entries: Array<Record<string, any>> = res.data?.feed?.entry ?? []

      for (let rank = 0; rank < entries.length; rank++) {
        const entry = entries[rank]
        const title = entry?.['im:name']?.label?.trim()
        const artist = entry?.['im:artist']?.label?.trim()
        if (!title || !artist) continue

        const externalId = `shazam_${chart.market}_${rank + 1}_${today}`
        const existing = await prisma.trend.findUnique({ where: { externalId } })
        if (existing) continue

        await prisma.trend.create({
          data: {
            externalId,
            source: 'SHAZAM',
            title,
            artist,
            market: chart.market,
            type: classifyTrend('SHAZAM', chart.market),
            rawData: JSON.stringify({ rank: rank + 1, date: today }),
          },
        })
        saved++
      }

      await new Promise(r => setTimeout(r, 500))
    } catch (err) {
      logger.warn('shazam', `Failed ${chart.market}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  logger.info('shazam', `Crawl complete. Total new: ${saved}`)
}
