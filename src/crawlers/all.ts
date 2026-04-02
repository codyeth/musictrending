import { crawlTikTok } from './tiktok.js'
import { crawlYoutubeChannels } from './youtube-channels.js'
import { crawlKworbYoutube } from './kworb-youtube.js'
import { crawlYoutubeSearch } from './youtube-search.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import type { Trend } from '@prisma/client'

// Sources: TikTok + YouTube only
// YouTube Search = keyword-targeted phonk/funk (cần API key)
// Kworb YouTube  = realtime YouTube charts (no key needed)
// YouTube Ch.    = RSS từ kênh theo dõi thủ công
// TikTok         = Creative Center trending (khi API available)
const CRAWL_SOURCES: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: 'YouTube Search', fn: crawlYoutubeSearch },
  { name: 'TikTok',         fn: crawlTikTok },
  { name: 'Kworb YouTube',  fn: crawlKworbYoutube },
  { name: 'YouTube Ch.',    fn: crawlYoutubeChannels },
]

const MAX_NEW_ITEMS = 15  // Hard cap — never return more than this

/**
 * Crawl sources sequentially, stopping once `target` new items are saved.
 * @param target   How many new items to collect before stopping (default: MAX_NEW_ITEMS)
 * @param forceAll If true, ignore target and run all sources
 */
export async function crawlAll(target = MAX_NEW_ITEMS, forceAll = false): Promise<Trend[]> {
  const clampedTarget = Math.min(Math.max(1, target), MAX_NEW_ITEMS)
  const before = new Date()
  let newCount = 0

  for (const source of CRAWL_SOURCES) {
    if (!forceAll && newCount >= clampedTarget) {
      logger.info('crawl-all', `Reached ${clampedTarget} new items — skipping remaining sources`)
      break
    }

    try {
      await source.fn()
      newCount = await prisma.trend.count({ where: { createdAt: { gte: before } } })
      logger.info('crawl-all', `${source.name} done — ${newCount} new items so far`)
    } catch (err) {
      logger.warn('crawl-all', `${source.name} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return prisma.trend.findMany({
    where: { createdAt: { gte: before } },
    orderBy: { createdAt: 'desc' },
    take: clampedTarget,
  })
}
