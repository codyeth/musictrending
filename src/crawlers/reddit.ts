import axios from 'axios'
import prisma from '../db.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'
import { classifyTrend } from '../utils/classify.js'

const SUBREDDITS = [
  'funk', 'lofi', 'citypop', 'phonk', 'japanesemusic',
  'tiktokmusic', 'listentothis'
]

async function getRedditToken(): Promise<string> {
  const credentials = Buffer.from(
    `${config.reddit.clientId}:${config.reddit.clientSecret}`
  ).toString('base64')

  const res = await axios.post(
    'https://www.reddit.com/api/v1/access_token',
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'User-Agent': config.reddit.userAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  )
  return res.data.access_token
}

async function fetchHotPosts(token: string, subreddit: string) {
  const res = await axios.get(
    `https://oauth.reddit.com/r/${subreddit}/hot?limit=25&t=day`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': config.reddit.userAgent,
      },
      timeout: 10000,
    }
  )
  return res.data?.data?.children ?? []
}

export async function crawlReddit() {
  if (!config.hasReddit) {
    logger.warn('reddit', 'Reddit credentials not set, skipping')
    return
  }

  logger.info('reddit', 'Starting Reddit crawl...')
  let token: string

  try {
    token = await getRedditToken()
  } catch (err) {
    logger.error('reddit', `Failed to get token: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  let saved = 0

  for (const subreddit of SUBREDDITS) {
    try {
      const posts = await fetchHotPosts(token, subreddit)

      for (const post of posts) {
        const data = post.data
        if (data.score < 50) continue // ignore low-engagement posts

        const externalId = `reddit_${data.id}`
        const existing = await prisma.trend.findUnique({ where: { externalId } })
        if (existing) continue

        // Try to extract artist - title from post title (common format: "Artist - Title")
        const parts = (data.title as string).split(' - ')
        const artist = parts.length > 1 ? parts[0].trim() : 'Unknown'
        const title = parts.length > 1 ? parts.slice(1).join(' - ').trim() : data.title

        await prisma.trend.create({
          data: {
            externalId,
            source: 'REDDIT',
            title,
            artist,
            url: `https://reddit.com${data.permalink}`,
            market: 'US',
            type: classifyTrend('REDDIT', 'US'),
            rawData: JSON.stringify({
              subreddit,
              score: data.score,
              numComments: data.num_comments,
              originalTitle: data.title,
            }),
          },
        })
        saved++
      }

      logger.info('reddit', `r/${subreddit}: processed`)
    } catch (err) {
      logger.warn('reddit', `Failed r/${subreddit}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      await new Promise(r => setTimeout(r, 300))
    }
  }

  logger.info('reddit', `Crawl complete. Total new: ${saved}`)
}
