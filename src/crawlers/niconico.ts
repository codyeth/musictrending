import axios from 'axios'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

export async function crawlNiconico() {
  logger.info('niconico', 'Starting Niconico crawl via VocaDB...')
  let saved = 0

  try {
    const res = await axios.get(
      'https://vocadb.net/api/songs?sort=RatingScore&maxResults=20&fields=ThumbUrl,Artists',
      { timeout: 10000 }
    )

    const songs = res.data?.items ?? []

    for (const song of songs) {
      const externalId = `niconico_${song.id}`
      const existing = await prisma.trend.findUnique({ where: { externalId } })
      if (existing) continue

      const artist = song.artists?.[0]?.artist?.name ?? 'Unknown'
      const thumbnail = song.thumbUrl ?? null

      await prisma.trend.create({
        data: {
          externalId,
          source: 'NICONICO',
          title: song.name ?? 'Unknown',
          artist,
          url: `https://vocadb.net/S/${song.id}`,
          thumbnail,
          market: 'JP',
          rawData: JSON.stringify({ ratingScore: song.ratingScore, songType: song.songType }),
        },
      })
      saved++
    }

    logger.info('niconico', `Crawl complete. Total new: ${saved}`)
  } catch (err) {
    logger.error('niconico', `Failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
