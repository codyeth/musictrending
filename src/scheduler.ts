import cron from 'node-cron'
import { crawlAll } from './crawlers/all.js'
import { initDefaultChannels } from './crawlers/youtube-channels.js'
import { runScorer } from './processor/scorer.js'
import { pushAlert } from './bot/telegram-bot.js'
import prisma from './db.js'
import { logger } from './utils/logger.js'

// Max alerts per run and max age of a trend to be alerted
const ALERT_MAX_PER_RUN = 15
const ALERT_MAX_AGE_DAYS = 7

/**
 * Returns true if the pipeline already has enough items to fill an alert run.
 * Counts: PENDING/PROCESSING (not yet scored) + COMPLETED unalerted fresh items.
 * If >= ALERT_MAX_PER_RUN, the scheduled crawl can be skipped to save API calls.
 */
async function hasSufficientPipeline(): Promise<boolean> {
  const sevenDaysAgo = new Date(Date.now() - ALERT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000)
  const [pendingCount, completedCount] = await Promise.all([
    prisma.trend.count({
      where: { status: { in: ['PENDING', 'PROCESSING'] } },
    }),
    prisma.trend.count({
      where: {
        status: 'COMPLETED',
        alerted: false,
        decision: null,
        createdAt: { gte: sevenDaysAgo },
      },
    }),
  ])
  return (pendingCount + completedCount) >= ALERT_MAX_PER_RUN
}

/**
 * Returns the effective date of a trend for sorting/filtering:
 * releaseDate (from rawData) > publishedAt (YouTube channels) > createdAt
 */
function getEffectiveDate(trend: { createdAt: Date; rawData: string | null }): Date {
  if (trend.rawData) {
    try {
      const raw = JSON.parse(trend.rawData) as Record<string, unknown>
      if (typeof raw['releaseDate'] === 'string' && raw['releaseDate']) {
        const d = new Date(raw['releaseDate'])
        if (!isNaN(d.getTime())) return d
      }
      if (typeof raw['publishedAt'] === 'string' && raw['publishedAt']) {
        const d = new Date(raw['publishedAt'])
        if (!isNaN(d.getTime())) return d
      }
    } catch {}
  }
  return trend.createdAt
}

// Send exactly 1 alert per call — caller controls the cadence
async function checkAndAlert() {
  const sevenDaysAgo = new Date(Date.now() - ALERT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000)

  const candidates = await prisma.trend.findMany({
    where: {
      status: 'COMPLETED',
      alerted: false,
      decision: null,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  // Filter older than 7 days, sort newest first
  const fresh = candidates
    .filter(t => getEffectiveDate(t) >= sevenDaysAgo)
    .sort((a, b) => getEffectiveDate(b).getTime() - getEffectiveDate(a).getTime())

  if (fresh.length === 0) return

  // Send only the single freshest unalerted trend
  const trend = fresh[0]!
  await prisma.trend.update({ where: { id: trend.id }, data: { alerted: true } })
  try {
    await pushAlert(trend)
    logger.info('scheduler', `Alerted trend ${trend.id} — "${trend.title}" (${fresh.length - 1} more queued)`)
  } catch (err) {
    logger.warn('scheduler', `Alert send failed for trend ${trend.id}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function startScheduler() {
  initDefaultChannels()

  async function runScheduledCrawl(label: string) {
    try {
      if (await hasSufficientPipeline()) {
        logger.info('scheduler', `${label}: pipeline already has ${ALERT_MAX_PER_RUN}+ items — skipping crawl`)
        return
      }
      logger.info('scheduler', `Running ${label} crawl`)
      await crawlAll()
    } catch (err) {
      logger.error('scheduler', `${label} crawl failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 07:00 — Morning crawl
  cron.schedule('0 7 * * *', () => { void runScheduledCrawl('07:00') })

  // 13:00 — Midday crawl (catch viral spikes from overnight/morning)
  cron.schedule('0 13 * * *', () => { void runScheduledCrawl('13:00') })

  // 20:00 — Evening crawl (US/BR prime time content drops)
  cron.schedule('0 20 * * *', () => { void runScheduledCrawl('20:00') })

  // Every 15 minutes — AI Scorer (score pending trends)
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runScorer()
    } catch (err) {
      logger.error('scheduler', `Scorer cycle failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // Every 5 minutes — Send 1 alert card (gradual delivery, not a flood)
  cron.schedule('*/5 * * * *', async () => {
    try {
      await checkAndAlert()
    } catch (err) {
      logger.error('scheduler', `Alert cycle failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  logger.info('scheduler', 'All cron jobs registered')
}
