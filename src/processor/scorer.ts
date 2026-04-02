import OpenAI from 'openai'
import prisma from '../db.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

// ─── Key pool with rotation ───────────────────────────────────────
// Merges OPENROUTER_API_KEY (single) and OPENROUTER_API_KEYS (comma list)
// Rotates to next key on 402 (out of credits) or 429 (rate limit)

const keyPool: string[] = [
  ...( config.openrouter.apiKey ? [config.openrouter.apiKey] : []),
  ...config.openrouter.apiKeys,
].filter((k, i, arr) => k && arr.indexOf(k) === i)  // deduplicate

let currentKeyIndex = 0

function currentKey(): string {
  return keyPool[currentKeyIndex] ?? ''
}

function rotateKey(): boolean {
  if (keyPool.length <= 1) return false
  currentKeyIndex = (currentKeyIndex + 1) % keyPool.length
  logger.warn('scorer', `Rotated to API key #${currentKeyIndex + 1}/${keyPool.length}`)
  return true
}

function makeClient(apiKey: string): OpenAI {
  return new OpenAI({ baseURL: config.openrouter.apiBase, apiKey })
}

const SYSTEM_PROMPT_REMIX = `Bạn là chuyên gia phân tích trend nhạc cho team sản xuất nhạc instrumental/funk/phonk.
Các trend dưới đây là loại REMIX — bài nhạc cụ thể đang viral, team có thể remake/cover ngay.

Tham chiếu thực tế (các bài đã proven để so sánh):
- GOZALO (Ultra Slowed) — Ariis: 49M views, 654K likes, ra Nov 2025, like rate 1.32% → đã peak
- Cry For Me WA WA WA — Ironmouse: 34M views, 556K likes, ra Jan 2026, like rate 1.64% → còn hot
- MONTAGEM ALQUIMIA (SLOWED) — h6itam: 13M views, 218K likes, ra Jan 2026, like rate 1.62%
- BAD ENDING FUNK — Shimuda: 5.8M views, 118K likes, ra Feb 2026, like rate 2.02%, ~165K views/ngày → sweet spot tốt nhất
- MONTAGEM UNKNOWN — AKXNESHIVA: 5.7M views, 124K likes, ra Jan 2026, like rate 2.15%
- MONTAGEM LALALA — Mishashi Sensei: 1.8M views, 32K likes, ra Dec 2025

Chấm điểm theo 6 tiêu chí:

1. leadTime (25đ): Thời điểm vàng để làm cover:
   - Ra trong 30 ngày = 25đ (window tốt nhất — bài đang tăng, chưa bão hòa)
   - Ra 31-60 ngày = 15đ (còn kịp nếu bài vẫn tăng)
   - Ra 61-90 ngày = 8đ (muộn nhưng nếu views vẫn >50K/ngày thì làm được)
   - Ra trên 90 ngày = 2đ và tổng điểm tối đa chỉ 25/100

2. revenuePotential (25đ): CPM YouTube theo thị trường:
   - US/BR = CPM cao ($3-8) = 20-25đ
   - KR/JP = CPM khá ($2-5) = 15-20đ
   - ID = CPM thấp ($0.5-2) = 8-12đ
   - Nếu bài lan đa thị trường = cộng thêm 3đ

3. velocity (20đ): Tốc độ tăng trưởng thực tế:
   - Dùng "velocityData" trong rawData nếu có (dailyViews, velocityScore, engagementScore)
   - dailyViews > 200K = 20đ | 100K-200K = 16đ | 50K-100K = 12đ | 10K-50K = 7đ | <10K = 3đ
   - Like rate > 2% = bonus 3đ | 1.5-2% = bonus 1đ
   - velocityScore > 120 = tăng tốc mạnh, cộng thêm 2đ
   - Nếu không có data số, ước tính theo rank và nguồn

4. crossPlatform (15đ): Dùng "crossPlatformSources" trong rawData — data THẬT từ hệ thống:
   - 3+ nguồn = 15đ | 2 nguồn = 10đ | 1 nguồn = 5đ
   - "secondWaveSignal": true = bonus 3đ (đang từ Asia lan sang West)

5. feasibility (10đ): Team instrumental/funk có remake được không:
   - Phonk/funk/slowed+reverb/montagem = rất phù hợp = 8-10đ
   - Melody rõ ràng, loop ngắn, dễ chơi lại = cao
   - Cần vocal phức tạp hoặc live band lớn = thấp

6. saturation (5đ): Thị trường cover còn trống không:
   - Dưới 10 bài cover instrumental trên YouTube = 5đ
   - 10-50 bài = 3đ | Trên 50 bài = 1đ

Thông tin bổ sung cần trả về:
- bpm: ước tính range BPM (ví dụ: "130-140 BPM")
- style: nhạc cụ chủ đạo, vibe, aesthetic (tiếng Việt, ví dụ: "phonk tối, bass nặng, hi-hat stutter")
- refTracks: 2-3 bài tương tự đã thành công để tham khảo (title, artist, viewCount ước tính, source "youtube", searchQuery)
- saturation: ước tính số bài cover instrumental theo market
- cpm: CPM YouTube ước tính theo market ($/1000 views)
- marketProgression: thứ tự thị trường bài đang lan (dùng "seenInMarkets" nếu có, ví dụ: "BR → US → ID")
- leadTimeWeeks: số tuần còn lại để làm kịp trước khi bão hòa (0 = đã quá muộn)
- releaseYear: năm phát hành thực tế
- tags: 3-5 tag ngắn mô tả thể loại/vibe

QUAN TRỌNG: Tất cả text (vibe, aiSuggest, style) phải bằng TIẾNG VIỆT. aiSuggest phải cụ thể: gợi ý nhạc cụ, tempo, vibe để team làm cover hiệu quả nhất.

Trả về mảng JSON, không có text khác:
[{ "index": 1, "scores": {"leadTime":0,"revenuePotential":0,"velocity":0,"crossPlatform":0,"feasibility":0,"saturation":0}, "totalScore": <tổng>, "vibe": "...", "aiSuggest": "...", "bpm": "...", "style": "...", "refTracks": [...], "saturation": {...}, "cpm": {...}, "marketProgression": "...", "leadTimeWeeks": <số>, "releaseYear": <năm>, "tags": [...] }]`

const SYSTEM_PROMPT_IDEA = `Bạn là chuyên gia phân tích trend nhạc cho team sản xuất nhạc instrumental/funk/phonk.
Các trend dưới đây là loại IDEA — tín hiệu hành vi người dùng, hướng làm nhạc, không nhất thiết là bài cụ thể.

Tham chiếu thực tế: team chuyên làm phonk/funk/slowed instrumental. Các hướng đang hot: montagem Brazilian phonk, slowed+reverb, lo-fi funk, dark phonk.

Chấm điểm theo 6 tiêu chí:

1. leadTime (25đ): Trend còn đang lên hay đã qua đỉnh:
   - Bùng nổ trong 30 ngày gần đây = 25đ
   - Đang nổi 31-60 ngày = 15đ
   - Trending 61-90 ngày = 8đ
   - Đã qua 90 ngày = 2đ và tổng điểm tối đa 25/100

2. revenuePotential (25đ): CPM thị trường nếu làm theo hướng này:
   - US/BR = 20-25đ | KR/JP = 15-20đ | ID = 8-12đ | Đa thị trường = bonus 3đ

3. velocity (20đ): Dùng "velocityData" nếu có. Ước tính mức độ lan truyền theo engagement/traffic data.
   - Tăng trưởng rất nhanh (viral) = 18-20đ | Tăng đều = 10-14đ | Chậm = 3-7đ

4. crossPlatform (15đ): Dùng "crossPlatformSources" — data THẬT:
   - 3+ nguồn = 15đ | 2 nguồn = 10đ | 1 nguồn = 5đ | secondWaveSignal = bonus 3đ

5. feasibility (10đ): Team instrumental/funk có khai thác được không:
   - Hướng phonk/funk/lofi = rất phù hợp = 8-10đ
   - Cần kỹ thuật đặc thù hoặc vocal = thấp hơn

6. saturation (5đ): Thị trường nhạc theo hướng này còn chỗ trống không.

Thông tin bổ sung cần trả về:
- bpm: ước tính range BPM phù hợp với hướng này
- style: mô tả hướng làm (tiếng Việt) — vibe, instrument, audience
- refTracks: 2-3 bài nhạc gần nhất theo hướng này để tham khảo
- saturation: mức độ bão hòa theo market
- cpm: CPM YouTube theo market tiềm năng
- marketProgression: hướng này đang lan từ đâu sang đâu (dùng "seenInMarkets" nếu có)
- leadTimeWeeks: còn bao nhiêu tuần để khai thác
- releaseYear: năm xuất hiện/bùng nổ của trend này (ước tính)
- tags: 3-5 tag mô tả hướng

QUAN TRỌNG: Tất cả text (vibe, aiSuggest, style) phải bằng TIẾNG VIỆT. aiSuggest phải rõ ràng đây là gợi ý hướng làm, không phải bài cụ thể.

Trả về mảng JSON, không có text khác:
[{ "index": 1, "scores": {...}, "totalScore": <tổng>, "vibe": "...", "aiSuggest": "...", "bpm": "...", "style": "...", "refTracks": [...], "saturation": {...}, "cpm": {...}, "marketProgression": "...", "leadTimeWeeks": <số>, "releaseYear": <năm>, "tags": [...] }]`

// Sanitize AI-generated text: strip Markdown that could inject links/formatting
// Telegram Markdown v1 is vulnerable to [text](url) and backtick injection
function sanitizeAiText(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text
    .slice(0, 500)                          // hard length cap
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // strip [text](url) links
    .replace(/`{1,3}/g, "'")                // replace backticks
    .replace(/[<>]/g, '')                   // strip HTML-like tags
    .trim()
}

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
  releaseYear?: number
  tags?: string[]
}

// ─── Cross-platform enrichment ────────────────────────────────────
// Enriches rawData with real cross-platform signals BEFORE sending to AI
// This replaces AI guessing for crossPlatform (15pt) and velocity (20pt) criteria

type TrendItem = { id: number; title: string; artist: string; source: string; market: string | null; rawData: string | null; type: string }

async function enrichWithRealSignals(trends: TrendItem[]): Promise<void> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  for (const trend of trends) {
    try {
      // Use first two significant words (min 4 chars each) for a tighter match
      // Avoids false positives from common words like "love", "new", "the"
      const STOP_WORDS = new Set(['the','and','for','you','that','this','with','from','feat','official','video','lyrics','audio','ver'])
      const titleWords = trend.title.toLowerCase()
        .split(/[\s\-–—()\[\]]+/)
        .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
      if (titleWords.length < 1) continue
      // Require both words to match if we have 2+ words (AND logic = fewer false positives)
      const keyWord = titleWords[0]!
      const keyWord2 = titleWords[1]

      // Find same/similar title across other sources in last 7 days
      const matches = await prisma.trend.findMany({
        where: {
          id: { not: trend.id },
          title: { contains: keyWord },
          createdAt: { gte: sevenDaysAgo },
        },
        select: { source: true, market: true, title: true },
      })

      // If we have a second keyword, filter matches that also contain it
      const filteredMatches = keyWord2
        ? matches.filter(m => m.title.toLowerCase().includes(keyWord2))
        : matches

      const crossPlatformSources = [...new Set(filteredMatches.map(m => m.source))]
      const seenInMarkets = [...new Set(filteredMatches.map(m => m.market).filter(Boolean) as string[])]

      // Second wave: trend already hot in JP/KR but not yet in US/BR
      const inEastAsia = seenInMarkets.some(m => ['JP', 'KR'].includes(m))
      const inWest = seenInMarkets.some(m => ['US', 'BR'].includes(m))
      const secondWaveSignal = inEastAsia && !inWest && trend.market !== 'US' && trend.market !== 'BR'

      const raw = JSON.parse(trend.rawData ?? '{}')

      // Preserve velocity data from kworb/soundcloud in a consistent field
      const velocityData = {
        dailyViews: raw.dailyViews ?? null,
        weeklyViews: raw.weeklyViews ?? null,
        velocityScore: raw.velocityScore ?? null,  // >100 = accelerating
        plays: raw.plays ?? null,
        engagementScore: raw.engagementScore ?? null,
        rank: raw.rank ?? null,
      }

      const enriched = {
        ...raw,
        crossPlatformSources,
        seenInMarkets,
        secondWaveSignal,
        velocityData,
      }

      // Mutate in-memory only — the scorer write below will persist the enriched rawData
      // This avoids a race condition if two scorer runs overlap
      trend.rawData = JSON.stringify(enriched)
    } catch {
      // Non-fatal — scoring proceeds without enrichment
    }
  }
}

async function scoreBatch(trends: TrendItem[]) {
  const batchType = trends[0]?.type === 'IDEA' ? 'IDEA' : 'REMIX'
  const systemPrompt = batchType === 'IDEA' ? SYSTEM_PROMPT_IDEA : SYSTEM_PROMPT_REMIX

  const input = trends.map((t, i) =>
    `${i + 1}. "${t.title}" by ${t.artist} | Nguồn: ${t.source} | Thị trường: ${t.market ?? 'Unknown'} | Data: ${t.rawData ?? '{}'}`
  ).join('\n')

  // Retry loop: try each key in pool on 402/429, with backoff for rate limits
  const maxAttempts = Math.max(keyPool.length, 1) + 1  // +1 for rate limit backoff retry
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const client = makeClient(currentKey())
      // Some free models (Gemma, Phi) reject the system role entirely.
      // Merging system + user into a single user message is universally compatible.
      const userContent = `${systemPrompt}\n\n---\nChấm điểm ${trends.length} trend loại ${batchType} sau:\n\n${input}\n\nTrả về mảng JSON đầy đủ.`
      const res = await client.chat.completions.create({
        model: config.openrouter.model,
        messages: [{ role: 'user', content: userContent }],
        temperature: 0.3,
      })

      const text = res.choices[0]?.message?.content ?? '[]'
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      try {
        return JSON.parse(cleaned) as Array<{ index: number } & ScoreResult>
      } catch {
        logger.error('scorer', `JSON parse failed. Raw response: ${cleaned.slice(0, 500)}`)
        throw new Error('AI returned invalid JSON')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isQuota = msg.includes('402') || msg.includes('credits')
      const isRateLimit = msg.includes('429')

      if (isQuota && rotateKey()) {
        logger.warn('scorer', `Credits exhausted, retrying with next key...`)
        continue
      }
      if (isRateLimit) {
        if (rotateKey()) {
          logger.warn('scorer', `Rate limited, switching to next key...`)
          continue
        }
        // No other keys — wait 30s and retry (free model rate limit window)
        logger.warn('scorer', `Rate limited (no other keys), waiting 30s...`)
        await new Promise(r => setTimeout(r, 30000))
        continue
      }
      throw err
    }
  }

  throw new Error('All API keys exhausted')
}

function getUrgency(score: number, createdAt: Date, rawData?: string | null): string | null {
  // Hard filter: crawl date older than 6 months
  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
  if (createdAt < sixMonthsAgo) return null

  // Check release date: skip if song/trend is older than 1 month
  const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
  const currentYear = new Date().getFullYear()

  if (rawData) {
    try {
      const raw = JSON.parse(rawData)
      // Check exact release date (Spotify)
      if (raw.releaseDate) {
        const released = new Date(raw.releaseDate)
        if (released < oneMonthAgo) return null
      }
      // Check AI-estimated release year — block anything before this year
      if (raw.releaseYear && typeof raw.releaseYear === 'number') {
        if (raw.releaseYear < currentYear) return null
      }
    } catch {}
  }

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

  // Enrich with real cross-platform signals before AI scoring
  await enrichWithRealSignals(pending)

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

      const mergedRaw = JSON.stringify({
        ...JSON.parse(trend.rawData ?? '{}'),
        bpm: result.bpm,
        style: result.style,
        refTracks: result.refTracks,
        saturationByMarket: result.saturation,
        cpm: result.cpm,
        marketProgression: result.marketProgression,
        leadTimeWeeks: result.leadTimeWeeks,
        releaseYear: result.releaseYear,
        tags: result.tags,
      })

      const urgency = getUrgency(totalScore, trend.createdAt, mergedRaw)

      await prisma.trend.update({
        where: { id: trend.id },
        data: {
          status: 'COMPLETED',
          totalScore,
          urgency,
          vibe: sanitizeAiText(result.vibe),
          aiSuggest: sanitizeAiText(result.aiSuggest),
          scores: JSON.stringify(result.scores),
          rawData: mergedRaw,
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
