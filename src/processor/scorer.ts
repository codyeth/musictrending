import OpenAI from 'openai'
import prisma from '../db.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

const client = new OpenAI({
  baseURL: config.openrouter.apiBase,
  apiKey: config.openrouter.apiKey,
})

const SYSTEM_PROMPT = `Bạn là chuyên gia phân tích trend nhạc cho team sản xuất nhạc instrumental/funk.
Nhiệm vụ: Chấm điểm mỗi trend theo 6 tiêu chí sau (điểm tối đa ghi trong ngoặc):

1. leadTime (25đ): Bài mới ra/trend mới nổi được nhiều điểm. Đã cũ trên 30 ngày = 0đ.
2. revenuePotential (25đ): CPM thị trường - US/JP = cao nhất, KR/BR = trung bình, ID = thấp hơn.
3. velocity (20đ): Tốc độ tăng views/rank/mentions trong 7 ngày gần nhất.
4. crossPlatform (15đ): Có dấu hiệu viral chéo nhiều nền tảng không.
5. feasibility (10đ): Team instrumental/funk có làm lại được style này không.
6. saturation (5đ): Ít bài tương tự trên thị trường = điểm cao. Đã bão hòa = thấp.

Khi được hỏi nhiều trend, trả về mảng JSON, không có text nào khác:
[{ "index": 1, "scores": { "leadTime": <số>, "revenuePotential": <số>, "velocity": <số>, "crossPlatform": <số>, "feasibility": <số>, "saturation": <số> }, "totalScore": <tổng>, "vibe": "<nhận xét>", "aiSuggest": "<gợi ý>" }]`

interface ScoreResult {
  scores: Record<string, number>
  totalScore: number
  vibe: string
  aiSuggest: string
}

async function scoreBatch(trends: Array<{ id: number; title: string; artist: string; source: string; market: string | null; rawData: string | null }>) {
  const input = trends.map((t, i) =>
    `${i + 1}. "${t.title}" by ${t.artist} | Source: ${t.source} | Market: ${t.market ?? 'Unknown'} | Data: ${t.rawData ?? '{}'}`
  ).join('\n')

  const res = await client.chat.completions.create({
    model: config.openrouter.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Chấm điểm ${trends.length} trend sau:\n\n${input}\n\nTrả về mảng JSON: [{ "index": 1, "scores": {...}, "totalScore": ..., "vibe": "...", "aiSuggest": "..." }, ...]` }
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

function getUrgency(score: number): string | null {
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

  const pending = await prisma.trend.findMany({
    where: { status: 'PENDING' },
    take: 5,
    orderBy: { createdAt: 'asc' },
  })

  if (pending.length === 0) return

  logger.info('scorer', `Scoring batch of ${pending.length} trends...`)

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

      const urgency = getUrgency(totalScore)

      await prisma.trend.update({
        where: { id: trend.id },
        data: {
          status: 'COMPLETED',
          totalScore,
          urgency,
          vibe: result.vibe,
          aiSuggest: result.aiSuggest,
          scores: JSON.stringify(result.scores),
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
