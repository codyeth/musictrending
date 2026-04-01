import OpenAI from 'openai'
import prisma from '../db.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

const client = new OpenAI({
  baseURL: config.openrouter.apiBase,
  apiKey: config.openrouter.apiKey,
})

const SYSTEM_PROMPT_REMIX = `Bạn là chuyên gia phân tích trend nhạc cho team sản xuất nhạc instrumental/funk.
Các trend dưới đây là loại REMIX — bài nhạc cụ thể đang viral, team có thể remake/cover ngay.
Chấm điểm theo 6 tiêu chí (điểm tối đa ghi trong ngoặc):

1. leadTime (25đ): Bài mới ra trong 14 ngày = điểm cao nhất. Quá 30 ngày = 0đ.
2. revenuePotential (25đ): CPM thị trường - US/BR/KR = cao, ID = trung bình.
3. velocity (20đ): Tốc độ tăng views/streams/rank trong 7 ngày gần nhất.
4. crossPlatform (15đ): Viral chéo Spotify + YouTube + TikTok cùng lúc = điểm cao.
5. feasibility (10đ): Team instrumental/funk có remake được không. Vocal rõ ràng, melody dễ bắt = cao.
6. saturation (5đ): Ít bài cover tương tự đã có = điểm cao.

Thông tin bổ sung cần trả về:
- bpm: ước tính range BPM
- style: nhạc cụ chủ đạo, vibe, aesthetic (tiếng Việt)
- refTracks: 2-3 bài tương tự để tham khảo (title, artist, viewCount, source "youtube"/"niconico", searchQuery)
- saturation: số bài cover đã có trên thị trường theo market (ước tính)
- cpm: CPM YouTube theo market
- marketProgression: thứ tự thị trường lan theo tuần
- leadTimeWeeks: số tuần còn lại để làm kịp (0 = đã muộn)
- tags: 3-5 tag mô tả

QUAN TRỌNG: Tất cả text (vibe, aiSuggest, style) phải bằng TIẾNG VIỆT.

Trả về mảng JSON, không có text khác:
[{ "index": 1, "scores": {...}, "totalScore": <tổng>, "vibe": "...", "aiSuggest": "...", "bpm": "...", "style": "...", "refTracks": [...], "saturation": {...}, "cpm": {...}, "marketProgression": "...", "leadTimeWeeks": <số>, "tags": [...] }]`

const SYSTEM_PROMPT_IDEA = `Bạn là chuyên gia phân tích trend nhạc cho team sản xuất nhạc instrumental/funk.
Các trend dưới đây là loại IDEA — tín hiệu hành vi người dùng, hướng làm nhạc, không nhất thiết là bài cụ thể.
Chấm điểm theo 6 tiêu chí (điểm tối đa ghi trong ngoặc):

1. leadTime (25đ): Trend đang nổi trong 14 ngày = điểm cao. Đã qua đỉnh = thấp.
2. revenuePotential (25đ): Nếu làm theo hướng này, tiềm năng CPM thị trường đích là bao nhiêu.
3. velocity (20đ): Tốc độ tăng search volume / engagement trong 7 ngày gần nhất.
4. crossPlatform (15đ): Hướng này đang được quan tâm trên nhiều nền tảng không.
5. feasibility (10đ): Team instrumental/funk có thể khai thác hướng này không. Nhạc đại chúng, dễ nghe = cao.
6. saturation (5đ): Thị trường nhạc theo hướng này còn chỗ trống không.

Thông tin bổ sung cần trả về:
- bpm: ước tính range BPM phù hợp với hướng này
- style: mô tả hướng làm (tiếng Việt) — vibe, instrument, audience
- refTracks: 2-3 bài nhạc gần nhất theo hướng này để tham khảo
- saturation: mức độ bão hòa theo market
- cpm: CPM YouTube theo market tiềm năng
- marketProgression: hướng này đang lan từ đâu sang đâu
- leadTimeWeeks: còn bao nhiêu tuần để khai thác
- tags: 3-5 tag mô tả hướng

QUAN TRỌNG: Tất cả text (vibe, aiSuggest, style) phải bằng TIẾNG VIỆT. aiSuggest phải rõ ràng đây là gợi ý hướng làm, không phải bài cụ thể.

Trả về mảng JSON, không có text khác:
[{ "index": 1, "scores": {...}, "totalScore": <tổng>, "vibe": "...", "aiSuggest": "...", "bpm": "...", "style": "...", "refTracks": [...], "saturation": {...}, "cpm": {...}, "marketProgression": "...", "leadTimeWeeks": <số>, "tags": [...] }]`

interface ScoreResult {
  scores: Record<string, number>
  totalScore: number
  vibe: string
  aiSuggest: string
  bpm?: string
  style?: string
  refTracks?: Array<{ title: string; artist: string; viewCount: string; source: string; searchQuery: string }>
  saturation?: Record<string, string>
  cpm?: Record<string, string>
  marketProgression?: string
  leadTimeWeeks?: number
  tags?: string[]
}

async function scoreBatch(trends: Array<{ id: number; title: string; artist: string; source: string; market: string | null; rawData: string | null; type: string }>) {
  // Split by type so each batch uses the right prompt
  const batchType = trends[0]?.type === 'IDEA' ? 'IDEA' : 'REMIX'
  const systemPrompt = batchType === 'IDEA' ? SYSTEM_PROMPT_IDEA : SYSTEM_PROMPT_REMIX

  const input = trends.map((t, i) =>
    `${i + 1}. "${t.title}" by ${t.artist} | Nguồn: ${t.source} | Thị trường: ${t.market ?? 'Unknown'} | Data: ${t.rawData ?? '{}'}`
  ).join('\n')

  const res = await client.chat.completions.create({
    model: config.openrouter.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Chấm điểm ${trends.length} trend loại ${batchType} sau:\n\n${input}\n\nTrả về mảng JSON đầy đủ.` }
    ],
    temperature: 0.3,
  })

  const text = res.choices[0]?.message?.content ?? '[]'
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  let parsed: Array<{ index: number } & ScoreResult>
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    logger.error('scorer', `JSON parse failed. Raw response: ${cleaned.slice(0, 500)}`)
    throw new Error(`AI returned invalid JSON`)
  }
  return parsed
}

function getUrgency(score: number, createdAt: Date): string | null {
  // Hard filter: trends older than 6 months never get alerted regardless of score
  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
  if (createdAt < sixMonthsAgo) return null
  if (score >= config.scoring.rushThreshold) return 'RUSH'
  if (score >= config.scoring.watchThreshold) return 'WATCH'
  return null
}

export async function runScorer() {
  // Reset stuck items
  await prisma.trend.updateMany({
    where: {
      status: 'PROCESSING',
      updatedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) },
    },
    data: { status: 'PENDING' },
  })

  if (!config.hasOpenRouter) {
    logger.warn('scorer', 'OpenRouter API key not set, skipping')
    return
  }

  const allPending = await prisma.trend.findMany({
    where: { status: 'PENDING' },
    take: 10,
    orderBy: { createdAt: 'asc' },
  })

  if (allPending.length === 0) return

  // Group by type so each batch uses the correct prompt
  const remixBatch = allPending.filter(t => t.type !== 'IDEA').slice(0, 5)
  const ideaBatch = allPending.filter(t => t.type === 'IDEA').slice(0, 5)
  const pending = remixBatch.length > 0 ? remixBatch : ideaBatch

  logger.info('scorer', `Scoring batch of ${pending.length} trends (type: ${pending[0]?.type ?? '?'})...`)

  // Mark as processing
  await prisma.trend.updateMany({
    where: { id: { in: pending.map(t => t.id) } },
    data: { status: 'PROCESSING' },
  })

  try {
    const results = await scoreBatch(pending)

    for (const result of results) {
      if (result.index < 1 || result.index > pending.length) continue
      const trend = pending[result.index - 1]
      if (!trend) continue

      const totalScore = typeof result.totalScore === 'number' && result.totalScore >= 0 && result.totalScore <= 100
        ? result.totalScore
        : 0

      const urgency = getUrgency(totalScore, trend.createdAt)

      await prisma.trend.update({
        where: { id: trend.id },
        data: {
          status: 'COMPLETED',
          totalScore,
          urgency,
          vibe: result.vibe,
          aiSuggest: result.aiSuggest,
          scores: JSON.stringify(result.scores),
          rawData: JSON.stringify({
            ...JSON.parse(trend.rawData ?? '{}'),
            bpm: result.bpm,
            style: result.style,
            refTracks: result.refTracks,
            saturationByMarket: result.saturation,
            cpm: result.cpm,
            marketProgression: result.marketProgression,
            leadTimeWeeks: result.leadTimeWeeks,
            tags: result.tags,
          }),
        },
      })
    }

    const scoredIds = new Set(results.map(r => {
      const trend = pending[r.index - 1]
      return trend?.id
    }).filter(Boolean))

    const unstuckIds = pending.map(t => t.id).filter(id => !scoredIds.has(id))
    if (unstuckIds.length > 0) {
      await prisma.trend.updateMany({
        where: { id: { in: unstuckIds } },
        data: { status: 'PENDING' }, // reset so they retry next run
      })
      logger.warn('scorer', `Reset ${unstuckIds.length} unscored trends back to PENDING`)
    }

    logger.info('scorer', `Scored ${results.length} trends`)
  } catch (err) {
    logger.error('scorer', `Batch failed: ${err instanceof Error ? err.message : String(err)}`)
    await prisma.trend.updateMany({
      where: { id: { in: pending.map(t => t.id) } },
      data: { status: 'FAILED' },
    })
  }
}
