import cron from 'node-cron'
import { crawlSpotify } from './crawlers/spotify.js'
import { crawlReddit } from './crawlers/reddit.js'
import { crawlNiconico } from './crawlers/niconico.js'
import { crawlMelon } from './crawlers/melon.js'
import { crawlGoogleTrends } from './crawlers/google-trends.js'
import { crawlSubscriptions } from './crawlers/subscriptions.js'
import { crawlYoutubeChannels, initDefaultChannels } from './crawlers/youtube-channels.js'
import { runScorer } from './processor/scorer.js'
import { pushAlert } from './bot/telegram-bot.js'
import prisma from './db.js'
import { logger } from './utils/logger.js'
import { config } from './config.js'

async function checkAndAlert() {
  // Only alert trends that have NOT been alerted yet — fixes duplicate spam
  const newHighScore = await prisma.trend.findMany({
    where: {
      status: 'COMPLETED',
      totalScore: { gte: config.scoring.alertThreshold },
      alerted: false,
      decision: null,
    },
    orderBy: { totalScore: 'desc' },
    take: 5,
  })

  for (const trend of newHighScore) {
    // Mark as alerted BEFORE sending to prevent retry on failure spam
    await prisma.trend.update({ where: { id: trend.id }, data: { alerted: true } })
    await pushAlert(trend)
    await new Promise(r => setTimeout(r, 1000))
  }
}

export function startScheduler() {
  initDefaultChannels()
  // 07:00 — Spotify + Melon
  cron.schedule('0 7 * * *', async () => {
    logger.info('scheduler', 'Running 07:00 job: Spotify + Melon')
    await crawlSpotify()
    await crawlMelon()
  })

  // 08:00 — Google Trends
  cron.schedule('0 8 * * *', async () => {
    logger.info('scheduler', 'Running 08:00 job: Google Trends')
    await crawlGoogleTrends()
  })

  // 09:00 — Reddit + Niconico + Subscriptions + YouTube Channels
  cron.schedule('0 9 * * *', async () => {
    logger.info('scheduler', 'Running 09:00 job: Reddit + Niconico + Subscriptions + YouTube')
    await crawlReddit()
    await crawlNiconico()
    await crawlSubscriptions()
    await crawlYoutubeChannels()
  })

  // 18:00 — YouTube Channels second run
  cron.schedule('0 18 * * *', async () => {
    logger.info('scheduler', 'Running 18:00 job: YouTube Channels')
    await crawlYoutubeChannels()
  })

  // 20:00 — Google Trends second run
  cron.schedule('0 20 * * *', async () => {
    logger.info('scheduler', 'Running 20:00 job: Google Trends')
    await crawlGoogleTrends()
  })

  // Every 15 minutes — AI Scorer + Alert check
  cron.schedule('*/15 * * * *', async () => {
    await runScorer()
    await checkAndAlert()
  })

  logger.info('scheduler', 'All cron jobs registered')
}
