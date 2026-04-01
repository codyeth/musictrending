import 'dotenv/config'

function required(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

function optional(key: string, fallback = ''): string {
  return process.env[key] ?? fallback
}

export const config = {
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    adminIds: optional('ADMIN_USER_IDS').split(',').map(s => parseInt(s.trim())).filter(Boolean),
  },
  openrouter: {
    apiKey: optional('OPENROUTER_API_KEY'),
    apiBase: optional('OPENROUTER_API_BASE', 'https://openrouter.ai/api/v1'),
    model: optional('OPENROUTER_MODEL', 'deepseek/deepseek-chat'),
  },
  reddit: {
    clientId: optional('REDDIT_CLIENT_ID'),
    clientSecret: optional('REDDIT_CLIENT_SECRET'),
    userAgent: optional('REDDIT_USER_AGENT', 'music-tool/1.0'),
  },
  spotify: {
    clientId: optional('SPOTIFY_CLIENT_ID'),
    clientSecret: optional('SPOTIFY_CLIENT_SECRET'),
  },
  scoring: {
    alertThreshold: parseInt(optional('ALERT_SCORE_THRESHOLD', '70')),
    rushThreshold: parseInt(optional('RUSH_THRESHOLD', '80')),
    watchThreshold: parseInt(optional('WATCH_THRESHOLD', '60')),
  },
  dashboard: {
    port: parseInt(optional('DASHBOARD_PORT', '3000')),
  },
  // Feature flags
  hasOpenRouter: !!optional('OPENROUTER_API_KEY'),
  hasReddit: !!(optional('REDDIT_CLIENT_ID') && optional('REDDIT_CLIENT_SECRET')),
  hasSpotify: !!(optional('SPOTIFY_CLIENT_ID') && optional('SPOTIFY_CLIENT_SECRET')),
}
