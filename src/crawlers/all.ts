import { crawlTikTok } from './tiktok.js'
import { crawlReddit } from './reddit.js'
import { crawlGoogleTrends } from './google-trends.js'
import { crawlYoutubeChannels } from './youtube-channels.js'
import { crawlKworbYoutube } from './kworb-youtube.js'
import { crawlSoundCloud } from './soundcloud.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import type { Trend } from '@prisma/client'

// Sources ordered by signal quality (highest ROI first)
// TikTok + Kworb = real view counts, SoundCloud = early signal, then broader signals
const CRAWL_SOURCES: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: 'TikTok',         fn: crawlTikTok },
  { name: 'Kworb YouTube',  fn: crawlKworbYoutube },
  { name: 'SoundCloud',     fn: crawlSoundCloud },
  { name: 'YouTube Ch.',    fn: crawlYoutubeChannels },
  { name: 'Reddit',         fn: crawlReddit },
  { name: 'Google Trends',  fn: crawlGoogleTrends },
]

const MAX_NEW_ITEMS = 15  // Hard cap — never return more than this

/**
 * Crawl sources sequentially, stopping once `target` new items are saved.
 * @param target  How many new items to collect before stopping (default: MAX_NEW_ITEMS)
 * @param forceAll  If true, ignore target and run all sources (not used currently)
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
      // Count how many new items were saved since this crawl session started
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
