// @ts-ignore — no official types
import googleTrends from 'google-trends-api'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

const KEYWORDS = [
  'funk music', 'phonk music', 'lo-fi music',
  'city pop', 'japanese funk', 'brazilian funk'
]

const GEO_MAP: Record<string, string> = {
  US: 'US', JP: 'JP', KR: 'KR', BR: 'BR', ID: 'ID'
}

export async function crawlGoogleTrends() {
  logger.info('google-trends', 'Starting Google Trends crawl...')
  let saved = 0
  const today = new Date().toISOString().split('T')[0]

  for (const keyword of KEYWORDS) {
    for (const [market, geo] of Object.entries(GEO_MAP)) {
      try {
        const result = await googleTrends.interestOverTime({
          keyword,
          geo,
          startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
        })

        const data = JSON.parse(result)
        const timelineData: Array<{ value: number[] }> = data?.default?.timelineData ?? []

        if (timelineData.length < 2) continue

        const recent = timelineData[timelineData.length - 1]?.value[0] ?? 0
        const previous = timelineData[timelineData.length - 4]?.value[0] ?? 1 // 3 points ago

        const velocity = previous > 0 ? Math.round(((recent - previous) / previous) * 100) : 0

        if (velocity < 30) continue // ignore flat trends

        const externalId = `gtrends_${keyword.replace(/ /g, '_')}_${market}_${today}`
        const existing = await prisma.trend.findUnique({ where: { externalId } })
        if (existing) continue

        await prisma.trend.create({
          data: {
            externalId,
            source: 'GOOGLE_TRENDS',
            title: keyword,
            artist: 'Google Trends Signal',
            market,
            rawData: JSON.stringify({ velocity, recentScore: recent, geo }),
          },
        })
        saved++

        await new Promise(r => setTimeout(r, 1000)) // rate limit
      } catch (err) {
        logger.warn('google-trends', `Failed ${keyword} / ${market}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  logger.info('google-trends', `Crawl complete. Total new: ${saved}`)
}
