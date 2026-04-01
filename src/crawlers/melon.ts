import axios from 'axios'
import * as cheerio from 'cheerio'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { classifyTrend } from '../utils/classify.js'

export async function crawlMelon() {
  logger.info('melon', 'Starting Melon crawl via Kworb...')
  let saved = 0

  try {
    const res = await axios.get('https://kworb.net/melon/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; music-tool/1.0)',
      },
      timeout: 15000,
    })

    const $ = cheerio.load(res.data)
    const today = new Date().toISOString().split('T')[0]
    const creates: Promise<void>[] = []

    $('table tbody tr').slice(0, 30).each((rank, el) => {
      const cells = $(el).find('td')
      const title = cells.eq(1).text().trim()
      const artist = cells.eq(2).text().trim()

      if (!title || !artist) return

      const externalId = `melon_${rank + 1}_${today}`

      const createOp = prisma.trend.findUnique({ where: { externalId } }).then(existing => {
        if (existing) return
        return prisma.trend.create({
          data: {
            externalId,
            source: 'MELON',
            title,
            artist,
            market: 'KR',
            type: classifyTrend('MELON', 'KR'),
            rawData: JSON.stringify({ rank: rank + 1, date: today }),
          },
        }).then(() => { saved++ })
      }).catch(() => {})

      creates.push(createOp as Promise<void>)
    })

    await Promise.all(creates)
    logger.info('melon', `Crawl complete. Total new: ${saved}`)
  } catch (err) {
    logger.error('melon', `Failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
