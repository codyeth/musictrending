import { crawlSpotify } from './spotify.js'
import { crawlReddit } from './reddit.js'
import { crawlNiconico } from './niconico.js'
import { crawlMelon } from './melon.js'
import { crawlGoogleTrends } from './google-trends.js'
import { crawlAppleMusic } from './apple-music.js'
import { crawlShazam } from './shazam.js'
import { crawlBillboard } from './billboard.js'
import { crawlSubscriptions } from './subscriptions.js'
import { crawlYoutubeChannels } from './youtube-channels.js'
import prisma from '../db.js'
import type { Trend } from '@prisma/client'

export async function crawlAll(): Promise<Trend[]> {
  const before = new Date()

  await Promise.allSettled([
    crawlSpotify(),
    crawlReddit(),
    crawlNiconico(),
    crawlMelon(),
    crawlGoogleTrends(),
    crawlAppleMusic(),
    crawlShazam(),
    crawlBillboard(),
    crawlSubscriptions(),
    crawlYoutubeChannels(),
  ])

  // Return only trends newly created during this crawl run
  const newTrends = await prisma.trend.findMany({
    where: { createdAt: { gte: before } },
    orderBy: { createdAt: 'desc' },
  })

  return newTrends
}
