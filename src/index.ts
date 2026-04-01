import 'dotenv/config'
import prisma from './db.js'
import { config } from './config.js'
import { logger } from './utils/logger.js'
import { initBot } from './bot/telegram-bot.js'
import { startScheduler } from './scheduler.js'
import { startDashboard } from './dashboard/server.js'
import { crawlSpotify } from './crawlers/spotify.js'
import { crawlReddit } from './crawlers/reddit.js'
import { crawlNiconico } from './crawlers/niconico.js'
import { crawlMelon } from './crawlers/melon.js'
import { crawlGoogleTrends } from './crawlers/google-trends.js'
import { runScorer } from './processor/scorer.js'

async function main() {
  logger.info('main', '🎵 Music Trend Tool starting...')

  await prisma.$connect()
  logger.info('main', 'Database connected')

  initBot()

  // Handle /crawlnow signal from bot
  process.on('crawlnow' as any, async () => {
    logger.info('main', 'Manual crawl triggered')
    await Promise.allSettled([
      crawlSpotify(),
      crawlReddit(),
      crawlNiconico(),
      crawlMelon(),
      crawlGoogleTrends(),
    ])
    await runScorer()
  })

  startDashboard()
  startScheduler()

  logger.info('main', `Dashboard: http://localhost:${config.dashboard.port}`)
  logger.info('main', `Features: OpenRouter=${config.hasOpenRouter} | Reddit=${config.hasReddit} | Spotify=${config.hasSpotify}`)

  // Initial crawl on startup (non-Spotify sources that don't need credentials)
  logger.info('main', 'Running initial crawl...')
  await Promise.allSettled([
    crawlReddit(),
    crawlNiconico(),
    crawlGoogleTrends(),
  ])
  await runScorer()

  process.on('SIGINT', async () => {
    logger.info('main', 'Shutting down...')
    await prisma.$disconnect()
    process.exit(0)
  })
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
