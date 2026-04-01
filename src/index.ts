import 'dotenv/config'
import prisma from './db.js'
import { config } from './config.js'
import { logger } from './utils/logger.js'
import { initBot } from './bot/telegram-bot.js'
import { startScheduler } from './scheduler.js'
import { startDashboard } from './dashboard/server.js'
import { crawlAll } from './crawlers/all.js'
import { runScorer } from './processor/scorer.js'

async function main() {
  logger.info('main', '🎵 Music Trend Tool starting...')

  await prisma.$connect()
  logger.info('main', 'Database connected')

  initBot()

  startDashboard()
  startScheduler()

  logger.info('main', `Dashboard: http://localhost:${config.dashboard.port}`)
  logger.info('main', `Features: OpenRouter=${config.hasOpenRouter} | Reddit=${config.hasReddit} | Spotify=${config.hasSpotify}`)

  // Initial crawl on startup
  logger.info('main', 'Running initial crawl...')
  await crawlAll()
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
