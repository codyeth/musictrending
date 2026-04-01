import fs from 'fs'
import path from 'path'
import OpenAI from 'openai'
import prisma from '../db.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

const SUBS_FILE = path.resolve('data/subscriptions.json')

export interface Subscription {
  id: string
  name: string
  styleContext: string
  sourceUrl: string
  addedBy: number
  addedAt: string
}

export function loadSubscriptions(): Subscription[] {
  try {
    if (fs.existsSync(SUBS_FILE)) {
      return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf-8'))
    }
  } catch {}
  return []
}

export function saveSubscription(sub: Omit<Subscription, 'id' | 'addedAt'>): Subscription {
  const subs = loadSubscriptions()
  const existing = subs.findIndex(s => s.name.toLowerCase() === sub.name.toLowerCase())

  const full: Subscription = {
    ...sub,
    id: `sub_${Date.now()}`,
    addedAt: new Date().toISOString(),
  }

  if (existing >= 0) {
    subs[existing] = full
  } else {
    subs.push(full)
  }

  const dir = path.dirname(SUBS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2))
  return full
}

export function removeSubscription(name: string): boolean {
  const subs = loadSubscriptions()
  const filtered = subs.filter(s => s.name.toLowerCase() !== name.toLowerCase())
  if (filtered.length === subs.length) return false
  fs.writeFileSync(SUBS_FILE, JSON.stringify(filtered, null, 2))
  return true
}

const client = new OpenAI({
  baseURL: config.openrouter.apiBase,
  apiKey: config.openrouter.apiKey,
})

const FOLLOW_PROMPT = `Bạn là chuyên gia phân tích trend nhạc cho team funk/instrumental.
Dựa vào nghệ sĩ/nguồn đang được theo dõi, gợi ý 3 bài nhạc mới hoặc trend tương tự đang nổi gần đây.
Ưu tiên bài mới ra trong vòng 2 tuần, có tiềm năng viral.
Trả về JSON array (không có text khác):
[{"title": "...", "artist": "...", "market": "JP|US|KR|BR|ID", "note": "<lý do ngắn>"}]`

export async function crawlSubscriptions(): Promise<void> {
  if (!config.hasOpenRouter) return

  const subs = loadSubscriptions()
  if (subs.length === 0) return

  logger.info('subscriptions', `Crawling ${subs.length} subscribed source(s)...`)
  let totalNew = 0

  for (const sub of subs) {
    try {
      const res = await client.chat.completions.create({
        model: config.openrouter.model,
        messages: [
          { role: 'system', content: FOLLOW_PROMPT },
          { role: 'user', content: `Nghệ sĩ/Nguồn: ${sub.name}\nStyle: ${sub.styleContext}` },
        ],
        temperature: 0.5,
      })

      const text = res.choices[0]?.message?.content ?? '[]'
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()

      let suggestions: Array<{ title: string; artist: string; market: string; note: string }>
      try {
        suggestions = JSON.parse(cleaned)
      } catch {
        logger.warn('subscriptions', `JSON parse failed for "${sub.name}"`)
        continue
      }

      for (const s of suggestions) {
        const externalId = `sub_${sub.id}_${s.title.slice(0, 15)}_${s.artist.slice(0, 10)}`
          .replace(/[^a-zA-Z0-9_]/g, '_')
        const exists = await prisma.trend.findUnique({ where: { externalId } })
        if (exists) continue

        await prisma.trend.create({
          data: {
            externalId,
            source: 'MANUAL',
            title: s.title,
            artist: s.artist,
            market: s.market,
            rawData: JSON.stringify({ note: s.note, fromSubscription: sub.name }),
          },
        })
        totalNew++
      }
    } catch (err) {
      logger.error('subscriptions', `Failed for "${sub.name}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  logger.info('subscriptions', `Done. ${totalNew} new trends from subscriptions.`)
}
