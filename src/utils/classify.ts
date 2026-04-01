// IDEA markets: JP and RU are niche/copyright-heavy — good for direction only
const IDEA_MARKETS = ['JP', 'RU']

// IDEA sources: behavioural/search signals, not specific songs
const IDEA_SOURCES = ['GOOGLE_TRENDS', 'REDDIT']

export function classifyTrend(source: string, market: string | null | undefined): 'REMIX' | 'IDEA' {
  if (IDEA_SOURCES.includes(source)) return 'IDEA'
  if (market && IDEA_MARKETS.includes(market.toUpperCase())) return 'IDEA'
  return 'REMIX'
}
