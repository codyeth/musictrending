import axios from 'axios'
import OpenAI from 'openai'
import prisma from '../db.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

const client = new OpenAI({
  baseURL: config.openrouter.apiBase,
  apiKey: config.openrouter.apiKey,
})

export interface VideoMeta {
  title: string
  author: string
  platform: 'youtube' | 'niconico' | 'unknown'
}

export interface AnalysisResult {
  meta: VideoMeta
  suggestions: Array<{ title: string; artist: string; market: string; reason: string }>
  styleContext: string
  savedCount: number
}

async function fetchMeta(url: string): Promise<VideoMeta> {
  const res = await axios.get(
    `https://noembed.com/embed?url=${encodeURIComponent(url)}`,
    { timeout: 8000 }
  )
  const data = res.data
  if (data.error) throw new Error(`Không đọc được link: ${data.error}`)

  const platform = url.includes('youtube.com') || url.includes('youtu.be')
    ? 'youtube'
    : url.includes('nicovideo.jp') || url.includes('nico.ms')
      ? 'niconico'
      : 'unknown'

  return {
    title: data.title ?? 'Unknown',
    author: data.author_name ?? 'Unknown',
    platform,
  }
}

const ANALYZE_PROMPT = `Bạn là chuyên gia phân tích trend nhạc cho team sản xuất nhạc funk/instrumental.

Dựa vào bài nhạc được cung cấp, hãy:
1. Mô tả ngắn style/vibe (dùng làm context theo dõi lâu dài)
2. Gợi ý 5 bài nhạc/trend tương tự đang có tiềm năng viral ở JP/US/KR/BR/ID

QUAN TRỌNG: Tất cả nội dung text phải viết bằng TIẾNG VIỆT.

Trả về JSON (không có text khác):
{
  "styleContext": "<thể loại, BPM range, aesthetic, thị trường chính — 1-2 câu, bằng tiếng Việt>",
  "suggestions": [
    {"title": "...", "artist": "...", "market": "JP|US|KR|BR|ID", "reason": "<lý do trending ngắn, bằng tiếng Việt>"}
  ]
}`

export async function analyzeLink(url: string): Promise<AnalysisResult> {
  const meta = await fetchMeta(url)
  logger.info('analyzer', `Analyzing: "${meta.title}" by ${meta.author}`)

  const res = await client.chat.completions.create({
    model: config.openrouter.model,
    messages: [
      { role: 'system', content: ANALYZE_PROMPT },
      { role: 'user', content: `Bài nhạc: "${meta.title}" by ${meta.author} (${meta.platform})` },
    ],
    temperature: 0.4,
  })

  const text = res.choices[0]?.message?.content ?? '{}'
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()

  let parsed: { styleContext: string; suggestions: Array<{ title: string; artist: string; market: string; reason: string }> }
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    logger.error('analyzer', `JSON parse failed: ${cleaned.slice(0, 300)}`)
    throw new Error('AI trả về dữ liệu không hợp lệ')
  }

  let savedCount = 0
  for (const s of parsed.suggestions) {
    const externalId = `suggest_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
    await prisma.trend.create({
      data: {
        externalId,
        source: 'MANUAL',
        title: s.title,
        artist: s.artist,
        market: s.market,
        rawData: JSON.stringify({ reason: s.reason, suggestedFrom: url }),
      },
    })
    savedCount++
    // Small delay to avoid duplicate timestamps in externalId
    await new Promise(r => setTimeout(r, 5))
  }

  return { meta, suggestions: parsed.suggestions, styleContext: parsed.styleContext, savedCount }
}
