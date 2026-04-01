import cron from 'node-cron'
import { crawlAll } from './crawlers/all.js'
import { crawlYoutubeChannels, initDefaultChannels } from './crawlers/youtube-channels.js'
import { runScorer } from './processor/scorer.js'
import { pushAlert } from './bot/telegram-bot.js'
import prisma from './db.js'
import { logger } from './utils/logger.js'
import { config } from './config.js'

async function checkAndAlert() {
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
    await prisma.trend.update({ where: { id: trend.id }, data: { alerted: true } })
    await pushAlert(trend)
    await new Promise(r => setTimeout(r, 1000))
  }
}

export function startScheduler() {
  initDefaultChannels()

  // 07:00 — Full crawl
  cron.schedule('0 7 * * *', async () => {
    logger.info('scheduler', 'Running 07:00 full crawl')
    await crawlAll()
  })

  // 18:00 — YouTube Channels second run
  cron.schedule('0 18 * * *', async () => {
    logger.info('scheduler', 'Running 18:00 YouTube Channels')
    await crawlYoutubeChannels()
  })

  // Every 15 minutes — AI Scorer + Alert check
  cron.schedule('*/15 * * * *', async () => {
    await runScorer()
    await checkAndAlert()
  })

  logger.info('scheduler', 'All cron jobs registered')
}
