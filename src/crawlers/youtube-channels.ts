import axios from 'axios'
import fs from 'fs'
import path from 'path'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { classifyTrend } from '../utils/classify.js'

const CHANNELS_FILE = path.resolve('data/youtube-channels.json')

export interface YTChannel {
  id: string          // internal UUID
  name: string
  channelId: string   // YouTube UCxxxxxxx ID
  market: string
  genre: string
  addedAt: string
}

// ─── Channel storage ──────────────────────────────────────────────

export function loadChannels(): YTChannel[] {
  try {
    if (fs.existsSync(CHANNELS_FILE)) {
      return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'))
    }
  } catch {}
  return []
}

function saveChannels(channels: YTChannel[]): void {
  const dir = path.dirname(CHANNELS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2))
}

export function addChannel(ch: Omit<YTChannel, 'id' | 'addedAt'>): YTChannel {
  const channels = loadChannels()
  const existing = channels.findIndex(c => c.channelId === ch.channelId)
  const full: YTChannel = { ...ch, id: `yt_${Date.now()}`, addedAt: new Date().toISOString() }
  if (existing >= 0) channels[existing] = full
  else channels.push(full)
  saveChannels(channels)
  return full
}

export function removeChannel(id: string): boolean {
  const channels = loadChannels()
  const filtered = channels.filter(c => c.id !== id)
  if (filtered.length === channels.length) return false
  saveChannels(filtered)
  return true
}

export function initDefaultChannels(): void {
  // No hardcoded defaults — channel IDs must be resolved from real URLs
  // Use /addchannel or resolveChannelUrl() to add channels
  const dir = path.dirname(CHANNELS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(CHANNELS_FILE)) {
    fs.writeFileSync(CHANNELS_FILE, '[]')
  }
}

// Resolve a YouTube channel URL to its UC... channel ID by fetching the page
export async function resolveChannelUrl(url: string): Promise<{ channelId: string; name: string } | null> {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    const html: string = res.data

    // Extract channelId from various places in the HTML
    const idMatch =
      html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/)?.[1] ??
      html.match(/channel\/(UC[a-zA-Z0-9_-]{22})/)?.[1] ??
      html.match(/"externalId":"(UC[a-zA-Z0-9_-]{22})"/)?.[1]

    if (!idMatch) return null

    // Extract channel name
    const nameMatch =
      html.match(/"channelName":"([^"]+)"/)?.[1] ??
      html.match(/<title>([^<]+) - YouTube<\/title>/)?.[1] ??
      'Unknown'

    return { channelId: idMatch, name: nameMatch.trim() }
  } catch {
    return null
  }
}

// ─── RSS crawler ──────────────────────────────────────────────────

interface RSSEntry {
  title: string
  published: string
  videoId: string
  channelName: string
}

async function fetchChannelRSS(channelId: string, channelName: string): Promise<RSSEntry[]> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
  const res = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; music-tool/1.0)' },
  })

  const xml: string = res.data
  const entries: RSSEntry[] = []

  // Simple XML parse without dependency
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let match
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1]!
    const title = block.match(/<title>(.*?)<\/title>/)?.[1] ?? ''
    const published = block.match(/<published>(.*?)<\/published>/)?.[1] ?? ''
    const videoId = block.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1] ?? ''
    if (title && published && videoId) {
      entries.push({ title, published, videoId, channelName })
    }
  }
  return entries
}

export async function crawlYoutubeChannels(): Promise<void> {
  const channels = loadChannels()
  if (channels.length === 0) return

  logger.info('youtube-channels', `Crawling ${channels.length} YouTube channels...`)

  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
  let totalNew = 0

  for (const ch of channels) {
    try {
      const entries = await fetchChannelRSS(ch.channelId, ch.name)

      for (const entry of entries) {
        const publishedDate = new Date(entry.published)
        if (publishedDate < cutoff) continue  // older than 14 days

        const externalId = `yt_ch_${entry.videoId}`
        const exists = await prisma.trend.findUnique({ where: { externalId } })
        if (exists) continue

        await prisma.trend.create({
          data: {
            externalId,
            source: 'MANUAL',
            title: entry.title,
            artist: ch.name,
            url: `https://www.youtube.com/watch?v=${entry.videoId}`,
            market: ch.market,
            type: classifyTrend('MANUAL', ch.market),
            rawData: JSON.stringify({
              videoId: entry.videoId,
              genre: ch.genre,
              publishedAt: entry.published,
              fromChannel: ch.name,
            }),
          },
        })
        totalNew++
      }

      await new Promise(r => setTimeout(r, 500)) // rate limit
    } catch (err) {
      logger.warn('youtube-channels', `Failed "${ch.name}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  logger.info('youtube-channels', `Done. ${totalNew} new videos from YouTube channels.`)
}
