import axios from 'axios'
import * as cheerio from 'cheerio'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { classifyTrend } from '../utils/classify.js'

// Billboard charts via kworb.net
const CHARTS: Array<{ market: string; url: string; source: string }> = [
  { market: 'US', url: 'https://kworb.net/spotify/country/us_weekly.html', source: 'BILLBOARD' },
  { market: 'BR', url: 'https://kworb.net/spotify/country/br_weekly.html', source: 'BILLBOARD' },
  { market: 'ID', url: 'https://kworb.net/spotify/country/id_weekly.html', source: 'BILLBOARD' },
]

// Billboard Hot 100 via kworb spotify global
const GLOBAL = { market: 'US', url: 'https://kworb.net/spotify/country/global_weekly.html', source: 'BILLBOARD' }

export async function crawlBillboard() {
  logger.info('billboard', 'Starting Billboard/Spotify Weekly crawl via Kworb...')
  let saved = 0
  const today = new Date().toISOString().split('T')[0]

  const allCharts = [GLOBAL, ...CHARTS]

  for (const chart of allCharts) {
    try {
      const res = await axios.get(chart.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; music-tool/1.0)' },
        timeout: 15000,
      })

      const $ = cheerio.load(res.data)
      const creates: Promise<void>[] = []
      let rank = 0

      $('table tbody tr').slice(0, 25).each((_i, el) => {
        const cells = $(el).find('td')
        // kworb spotify table: pos | pos_change | artist | title | streams
        const artist = cells.eq(2).text().trim()
        const title = cells.eq(3).text().trim()

        if (!title || !artist) return
        rank++

        const marketKey = chart.url.includes('global') ? 'GLOBAL' : chart.market
        const externalId = `billboard_${marketKey}_${rank}_${today}`

        const op = prisma.trend.findUnique({ where: { externalId } }).then(existing => {
          if (existing) return
          return prisma.trend.create({
            data: {
              externalId,
              source: 'BILLBOARD',
              title,
              artist,
              market: chart.market,
              type: classifyTrend('BILLBOARD', chart.market),
              rawData: JSON.stringify({ rank, chart: marketKey, date: today }),
            },
          }).then(() => { saved++ })
        }).catch(() => {})

        creates.push(op as Promise<void>)
      })

      await Promise.all(creates)
      await new Promise(r => setTimeout(r, 1000))
    } catch (err) {
      logger.warn('billboard', `Failed ${chart.url}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  logger.info('billboard', `Crawl complete. Total new: ${saved}`)
}
