import axios from 'axios'
import * as cheerio from 'cheerio'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { classifyTrend } from '../utils/classify.js'

// Shazam charts via kworb.net — same approach as Melon
const CHARTS: Array<{ market: string; path: string }> = [
  { market: 'US', path: 'https://kworb.net/shazam/country/us.html' },
  { market: 'JP', path: 'https://kworb.net/shazam/country/jp.html' },
  { market: 'KR', path: 'https://kworb.net/shazam/country/kr.html' },
  { market: 'BR', path: 'https://kworb.net/shazam/country/br.html' },
  { market: 'ID', path: 'https://kworb.net/shazam/country/id.html' },
]

export async function crawlShazam() {
  logger.info('shazam', 'Starting Shazam crawl via Kworb...')
  let saved = 0
  const today = new Date().toISOString().split('T')[0]

  for (const chart of CHARTS) {
    try {
      const res = await axios.get(chart.path, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; music-tool/1.0)' },
        timeout: 15000,
      })

      const $ = cheerio.load(res.data)

      let rank = 0
      $('table tbody tr').slice(0, 30).each((_i, el) => {
        const cells = $(el).find('td')
        // kworb shazam table: rank | artist - title or title | artist
        const col1 = cells.eq(1).text().trim()
        const col2 = cells.eq(2).text().trim()

        let title = ''
        let artist = ''

        if (col1 && col2) {
          title = col1
          artist = col2
        } else if (col1 && col1.includes(' - ')) {
          const parts = col1.split(' - ')
          artist = parts[0].trim()
          title = parts.slice(1).join(' - ').trim()
        }

        if (!title || !artist) return

        rank++
        const externalId = `shazam_${chart.market}_${rank}_${today}`

        prisma.trend.findUnique({ where: { externalId } }).then(existing => {
          if (existing) return
          return prisma.trend.create({
            data: {
              externalId,
              source: 'SHAZAM',
              title,
              artist,
              market: chart.market,
              type: classifyTrend('SHAZAM', chart.market),
              rawData: JSON.stringify({ rank, date: today }),
            },
          }).then(() => { saved++ })
        }).catch(() => {})
      })

      await new Promise(r => setTimeout(r, 1000))
    } catch (err) {
      logger.warn('shazam', `Failed ${chart.market}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // wait for all fire-and-forget promises to settle
  await new Promise(r => setTimeout(r, 2000))
  logger.info('shazam', `Crawl complete. Total new: ${saved}`)
}
