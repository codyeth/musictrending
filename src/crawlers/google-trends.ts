import axios from 'axios'
import * as cheerio from 'cheerio'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { classifyTrend } from '../utils/classify.js'

// Google Trends daily trending searches RSS — no API key needed
const GEO_MAP: Record<string, string> = {
  US: 'US', JP: 'JP', KR: 'KR', BR: 'BR', ID: 'ID'
}

async function fetchDailyTrends(geo: string): Promise<Array<{ title: string; traffic: string }>> {
  const url = `https://trends.google.com/trending/rss?geo=${geo}`
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; music-tool/1.0)' },
    timeout: 15000,
  })

  const $ = cheerio.load(res.data, { xmlMode: true })
  const items: Array<{ title: string; traffic: string }> = []

  $('item').each((_i, el) => {
    const title = $(el).find('title').first().text().trim()
    const traffic = $(el).find('ht\\:approx_traffic').text().trim() || ''
    if (title) items.push({ title, traffic })
  })

  return items
}

export async function crawlGoogleTrends() {
  logger.info('google-trends', 'Starting Google Trends daily RSS crawl...')
  let saved = 0
  const today = new Date().toISOString().split('T')[0]

  for (const [market, geo] of Object.entries(GEO_MAP)) {
    try {
      const trends = await fetchDailyTrends(geo)

      for (const trend of trends) {
        const externalId = `gtrends_${geo}_${trend.title.replace(/\s+/g, '_').slice(0, 40)}_${today}`
        const existing = await prisma.trend.findUnique({ where: { externalId } })
        if (existing) continue

        await prisma.trend.create({
          data: {
            externalId,
            source: 'GOOGLE_TRENDS',
            title: trend.title,
            artist: 'Google Trends Signal',
            market,
            type: classifyTrend('GOOGLE_TRENDS', market),
            rawData: JSON.stringify({ traffic: trend.traffic, geo, date: today }),
          },
        })
        saved++
      }

      await new Promise(r => setTimeout(r, 1500)) // polite rate limit
    } catch (err) {
      logger.warn('google-trends', `Failed ${market}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  logger.info('google-trends', `Crawl complete. Total new: ${saved}`)
}
