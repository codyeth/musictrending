import TelegramBot from 'node-telegram-bot-api'
import prisma from '../db.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'
import { loadChannels, removeChannel, addChannel, addSourceFromUrl, detectPlatform, platformIcon, platformLabel } from '../crawlers/youtube-channels.js'
import { crawlAll } from '../crawlers/all.js'
import { classifyTrend } from '../utils/classify.js'
import { lookupReleaseDate, isRecent, parseReleaseDate } from '../utils/spotify-lookup.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// ─── User storage (JSON file) ─────────────────────────────────────

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const USERS_FILE = path.join(PROJECT_ROOT, 'data', 'users.json')

interface UsersData {
  members: number[]
  viewers: number[]
}

function loadUsers(): UsersData {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'))
    }
  } catch (err) {
    logger.warn('bot', `Failed to load users file: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { members: [], viewers: [] }
}

function saveUsers(data: UsersData): void {
  const dir = path.dirname(USERS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2))
}

// ─── Roles ────────────────────────────────────────────────────────

type Role = 'admin' | 'member' | 'viewer'

function getRole(userId: number): Role | null {
  if (config.telegram.adminIds.includes(userId)) return 'admin'
  const users = loadUsers()
  if (users.members.includes(userId)) return 'member'
  if (users.viewers.includes(userId)) return 'viewer'
  return null
}

function canDecide(role: Role): boolean {
  return role === 'admin' || role === 'member'
}

// ─── User mode (waiting for text input) ──────────────────────────

const userModes = new Map<number, string>()
const userModeTimestamps = new Map<number, number>()
const USER_MODE_TTL_MS = 10 * 60 * 1000 // 10 minutes

function setMode(userId: number, mode: string) {
  userModes.set(userId, mode)
  userModeTimestamps.set(userId, Date.now())
}

function getMode(userId: number): string | undefined {
  const ts = userModeTimestamps.get(userId)
  if (ts && Date.now() - ts > USER_MODE_TTL_MS) {
    clearMode(userId)
    userModeTimestamps.delete(userId)
    return undefined
  }
  return userModes.get(userId)
}

function clearMode(userId: number) {
  userModes.delete(userId)
  userModeTimestamps.delete(userId)
}

// ─── Keyboards ───────────────────────────────────────────────────

type IKB = TelegramBot.InlineKeyboardMarkup

function kbMain(role: Role): IKB {
  const row: TelegramBot.InlineKeyboardButton[] = [
    { text: '📊 Trends', callback_data: 'menu_trends' },
  ]
  if (role === 'admin') {
    row.push({ text: '⚙️ Quản lý', callback_data: 'menu_manage' })
  }
  row.push({ text: '❓ Help', callback_data: 'cmd_help' })
  return { inline_keyboard: [row] }
}

function kbTrends(role: Role): IKB {
  const rows: TelegramBot.InlineKeyboardButton[][] = [
    [{ text: '🔥 Top Trends', callback_data: 'cmd_top' }],
  ]
  if (canDecide(role)) {
    rows.push([{ text: '➕ Thêm nguồn', callback_data: 'cmd_add_source' }])
    rows.push([
      { text: '➕ Thêm Trend', callback_data: 'cmd_add' },
      { text: '🔄 Crawl Ngay', callback_data: 'cmd_crawl' },
    ])
  }
  rows.push([{ text: '🔙 Quay lại', callback_data: 'menu_main' }])
  return { inline_keyboard: rows }
}

function kbManage(): IKB {
  return {
    inline_keyboard: [
      [
        { text: '📈 Thống kê', callback_data: 'cmd_status' },
        { text: '📤 Export CSV', callback_data: 'cmd_export' },
      ],
      [{ text: '📺 Kênh YouTube đang theo dõi', callback_data: 'menu_channels' }],
      [{ text: '📋 Logs', callback_data: 'cmd_logs' }],
      [{ text: '🔙 Quay lại', callback_data: 'menu_main' }],
    ],
  }
}

function kbBack(to: string): IKB {
  return { inline_keyboard: [[{ text: '🔙 Quay lại', callback_data: to }]] }
}

function kbDecision(trendId: number): IKB {
  return {
    inline_keyboard: [[
      { text: '✅ Duyệt', callback_data: `cmd_approve_${trendId}` },
      { text: '⏳ Theo dõi', callback_data: `cmd_watch_${trendId}` },
      { text: '❌ Bỏ qua', callback_data: `cmd_reject_${trendId}` },
    ]],
  }
}

// ─── Text helpers ─────────────────────────────────────────────────

function txtMainMenu(role: Role): string {
  const label = role === 'admin' ? '👑 Admin' : role === 'member' ? '👤 Member' : '👁 Viewer'
  return `🎵 *Music Trend Tool*\n${label} — Chọn nhóm tính năng:`
}

function txtHelp(): string {
  return `❓ *Hướng dẫn nhanh*
━━━━━━━━━━━━━━━
🔔 *Alerts tự động*
Bot tự tìm trend mới mỗi ngày và gửi thông báo khi điểm AI ≥ ${config.scoring.alertThreshold}/100.
Mỗi alert có nút *DUYỆT / THEO DÕI / BỎ QUA* để team ra quyết định.

🔥 *Top Trends* — \`/top\`
Xem top 5 trend điểm cao nhất chưa duyệt.

🔄 *Crawl Ngay* — \`/crawl\`
Kéo data mới ngay lập tức từ tất cả nguồn.
Bot báo lại danh sách bài/trend mới tìm được.

➕ *Thêm nguồn* — \`/add_source\`
Gửi link YouTube/NicoNico → AI phân tích phong cách, gợi ý trend tương tự.
Kênh YouTube sẽ tự động được thêm vào danh sách theo dõi để crawl định kỳ.

📋 *Nguồn đang theo dõi* — \`/sources\`
Xem và quản lý danh sách kênh YouTube đang theo dõi.

➕ *Thêm thủ công* — \`/add\`
Tự thêm bài vào hệ thống. Nhập theo dạng: \`Tên bài - Artist\`

📤 *Export CSV* — \`/export\`
Xuất danh sách bài đã *DUYỆT* ra file CSV.
━━━━━━━━━━━━━━━
📡 *Nguồn dữ liệu*
TikTok · YouTube · SoundCloud · Reddit · Google Trends
_Crawl tự động: 07:00 · 13:00 · 20:00 hàng ngày_`
}

function urgencyEmoji(urgency: string | null): string {
  if (urgency === 'RUSH') return '🔴'
  if (urgency === 'WATCH') return '🟠'
  return '🟡'
}

function safeJSON(str: string | null): Record<string, unknown> {
  if (!str) return {}
  try { return JSON.parse(str) } catch { return {} }
}

function formatTrend(trend: {
  title: string; artist: string; source: string; market: string | null
  totalScore: number; urgency: string | null; vibe: string | null
  aiSuggest: string | null; scores: string | null; rawData: string | null
  url?: string | null; type?: string
}): string {
  const emoji = urgencyEmoji(trend.urgency)
  const label = trend.urgency ?? 'NEW'
  const raw = safeJSON(trend.rawData)

  const lines = [
    `${emoji} *${label}* — Score: *${trend.totalScore}/100*`,
    `━━━━━━━━━━━━━━━`,
    `🎵 \`${trend.title}\` — ${trend.artist}`,
    `📡 ${trend.source} | ${trend.market ?? 'N/A'}`,
  ]

  if (raw.bpm || raw.style) {
    lines.push(`🎼 ${[raw.bpm, raw.style].filter(Boolean).join(' · ')}`)
  }
  if (raw.marketProgression) {
    lines.push(`🌏 ${raw.marketProgression}`)
  }
  if (raw.leadTimeWeeks !== undefined) {
    lines.push(`⏱ Lead time: ${raw.leadTimeWeeks} tuần`)
  }

  const typeLabel = trend.type === 'IDEA' ? '💡 IDEA — Gợi ý hướng sáng tác' : '🎵 REMIX — Có thể làm lại bài này'
  lines.push(`🏷 Đề xuất: *${typeLabel}*`)

  lines.push(``)
  lines.push(`💬 _${trend.vibe ?? 'Đang phân tích...'}_`)
  if (trend.aiSuggest) lines.push(`💡 ${trend.aiSuggest}`)

  // Navigation links
  const raw2 = safeJSON(trend.rawData)
  const links: string[] = []
  if (trend.url) {
    links.push(`[🔗 Nguồn gốc](${trend.url})`)
  }
  const videoId = raw2.videoId as string | undefined
  if (videoId) {
    links.push(`[▶️ YouTube](https://www.youtube.com/watch?v=${videoId})`)
  }
  if (!trend.url && !videoId) {
    // Use title only — cleaner keyword for copying and searching
    const q = encodeURIComponent(trend.title)
    const searchUrl = `https://www.youtube.com/results?search_query=${q}`
    links.push(`[🔍 Tìm kiếm](${searchUrl})`)
  }
  if (links.length > 0) {
    lines.push(``)
    lines.push(links.join('  ·  '))
  }

  return lines.join('\n')
}

// ─── Crawl result helper ──────────────────────────────────────────

const SUGGEST_SOURCES = [
  'TikTok Trending (cần setup)',
  'YouTube Music Charts',
  'SoundCloud Trending',
  'Beatport Top 100',
]

async function sendCrawlResult(chatId: number, newTrends: { id: number; title: string; artist: string; source: string; market: string | null; type: string }[]): Promise<void> {
  if (newTrends.length === 0) {
    const suggest = SUGGEST_SOURCES[Math.floor(Math.random() * SUGGEST_SOURCES.length)]
    await bot.sendMessage(
      chatId,
      `✅ *Crawl xong — không có bài/trend mới*\n\nTất cả nguồn đã được cập nhật rồi.\n💡 Muốn tìm thêm? Gợi ý: thêm nguồn *${suggest}* vào hệ thống.`,
      { parse_mode: 'Markdown' }
    )
    return
  }

  const lines = [`✅ *Crawl xong — ${newTrends.length} bài/trend mới:*\n`]
  for (const t of newTrends.slice(0, 15)) {
    const typeIcon = t.type === 'IDEA' ? '💡' : '🎵'
    lines.push(`${typeIcon} *${t.title}* — ${t.artist}\n   📡 ${t.source} | ${t.market ?? 'N/A'}`)
  }
  if (newTrends.length > 15) {
    lines.push(`\n_...và ${newTrends.length - 15} bài khác. Xem đầy đủ trên dashboard._`)
  }
  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' })
}

// ─── Sources menu helpers ─────────────────────────────────────────

type MsgOpts = { parse_mode?: TelegramBot.ParseMode; reply_markup?: TelegramBot.InlineKeyboardMarkup }
type MsgArgs = [string, MsgOpts]

function buildSourcesMenu(): MsgArgs {
  const all = loadChannels()
  if (all.length === 0) {
    return [
      `📋 *Nguồn đang theo dõi*\n\nChưa có nguồn nào.\nDùng /add\\_source để thêm.`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '➕ Thêm nguồn', callback_data: 'cmd_add_source' }]] },
      },
    ]
  }

  // Group by platform
  const byPlatform: Record<string, typeof all> = {}
  for (const s of all) {
    if (!byPlatform[s.platform]) byPlatform[s.platform] = []
    byPlatform[s.platform]!.push(s)
  }

  const platformButtons: TelegramBot.InlineKeyboardButton[][] = []
  const row: TelegramBot.InlineKeyboardButton[] = []
  for (const [platform, sources] of Object.entries(byPlatform)) {
    row.push({
      text: `${platformIcon(platform)} ${platformLabel(platform)} (${sources.length})`,
      callback_data: `cmd_sources_${platform}`,
    })
    if (row.length === 2) { platformButtons.push([...row]); row.length = 0 }
  }
  if (row.length > 0) platformButtons.push([...row])

  return [
    `📋 *Nguồn đang theo dõi* (${all.length})\n\nChọn nền tảng để xem chi tiết:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          ...platformButtons,
          [{ text: '➕ Thêm nguồn', callback_data: 'cmd_add_source' }],
        ],
      },
    },
  ]
}

function buildPlatformList(platform: string): MsgArgs {
  const sources = loadChannels().filter(s => s.platform === platform)
  const icon = platformIcon(platform)
  const label = platformLabel(platform)

  if (sources.length === 0) {
    return [
      `${icon} *${label}* — Chưa có nguồn nào.`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại', callback_data: 'cmd_sources' }]] },
      },
    ]
  }

  const rows: TelegramBot.InlineKeyboardButton[][] = sources.map(s => ([
    { text: `${icon} ${s.name} (${s.market})`, url: s.url },
    { text: '🗑', callback_data: `cmd_rmch_${s.id}` },
  ]))

  return [
    `${icon} *${label}* (${sources.length} nguồn)\n\nBấm tên để mở, bấm 🗑 để xóa:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          ...rows,
          [{ text: '🔙 Quay lại', callback_data: 'cmd_sources' }],
        ],
      },
    },
  ]
}

// ─── Bot instance ─────────────────────────────────────────────────

let bot: TelegramBot

export function initBot(): TelegramBot {
  bot = new TelegramBot(config.telegram.botToken, { polling: true })

  // Commands cho member/viewer
  bot.setMyCommands([
    { command: 'start', description: 'Mở menu chính' },
    { command: 'top', description: 'Xem top trends chưa duyệt' },
    { command: 'add_source', description: 'Thêm nguồn: phân tích link YouTube/NicoNico' },
    { command: 'sources', description: 'Xem & quản lý danh sách kênh theo dõi' },
    { command: 'add', description: 'Thêm trend thủ công' },
    { command: 'crawl', description: 'Crawl tất cả nguồn ngay' },
    { command: 'help', description: 'Hướng dẫn sử dụng' },
  ]).catch(() => {})

  // Commands bổ sung cho admin (hiển thị thêm)
  bot.setMyCommands([
    { command: 'start', description: 'Mở menu chính' },
    { command: 'top', description: 'Xem top trends chưa duyệt' },
    { command: 'add_source', description: 'Thêm nguồn: phân tích link YouTube/NicoNico' },
    { command: 'sources', description: 'Xem & quản lý danh sách kênh theo dõi' },
    { command: 'add', description: 'Thêm trend thủ công' },
    { command: 'crawl', description: 'Crawl tất cả nguồn ngay' },
    { command: 'status', description: 'Thống kê pipeline' },
    { command: 'export', description: 'Xuất CSV bài đã duyệt' },
    { command: 'adduser', description: 'Thêm user: /adduser <id> member|viewer' },
    { command: 'removeuser', description: 'Xóa user: /removeuser <id>' },
    { command: 'help', description: 'Hướng dẫn sử dụng' },
  ], { scope: { type: 'all_private_chats' } }).catch(() => {})

  registerCallbacks()
  registerCommands()
  registerMessageHandler()

  logger.info('bot', 'Telegram bot started')
  return bot
}

// ─── Access denied ────────────────────────────────────────────────

async function denyAccess(chatId: number, userId: number): Promise<void> {
  await bot.sendMessage(
    chatId,
    `⛔ Bạn chưa có quyền truy cập.\n\nUser ID của bạn: \`${userId}\`\n\nLiên hệ admin để được cấp quyền.`,
    { parse_mode: 'Markdown' }
  )
}

// ─── Callback handler ─────────────────────────────────────────────

// Rate-limit /crawl: track last crawl time per user
const lastCrawlTime = new Map<number, number>()
const CRAWL_COOLDOWN_MS = 3 * 60 * 1000 // 3 minutes

function registerCallbacks(): void {
  bot.on('callback_query', async (query) => {
    if (!query.data || !query.from || !query.message) return
    // Answer immediately so Telegram doesn't show loading spinner
    // Do NOT call answerCallbackQuery again inside individual handlers
    await bot.answerCallbackQuery(query.id).catch(() => {})

    const userId = query.from.id
    const chatId = query.message.chat.id
    const msgId = query.message.message_id
    const data = query.data
    const role = getRole(userId)

    if (!role) {
      await bot.sendMessage(chatId,
        `⛔ Bạn chưa có quyền.\nUser ID: \`${userId}\``,
        { parse_mode: 'Markdown' }
      )
      return
    }

    // ── Navigation ──────────────────────────────────────────────

    if (data === 'menu_main') {
      await bot.editMessageText(txtMainMenu(role), {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown', reply_markup: kbMain(role),
      })
      return
    }

    if (data === 'menu_trends') {
      await bot.editMessageText('📊 *Trends* — Chọn tính năng:', {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown', reply_markup: kbTrends(role),
      })
      return
    }

    if (data === 'menu_manage') {
      if (role !== 'admin') return
      await bot.editMessageText('⚙️ *Quản lý* — Chọn tính năng:', {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown', reply_markup: kbManage(),
      })
      return
    }

    // ── Channel list ─────────────────────────────────────────────

    if (data === 'menu_channels' || data === 'menu_channels_refresh') {
      if (role !== 'admin') return
      const channels = loadChannels()

      if (channels.length === 0) {
        await bot.editMessageText('Chưa có kênh nào. Dùng /add_source để thêm.', {
          chat_id: chatId, message_id: msgId,
          reply_markup: kbBack('menu_manage'),
        })
        return
      }

      // Group by market
      const byMarket: Record<string, typeof channels> = {}
      for (const ch of channels) {
        if (!byMarket[ch.market]) byMarket[ch.market] = []
        byMarket[ch.market]!.push(ch)
      }

      const lines = Object.entries(byMarket).map(([market, chs]) =>
        `*${market}* (${chs.length} kênh)\n` + chs.map(c => `  • ${c.name} — ${c.genre}`).join('\n')
      ).join('\n\n')

      const removeButtons = channels.map(ch => ([{
        text: `🗑 ${ch.name}`,
        callback_data: `cmd_removechannel_${ch.id}`,
      }]))

      await bot.editMessageText(
        `📺 *Kênh YouTube đang theo dõi* (${channels.length})\n\n${lines}\n\nNhấn để xóa:`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              ...removeButtons,
              [{ text: '🔙 Quay lại', callback_data: 'menu_manage' }],
            ],
          },
        }
      )
      return
    }

    if (data.startsWith('cmd_removechannel_')) {
      if (role !== 'admin') return
      const id = data.replace('cmd_removechannel_', '')
      const channels = loadChannels()
      const ch = channels.find(c => c.id === id)
      removeChannel(id)
      // Refresh channel list
      const remaining = loadChannels()
      if (remaining.length === 0) {
        await bot.editMessageText('Không còn kênh nào.', {
          chat_id: chatId, message_id: msgId,
          reply_markup: kbBack('menu_manage'),
        })
        return
      }
      // Re-render list
      const byMarket: Record<string, typeof remaining> = {}
      for (const c of remaining) {
        if (!byMarket[c.market]) byMarket[c.market] = []
        byMarket[c.market]!.push(c)
      }
      const lines = Object.entries(byMarket).map(([market, chs]) =>
        `*${market}* (${chs.length} kênh)\n` + chs.map(c => `  • ${c.name} — ${c.genre}`).join('\n')
      ).join('\n\n')
      const removeButtons = remaining.map(c => ([{
        text: `🗑 ${c.name}`,
        callback_data: `cmd_removechannel_${c.id}`,
      }]))
      await bot.editMessageText(
        `📺 *Kênh YouTube đang theo dõi* (${remaining.length})\n\n${lines}\n\nNhấn để xóa:`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              ...removeButtons,
              [{ text: '🔙 Quay lại', callback_data: 'menu_manage' }],
            ],
          },
        }
      )
      return
    }

    // ── Sources main menu ────────────────────────────────────────

    if (data === 'cmd_sources') {
      if (!canDecide(role)) return
      const [text, opts] = buildSourcesMenu()
      await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts })
      return
    }

    // ── Sources per platform ─────────────────────────────────────

    if (data.startsWith('cmd_sources_')) {
      if (!canDecide(role)) return
      const platform = data.replace('cmd_sources_', '')
      const [text, opts] = buildPlatformList(platform)
      await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts })
      return
    }

    // ── Help ─────────────────────────────────────────────────────

    if (data === 'cmd_help') {
      await bot.editMessageText(txtHelp(), {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown', reply_markup: kbBack('menu_main'),
      })
      return
    }

    // ── Top trends ───────────────────────────────────────────────

    if (data === 'cmd_top') {
      await bot.editMessageText('⏳ Đang tải top trends...', {
        chat_id: chatId, message_id: msgId,
      })

      const trends = await prisma.trend.findMany({
        where: { status: 'COMPLETED', decision: null },
        orderBy: { totalScore: 'desc' },
        take: 5,
      })

      if (trends.length === 0) {
        await bot.editMessageText('Không có trend nào đang chờ duyệt.', {
          chat_id: chatId, message_id: msgId,
          reply_markup: kbBack('menu_trends'),
        })
        return
      }

      await bot.editMessageText(`✅ *Top ${trends.length} trends chưa duyệt:*`, {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown', reply_markup: kbBack('menu_trends'),
      })

      for (const trend of trends) {
        const text = formatTrend(trend)
        const keyboard = canDecide(role) ? kbDecision(trend.id) : undefined
        if (trend.thumbnail) {
          await bot.sendPhoto(chatId, trend.thumbnail, {
            caption: text, parse_mode: 'Markdown', reply_markup: keyboard,
          })
        } else {
          await bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown', reply_markup: keyboard,
          })
        }
      }
      return
    }

    // ── Add source (set input mode) ─────────────────────────────

    if (data === 'cmd_add_source') {
      if (!canDecide(role)) return
      setMode(userId, 'add_source')
      await bot.editMessageText(
        `➕ *Thêm nguồn theo dõi*\n\nGửi link profile/channel để bot crawl định kỳ:\n• YouTube: \`youtube.com/@channel\`\n• TikTok: \`tiktok.com/@account\`\n• SoundCloud, Instagram, Twitter...\n\n_Gõ /cancel để hủy_`,
        {
          chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📋 Xem nguồn đang theo dõi', callback_data: 'cmd_sources' }],
              [{ text: '🔙 Quay lại', callback_data: 'menu_trends' }],
            ],
          },
        }
      )
      return
    }

    // ── Channel manage (legacy, redirect to new sources view) ────

    if (data === 'menu_channels_manage' || data === 'menu_channels_manage_refresh') {
      if (!canDecide(role)) return
      const [text, opts] = buildSourcesMenu()
      await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts })
      return
    }

    // ── Remove channel (inline) ───────────────────────────────────

    if (data.startsWith('cmd_rmch_')) {
      if (!canDecide(role)) return
      const id = data.replace('cmd_rmch_', '')
      const ch = loadChannels().find(c => c.id === id)
      const platform = ch?.platform ?? 'youtube'
      removeChannel(id)
      // Re-render the platform list
      const [text, opts] = buildPlatformList(platform)
      await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts })
      return
    }

    // ── Add trend (set input mode) ───────────────────────────────

    if (data === 'cmd_add') {
      if (!canDecide(role)) return
      setMode(userId, 'add_trend')
      await bot.editMessageText(
        `➕ *Thêm Trend Thủ Công*\n\nGửi tên bài theo định dạng:\n\`Tên bài - Tên artist\`\n\nVí dụ: \`APT. - ROSE\`\n\n_Gõ /cancel để hủy_`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
      )
      return
    }

    // ── Crawl now ────────────────────────────────────────────────

    if (data === 'cmd_crawl') {
      if (!canDecide(role)) return
      const lastCrawl = lastCrawlTime.get(userId) ?? 0
      const cooldownLeft = Math.ceil((CRAWL_COOLDOWN_MS - (Date.now() - lastCrawl)) / 1000)
      if (cooldownLeft > 0) {
        await bot.editMessageText(
          `⏳ Vui lòng chờ thêm *${cooldownLeft}s* trước khi crawl lại.`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
        )
        return
      }
      lastCrawlTime.set(userId, Date.now())
      await bot.editMessageText(
        `⏳ *Đang crawl tất cả nguồn...*\nTikTok · YouTube · SoundCloud · Reddit · Google Trends`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
      )
      const newTrends = await crawlAll(15)  // default 15 from button
      await sendCrawlResult(chatId, newTrends)
      return
    }

    // ── Pipeline status ──────────────────────────────────────────

    if (data === 'cmd_status') {
      if (role !== 'admin') return
      await bot.editMessageText('⏳ Đang tải...', { chat_id: chatId, message_id: msgId })

      const [pending, completed, approved, rush] = await Promise.all([
        prisma.trend.count({ where: { status: 'PENDING' } }),
        prisma.trend.count({ where: { status: 'COMPLETED' } }),
        prisma.decision.count({ where: { action: 'APPROVE' } }),
        prisma.trend.count({ where: { urgency: 'RUSH', status: 'COMPLETED', decision: null } }),
      ])

      await bot.editMessageText(
        `📈 *Pipeline Status*\n\nChờ score: ${pending}\nĐã score: ${completed}\nĐã duyệt: ${approved}\n🔴 RUSH chưa duyệt: ${rush}`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown', reply_markup: kbBack('menu_manage'),
        }
      )
      return
    }

    // ── Export CSV ───────────────────────────────────────────────

    if (data === 'cmd_export') {
      if (role !== 'admin') return
      await bot.editMessageText('⏳ Đang xuất CSV...', { chat_id: chatId, message_id: msgId })

      const approved = await prisma.decision.findMany({
        where: { action: 'APPROVE' },
        include: { trend: true },
        orderBy: { decidedAt: 'desc' },
      })

      if (approved.length === 0) {
        await bot.editMessageText('Chưa có bài nào được duyệt.', {
          chat_id: chatId, message_id: msgId, reply_markup: kbBack('menu_manage'),
        })
        return
      }

      await bot.editMessageText(`✅ Gửi file CSV (${approved.length} bài)...`, {
        chat_id: chatId, message_id: msgId, reply_markup: kbBack('menu_manage'),
      })

      const csv = [
        'Title,Artist,Source,Market,Score,BPM,Style,MarketProgression,LeadTimeWeeks,Vibe,AISuggest,DecidedAt',
        ...approved.map(d => {
          const raw = safeJSON(d.trend.rawData)
          return [
            d.trend.title, d.trend.artist, d.trend.source, d.trend.market ?? '',
            d.trend.totalScore, raw.bpm ?? '', raw.style ?? '',
            raw.marketProgression ?? '', raw.leadTimeWeeks ?? '',
            (d.trend.vibe ?? '').replace(/"/g, '""'),
            (d.trend.aiSuggest ?? '').replace(/"/g, '""'),
            d.decidedAt.toISOString(),
          ].map(v => `"${v}"`).join(',')
        }),
      ].join('\n')

      await bot.sendDocument(chatId, Buffer.from(csv), {}, {
        filename: `approved-trends-${new Date().toISOString().split('T')[0]}.csv`,
        contentType: 'text/csv',
      })
      return
    }

    // ── Logs ─────────────────────────────────────────────────────

    if (data === 'cmd_logs') {
      if (role !== 'admin') return
      await bot.editMessageText(
        `📋 *Logs*\n\nLogs ghi ra console/PM2.\n\nLệnh xem:\n\`pm2 logs music-tool --lines 50\``,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown', reply_markup: kbBack('menu_manage'),
        }
      )
      return
    }

    // ── Decision (approve / watch / reject) ──────────────────────

    const decisionMatch = data.match(/^cmd_(approve|watch|reject)_(\d+)$/)
    if (decisionMatch) {
      if (!canDecide(role)) return
      const actionKey = decisionMatch[1]!
      const trendId = parseInt(decisionMatch[2]!)
      const actionMap: Record<string, 'APPROVE' | 'WATCH' | 'REJECT'> = {
        approve: 'APPROVE', watch: 'WATCH', reject: 'REJECT',
      }
      const action = actionMap[actionKey]!
      const labels: Record<string, string> = {
        APPROVE: '✅ Đã duyệt', WATCH: '⏳ Theo dõi', REJECT: '❌ Đã bỏ qua',
      }

      try {
        await prisma.decision.upsert({
          where: { trendId },
          update: { action, decidedAt: new Date() },
          create: { trendId, action },
        })
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: labels[action]!, callback_data: 'noop' }]] },
          { chat_id: chatId, message_id: msgId }
        )
      } catch (err) {
        logger.error('bot', `Decision failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  })
}

// ─── Text commands ────────────────────────────────────────────────

function registerCommands(): void {
  bot.onText(/\/start/, async (msg) => {
    const userId = msg.from?.id ?? 0
    const role = getRole(userId)
    if (!role) { await denyAccess(msg.chat.id, userId); return }
    await bot.sendMessage(msg.chat.id, txtMainMenu(role), {
      parse_mode: 'Markdown', reply_markup: kbMain(role),
    })
  })

  bot.onText(/\/help/, async (msg) => {
    const userId = msg.from?.id ?? 0
    const role = getRole(userId)
    if (!role) { await denyAccess(msg.chat.id, userId); return }
    await bot.sendMessage(msg.chat.id, txtHelp(), {
      parse_mode: 'Markdown',
      reply_markup: kbBack('menu_main'),
    })
  })

  bot.onText(/\/top/, async (msg) => {
    const userId = msg.from?.id ?? 0
    const role = getRole(userId)
    if (!role) { await denyAccess(msg.chat.id, userId); return }

    const trends = await prisma.trend.findMany({
      where: { status: 'COMPLETED', decision: null },
      orderBy: { totalScore: 'desc' },
      take: 5,
    })
    if (trends.length === 0) {
      await bot.sendMessage(msg.chat.id, 'Không có trend nào đang chờ duyệt.')
      return
    }
    for (const trend of trends) {
      const text = formatTrend(trend)
      const keyboard = canDecide(role) ? kbDecision(trend.id) : undefined
      if (trend.thumbnail) {
        await bot.sendPhoto(msg.chat.id, trend.thumbnail, { caption: text, parse_mode: 'Markdown', reply_markup: keyboard })
      } else {
        await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', reply_markup: keyboard })
      }
    }
  })

  bot.onText(/\/add_source/, async (msg) => {
    const userId = msg.from?.id ?? 0
    const role = getRole(userId)
    if (!role) { await denyAccess(msg.chat.id, userId); return }
    if (!canDecide(role)) { await bot.sendMessage(msg.chat.id, '⛔ Bạn không có quyền dùng tính năng này.'); return }
    setMode(userId, 'add_source')
    await bot.sendMessage(msg.chat.id,
      `➕ *Thêm nguồn theo dõi*\n\nGửi link profile/channel để bot crawl định kỳ:\n• YouTube: \`youtube.com/@channel\`\n• TikTok: \`tiktok.com/@account\`\n• SoundCloud, Instagram, Twitter...\n\n_Gõ /cancel để hủy_`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.onText(/\/sources/, async (msg) => {
    const userId = msg.from?.id ?? 0
    const role = getRole(userId)
    if (!role) { await denyAccess(msg.chat.id, userId); return }
    if (!canDecide(role)) { await bot.sendMessage(msg.chat.id, '⛔ Bạn không có quyền dùng tính năng này.'); return }
    await bot.sendMessage(msg.chat.id, ...buildSourcesMenu())
  })

  bot.onText(/\/add(?!_source)/, async (msg) => {
    const userId = msg.from?.id ?? 0
    const role = getRole(userId)
    if (!role) { await denyAccess(msg.chat.id, userId); return }
    if (!canDecide(role)) { await bot.sendMessage(msg.chat.id, '⛔ Bạn không có quyền dùng tính năng này.'); return }
    setMode(userId, 'add_trend')
    await bot.sendMessage(msg.chat.id,
      `➕ *Thêm Trend Thủ Công*\n\nGửi tên bài theo định dạng:\n\`Tên bài - Tên artist\`\n\nVí dụ: \`APT. - ROSE\`\n\n_Gõ /cancel để hủy_`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.onText(/\/crawl(?:\s+(\d+))?/, async (msg, match) => {
    const userId = msg.from?.id ?? 0
    const role = getRole(userId)
    if (!role) { await denyAccess(msg.chat.id, userId); return }
    if (!canDecide(role)) { await bot.sendMessage(msg.chat.id, '⛔ Bạn không có quyền dùng tính năng này.'); return }
    const lastCrawl = lastCrawlTime.get(userId) ?? 0
    const cooldownLeft = Math.ceil((CRAWL_COOLDOWN_MS - (Date.now() - lastCrawl)) / 1000)
    if (cooldownLeft > 0) {
      await bot.sendMessage(msg.chat.id, `⏳ Vui lòng chờ thêm *${cooldownLeft}s* trước khi crawl lại.`, { parse_mode: 'Markdown' })
      return
    }
    // Parse optional count: /crawl 5 → 5, /crawl → 15 (max)
    const rawCount = match?.[1] ? parseInt(match[1]) : 15
    const target = Math.min(Math.max(1, rawCount), 15)
    lastCrawlTime.set(userId, Date.now())
    await bot.sendMessage(msg.chat.id, `⏳ *Đang crawl — tìm tối đa ${target} bài mới...*\nTikTok · YouTube · SoundCloud · Reddit · Google Trends`, { parse_mode: 'Markdown' })
    const newTrends = await crawlAll(target)
    await sendCrawlResult(msg.chat.id, newTrends)
  })

  bot.onText(/\/status/, async (msg) => {
    const userId = msg.from?.id ?? 0
    if (getRole(userId) !== 'admin') { await denyAccess(msg.chat.id, userId); return }
    const [pending, completed, approved, rush] = await Promise.all([
      prisma.trend.count({ where: { status: 'PENDING' } }),
      prisma.trend.count({ where: { status: 'COMPLETED' } }),
      prisma.decision.count({ where: { action: 'APPROVE' } }),
      prisma.trend.count({ where: { urgency: 'RUSH', status: 'COMPLETED', decision: null } }),
    ])
    await bot.sendMessage(msg.chat.id,
      `📈 *Pipeline Status*\n\nChờ score: ${pending}\nĐã score: ${completed}\nĐã duyệt: ${approved}\n🔴 RUSH chưa duyệt: ${rush}`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.onText(/\/export/, async (msg) => {
    const userId = msg.from?.id ?? 0
    if (getRole(userId) !== 'admin') { await denyAccess(msg.chat.id, userId); return }
    const approved = await prisma.decision.findMany({
      where: { action: 'APPROVE' },
      include: { trend: true },
      orderBy: { decidedAt: 'desc' },
    })
    if (approved.length === 0) {
      await bot.sendMessage(msg.chat.id, 'Chưa có bài nào được duyệt.')
      return
    }
    const csv = [
      'Title,Artist,Source,Market,Score,BPM,Style,MarketProgression,LeadTimeWeeks,Vibe,AISuggest,DecidedAt',
      ...approved.map(d => {
        const raw = safeJSON(d.trend.rawData)
        return [
          d.trend.title, d.trend.artist, d.trend.source, d.trend.market ?? '',
          d.trend.totalScore, raw.bpm ?? '', raw.style ?? '',
          raw.marketProgression ?? '', raw.leadTimeWeeks ?? '',
          (d.trend.vibe ?? '').replace(/"/g, '""'),
          (d.trend.aiSuggest ?? '').replace(/"/g, '""'),
          d.decidedAt.toISOString(),
        ].map(v => `"${v}"`).join(',')
      }),
    ].join('\n')
    await bot.sendDocument(msg.chat.id, Buffer.from(csv), {}, {
      filename: `approved-trends-${new Date().toISOString().split('T')[0]}.csv`,
      contentType: 'text/csv',
    })
  })

  bot.onText(/\/cancel/, async (msg) => {
    const userId = msg.from?.id ?? 0
    clearMode(userId)
    const role = getRole(userId)
    if (!role) return
    await bot.sendMessage(msg.chat.id, txtMainMenu(role), {
      parse_mode: 'Markdown', reply_markup: kbMain(role),
    })
  })

  // /adduser <id> member|viewer
  bot.onText(/\/adduser (\d+) (member|viewer)/, async (msg, match) => {
    const userId = msg.from?.id ?? 0
    if (getRole(userId) !== 'admin') { await denyAccess(msg.chat.id, userId); return }

    const targetId = parseInt(match![1]!)
    const roleToAdd = match![2] as 'member' | 'viewer'

    const users = loadUsers()
    users.members = users.members.filter(id => id !== targetId)
    users.viewers = users.viewers.filter(id => id !== targetId)
    if (roleToAdd === 'member') users.members.push(targetId)
    else users.viewers.push(targetId)
    saveUsers(users)

    await bot.sendMessage(msg.chat.id,
      `✅ Đã thêm \`${targetId}\` với role *${roleToAdd}*`,
      { parse_mode: 'Markdown' }
    )
  })

  // /removeuser <id>
  bot.onText(/\/removeuser (\d+)/, async (msg, match) => {
    const userId = msg.from?.id ?? 0
    if (getRole(userId) !== 'admin') { await denyAccess(msg.chat.id, userId); return }

    const targetId = parseInt(match![1]!)
    const users = loadUsers()
    users.members = users.members.filter(id => id !== targetId)
    users.viewers = users.viewers.filter(id => id !== targetId)
    saveUsers(users)

    await bot.sendMessage(msg.chat.id,
      `✅ Đã xóa user \`${targetId}\``,
      { parse_mode: 'Markdown' }
    )
  })
}

// ─── Message handler (input mode) ────────────────────────────────

function registerMessageHandler(): void {
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return
    const userId = msg.from?.id ?? 0
    const role = getRole(userId)
    if (!role) return

    const mode = getMode(userId)
    if (!mode) return

    if (mode === 'add_source') {
      clearMode(userId)
      const url = msg.text.trim()

      if (!url.startsWith('http')) {
        await bot.sendMessage(msg.chat.id,
          '⚠️ Vui lòng gửi link hợp lệ (bắt đầu bằng http).\n\nGửi lại hoặc /cancel để hủy.',
          { parse_mode: 'Markdown' }
        )
        setMode(userId, 'add_source')
        return
      }

      const platform = detectPlatform(url)
      const loadingMsg = await bot.sendMessage(msg.chat.id,
        `⏳ Đang xác định nguồn ${platformIcon(platform)}...`
      )

      try {
        const added = await addSourceFromUrl(url)
        if (!added) {
          await bot.editMessageText(
            `❌ Không xác định được nguồn từ URL này.\n\nThử lại với link profile/channel trực tiếp.\nVí dụ: \`https://youtube.com/@channelname\``,
            { chat_id: msg.chat.id, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
          )
          return
        }

        await bot.editMessageText(
          `✅ Đã thêm *${added.name}* vào danh sách theo dõi!\n\n${platformIcon(added.platform)} ${platformLabel(added.platform)} · ${added.market}\nID: \`${added.channelId}\`\n\nBot sẽ tự crawl nguồn này định kỳ.`,
          {
            chat_id: msg.chat.id, message_id: loadingMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '📋 Xem danh sách', callback_data: 'cmd_sources' }]] },
          }
        )
      } catch (err) {
        await bot.editMessageText(
          `❌ Lỗi: ${err instanceof Error ? err.message : String(err)}`,
          { chat_id: msg.chat.id, message_id: loadingMsg.message_id }
        )
      }
      return
    }

    if (mode === 'add_channel') {
      // Legacy mode — redirect to add_source handling
      clearMode(userId)
      const url = msg.text.trim()
      const platform = detectPlatform(url)
      const loadingMsg = await bot.sendMessage(msg.chat.id, `⏳ Đang xác định nguồn ${platformIcon(platform)}...`)
      try {
        const added = await addSourceFromUrl(url)
        if (!added) {
          await bot.editMessageText('❌ Không tìm được nguồn. Thử link profile/channel trực tiếp.', { chat_id: msg.chat.id, message_id: loadingMsg.message_id })
          return
        }
        await bot.editMessageText(
          `✅ Đã thêm *${added.name}* (${platformLabel(added.platform)})`,
          {
            chat_id: msg.chat.id, message_id: loadingMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '📋 Xem danh sách', callback_data: 'cmd_sources' }]] },
          }
        )
      } catch (err) {
        await bot.editMessageText(`❌ Lỗi: ${err instanceof Error ? err.message : String(err)}`, { chat_id: msg.chat.id, message_id: loadingMsg.message_id })
      }
      return
    }

    if (mode === 'add_trend') {
      clearMode(userId)
      const raw = msg.text.trim()
      const forced = raw.toLowerCase().startsWith('force:')
      const input = forced ? raw.slice(6).trim() : raw
      const parts = input.split(' - ')
      const title = parts[0]?.trim() ?? input
      const artist = parts[1]?.trim() ?? 'Manual'

      await bot.sendMessage(msg.chat.id, `⏳ Đang kiểm tra ngày phát hành...`, { parse_mode: 'Markdown' })

      const releaseDate = await lookupReleaseDate(title, artist)

      if (!forced && releaseDate && !isRecent(releaseDate, 30)) {
        const relYear = parseReleaseDate(releaseDate).getFullYear()
        await bot.sendMessage(msg.chat.id,
          `⚠️ *${title}* phát hành từ *${relYear}* — quá 1 tháng, không phù hợp để theo dõi trend mới.\n\nNếu vẫn muốn thêm, gõ lại: \`force: Tên bài - Artist\``,
          { parse_mode: 'Markdown' }
        )
        return
      }

      await prisma.trend.create({
        data: {
          externalId: `manual_${Date.now()}`,
          source: 'MANUAL',
          title,
          artist,
          market: 'US',
          type: classifyTrend('MANUAL', 'US'),
          rawData: JSON.stringify({ releaseDate: releaseDate ?? null }),
        },
      })

      const relInfo = releaseDate ? ` (phát hành ${releaseDate})` : ''
      await bot.sendMessage(msg.chat.id,
        `✅ Đã thêm: *${title}* — ${artist}${relInfo}\n\nTrend đã vào hàng chờ chấm điểm.`,
        {
          parse_mode: 'Markdown',
          reply_markup: kbBack('menu_main'),
        }
      )
    }
  })
}

// ─── Push alert (called by scheduler) ────────────────────────────

export async function pushAlert(trend: {
  id: number; title: string; artist: string; source: string; market: string | null
  totalScore: number; urgency: string | null; vibe: string | null
  aiSuggest: string | null; scores: string | null; thumbnail: string | null; rawData: string | null
  url?: string | null; type?: string
}): Promise<void> {
  if (!bot) return

  const text = formatTrend(trend)
  const users = loadUsers()

  const recipients: Array<{ id: number; role: Role }> = [
    ...config.telegram.adminIds.map(id => ({ id, role: 'admin' as Role })),
    ...users.members.map(id => ({ id, role: 'member' as Role })),
    ...users.viewers.map(id => ({ id, role: 'viewer' as Role })),
  ]

  for (const { id, role } of recipients) {
    try {
      const keyboard = canDecide(role) ? kbDecision(trend.id) : undefined
      if (trend.thumbnail) {
        await bot.sendPhoto(id, trend.thumbnail, {
          caption: text, parse_mode: 'Markdown', reply_markup: keyboard,
        })
      } else {
        await bot.sendMessage(id, text, {
          parse_mode: 'Markdown', reply_markup: keyboard,
        })
      }
    } catch (err) {
      logger.error('bot', `Alert to ${id} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
