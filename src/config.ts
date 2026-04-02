import 'dotenv/config'

function required(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

function optional(key: string, fallback = ''): string {
  return process.env[key] ?? fallback
}

function optionalInt(key: string, fallback: number): number {
  const val = parseInt(process.env[key] ?? '')
  return isNaN(val) ? fallback : val
}

export const config = {
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    adminIds: optional('ADMIN_USER_IDS').split(',').map(s => parseInt(s.trim())).filter(Boolean),
  },
  openrouter: {
    // Primary key (legacy single-key support)
    apiKey: optional('OPENROUTER_API_KEY'),
    // Multiple keys: OPENROUTER_API_KEYS=key1,key2,key3 — rotated on 402/429
    apiKeys: optional('OPENROUTER_API_KEYS')
      .split(',')
      .map(k => k.trim())
      .filter(Boolean),
    apiBase: optional('OPENROUTER_API_BASE', 'https://openrouter.ai/api/v1'),
    // Default: free model — no credits needed, 20 req/min rate limit
    model: optional('OPENROUTER_MODEL', 'google/gemini-2.0-flash-exp:free'),
  },
  youtube: {
    apiKey: optional('YOUTUBE_API_KEY'),
  },
  reddit: {
    clientId: optional('REDDIT_CLIENT_ID'),
    clientSecret: optional('REDDIT_CLIENT_SECRET'),
    userAgent: optional('REDDIT_USER_AGENT', 'music-tool/1.0'),
  },
  scoring: {
    alertThreshold: optionalInt('ALERT_SCORE_THRESHOLD', 70),
    rushThreshold: optionalInt('RUSH_THRESHOLD', 80),
    watchThreshold: optionalInt('WATCH_THRESHOLD', 60),
  },
  dashboard: {
    port: optionalInt('DASHBOARD_PORT', 3000),
    token: optional('DASHBOARD_TOKEN'),  // optional; if set, API requires X-Dashboard-Token header
  },
  // Feature flags
  hasOpenRouter: !!(optional('OPENROUTER_API_KEY') || optional('OPENROUTER_API_KEYS')),
  hasReddit: !!(optional('REDDIT_CLIENT_ID') && optional('REDDIT_CLIENT_SECRET')),
  hasYoutube: !!optional('YOUTUBE_API_KEY'),
}

export type Config = typeof config
