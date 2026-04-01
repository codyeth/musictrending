import axios from 'axios'
import * as cheerio from 'cheerio'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { classifyTrend } from '../utils/classify.js'
import { lookupReleaseDate, isRecent } from '../utils/spotify-lookup.js'

const CHARTS: Array<{ market: string; url: string }> = [
  { market: 'US', url: 'https://kworb.net/spotify/country/global_weekly.html' },
  { market: 'US', url: 'https://kworb.net/spotify/country/us_weekly.html' },
  { market: 'BR', url: 'https://kworb.net/spotify/country/br_weekly.html' },
  { market: 'ID', url: 'https://kworb.net/spotify/country/id_weekly.html' },
]

export async function crawlBillboard() {
  logger.info('billboard', 'Starting Billboard/Spotify Weekly crawl via Kworb...')
  let saved = 0
  let skipped = 0
  const today = new Date().toISOString().split('T')[0]

  for (const chart of CHARTS) {
    try {
      const res = await axios.get(chart.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; music-tool/1.0)' },
        timeout: 15000,
      })

      const $ = cheerio.load(res.data)
      const tracks: Array<{ rank: number; title: string; artist: string; marketKey: string }> = []
      let rank = 0

      $('table tbody tr').slice(0, 25).each((_i, el) => {
        const cells = $(el).find('td')
        const artist = cells.eq(2).text().trim()
        const title = cells.eq(3).text().trim()
        if (!title || !artist) return
        rank++
        const marketKey = chart.url.includes('global') ? 'GLOBAL' : chart.market
        tracks.push({ rank, title, artist, marketKey })
      })

      // Lookup release dates in parallel (max 5 at once to avoid rate limits)
      for (let i = 0; i < tracks.length; i += 5) {
        const batch = tracks.slice(i, i + 5)
        await Promise.all(batch.map(async (track) => {
          const externalId = `billboard_${track.marketKey}_${track.rank}_${today}`
          const existing = await prisma.trend.findUnique({ where: { externalId } })
          if (existing) return

          const releaseDate = await lookupReleaseDate(track.title, track.artist)
          await new Promise(r => setTimeout(r, 200)) // rate limit

          if (releaseDate && !isRecent(releaseDate, 30)) {
            skipped++
            return
          }

          await prisma.trend.create({
            data: {
              externalId,
              source: 'BILLBOARD',
              title: track.title,
              artist: track.artist,
              market: chart.market,
              type: classifyTrend('BILLBOARD', chart.market),
              rawData: JSON.stringify({ rank: track.rank, chart: track.marketKey, date: today, releaseDate: releaseDate ?? null }),
            },
          })
          saved++
        }))
      }

      await new Promise(r => setTimeout(r, 1000))
    } catch (err) {
      logger.warn('billboard', `Failed ${chart.url}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  logger.info('billboard', `Crawl complete. New: ${saved}, skipped old: ${skipped}`)
}
