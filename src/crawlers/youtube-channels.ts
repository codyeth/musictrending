import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { classifyTrend } from '../utils/classify.js'

// Resolve relative to project root (2 levels up from src/crawlers/)
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHANNELS_FILE = path.join(PROJECT_ROOT, 'data', 'youtube-channels.json')

export interface WatchSource {
  id: string
  platform: string    // 'youtube' | 'tiktok' | 'soundcloud' | 'instagram' | 'twitter' | 'niconico' | 'spotify' | 'other'
  name: string
  channelId: string   // platform-specific ID or handle
  url: string         // full profile/channel URL
  market: string
  genre: string
  addedAt: string
}

// Backward compat alias
export type YTChannel = WatchSource

// ─── Platform helpers ─────────────────────────────────────────────

export function detectPlatform(url: string): string {
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube'
  if (/tiktok\.com/.test(url)) return 'tiktok'
  if (/soundcloud\.com/.test(url)) return 'soundcloud'
  if (/instagram\.com/.test(url)) return 'instagram'
  if (/twitter\.com|x\.com/.test(url)) return 'twitter'
  if (/nicovideo\.jp|nico\.ms/.test(url)) return 'niconico'
  if (/spotify\.com/.test(url)) return 'spotify'
  return 'other'
}

export function platformIcon(platform: string): string {
  const icons: Record<string, string> = {
    youtube: '▶️',
    tiktok: '🎵',
    soundcloud: '☁️',
    instagram: '📸',
    twitter: '🐦',
    niconico: '🎌',
    spotify: '🎧',
    other: '🌐',
  }
  return icons[platform] ?? '🌐'
}

export function platformLabel(platform: string): string {
  const labels: Record<string, string> = {
    youtube: 'YouTube',
    tiktok: 'TikTok',
    soundcloud: 'SoundCloud',
    instagram: 'Instagram',
    twitter: 'Twitter/X',
    niconico: 'Niconico',
    spotify: 'Spotify',
    other: 'Khác',
  }
  return labels[platform] ?? platform
}

// ─── Source storage ───────────────────────────────────────────────

export function loadChannels(): WatchSource[] {
  try {
    if (fs.existsSync(CHANNELS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8')) as Record<string, unknown>[]
      // Normalize old data that lacks platform/url fields
      return raw.map(ch => ({
        platform: 'youtube',
        url: `https://www.youtube.com/channel/${ch['channelId']}`,
        ...ch,
      })) as WatchSource[]
    }
  } catch (err) {
    logger.warn('youtube-channels', `Failed to load channels file: ${err instanceof Error ? err.message : String(err)}`)
  }
  return []
}

function saveChannels(channels: WatchSource[]): void {
  const dir = path.dirname(CHANNELS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2))
}

export function addChannel(ch: Omit<WatchSource, 'id' | 'addedAt'>): WatchSource {
  const channels = loadChannels()
  const existing = channels.findIndex(c => c.channelId === ch.channelId && c.platform === ch.platform)
  const full: WatchSource = { ...ch, id: `src_${Date.now()}`, addedAt: new Date().toISOString() }
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
  const dir = path.dirname(CHANNELS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(CHANNELS_FILE)) {
    fs.writeFileSync(CHANNELS_FILE, '[]')
  }
}

// Allowed hostnames for SSRF protection — only known public platforms
const ALLOWED_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com',
  'tiktok.com', 'www.tiktok.com',
  'soundcloud.com', 'www.soundcloud.com',
  'instagram.com', 'www.instagram.com',
  'twitter.com', 'www.twitter.com', 'x.com', 'www.x.com',
  'nicovideo.jp', 'www.nicovideo.jp', 'nico.ms',
  'open.spotify.com',
])

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    const host = parsed.hostname.toLowerCase()
    return ALLOWED_HOSTS.has(host)
  } catch {
    return false
  }
}

// ─── Add source from URL (auto-detect platform) ───────────────────

export async function addSourceFromUrl(url: string, market = 'US'): Promise<WatchSource | null> {
  if (!isAllowedUrl(url)) return null
  const platform = detectPlatform(url)

  if (platform === 'youtube') {
    const resolved = await resolveChannelUrl(url)
    if (!resolved) return null
    return addChannel({
      platform: 'youtube',
      name: resolved.name,
      channelId: resolved.channelId,
      url: `https://www.youtube.com/channel/${resolved.channelId}`,
      market,
      genre: 'music',
    })
  }

  // For other platforms: extract handle from URL path
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const handle = parts.find(p => p.startsWith('@')) ?? parts[0] ?? ''
    const name = handle.replace('@', '')
    if (!name) return null
    return addChannel({
      platform,
      name,
      channelId: handle || name,
      url,
      market,
      genre: 'music',
    })
  } catch {
    return null
  }
}

// ─── YouTube channel resolver ─────────────────────────────────────

export async function resolveChannelUrl(url: string): Promise<{ channelId: string; name: string } | null> {
  // Reject video URLs — we want channel pages only
  if (/youtube\.com\/watch|youtu\.be\/[a-zA-Z0-9_-]{11}$/.test(url)) return null

  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    const html: string = res.data

    const idMatch =
      html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/)?.[1] ??
      html.match(/channel\/(UC[a-zA-Z0-9_-]{22})/)?.[1] ??
      html.match(/"externalId":"(UC[a-zA-Z0-9_-]{22})"/)?.[1]

    if (!idMatch) return null

    const nameMatch =
      html.match(/"channelName":"([^"]+)"/)?.[1] ??
      html.match(/<title>([^<]+) - YouTube<\/title>/)?.[1] ??
      'Unknown'

    return { channelId: idMatch, name: nameMatch.trim() }
  } catch {
    return null
  }
}

// ─── RSS crawler (YouTube only) ───────────────────────────────────

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
  const channels = loadChannels().filter(c => c.platform === 'youtube')
  if (channels.length === 0) return

  logger.info('youtube-channels', `Crawling ${channels.length} YouTube channels...`)

  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
  let totalNew = 0

  for (const ch of channels) {
    try {
      const entries = await fetchChannelRSS(ch.channelId, ch.name)

      for (const entry of entries) {
        const publishedDate = new Date(entry.published)
        if (publishedDate < cutoff) continue

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

      await new Promise(r => setTimeout(r, 500))
    } catch (err) {
      logger.warn('youtube-channels', `Failed "${ch.name}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  logger.info('youtube-channels', `Done. ${totalNew} new videos from YouTube channels.`)
}
