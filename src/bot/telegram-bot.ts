import TelegramBot from 'node-telegram-bot-api'
import prisma from '../db.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'
import { analyzeLink } from '../processor/analyzer.js'
import { saveSubscription, loadSubscriptions } from '../crawlers/subscriptions.js'
import { loadChannels, removeChannel, addChannel, resolveChannelUrl } from '../crawlers/youtube-channels.js'
import { crawlAll } from '../crawlers/all.js'
import { classifyTrend } from '../utils/classify.js'
import fs from 'fs'
import path from 'path'

// ─── User storage (JSON file) ─────────────────────────────────────

const USERS_FILE = path.resolve('data/users.json')

interface UsersData {
  members: number[]
  viewers: number[]
}

function loadUsers(): UsersData {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'))
    }
  } catch {}
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

// ─── Pending subscriptions (short-lived, after link analysis) ────

interface PendingSub { name: string; styleContext: string; sourceUrl: string; userId: number }
const pendingSubs = new Map<string, PendingSub>()

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
    rows.push([{ text: '🔗 Theo dõi link', callback_data: 'cmd_link' }])
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

🔗 *Theo dõi link* — \`/link\`
Gửi link YouTube/NicoNico → AI phân tích phong cách, gợi ý 5 trend tương tự đang hot.

➕ *Thêm thủ công* — \`/add\`
Tự thêm bài vào hệ thống. Nhập theo dạng: \`Tên bài - Artist\`

📤 *Export CSV* — \`/export\`
Xuất danh sách bài đã *DUYỆT* ra file CSV.
━━━━━━━━━━━━━━━
📡 *Nguồn dữ liệu*
Spotify · Apple Music · Shazam · Billboard · Melon (KR) · Niconico (JP) · Google Trends · Reddit`
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
    `🎵 ${trend.title} — ${trend.artist}`,
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
    // Fallback: generate search URL — use title only for system/platform sources
    const SYSTEM_ARTISTS = ['Google Trends Signal', 'Manual', 'Unknown', 'Billboard', 'Apple Music', 'Shazam']
    const isSystemArtist = SYSTEM_ARTISTS.some(a => trend.artist.includes(a))
    const searchQuery = isSystemArtist ? trend.title : `${trend.title} ${trend.artist}`
    const q = encodeURIComponent(searchQuery)
    const searchUrl = trend.source === 'NICONICO'
      ? `https://www.nicovideo.jp/search/${q}`
      : `https://www.youtube.com/results?search_query=${q}`
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
  for (const t of newTrends.slice(0, 20)) {
    const typeIcon = t.type === 'IDEA' ? '💡' : '🎵'
    lines.push(`${typeIcon} *${t.title}* — ${t.artist}\n   📡 ${t.source} | ${t.market ?? 'N/A'}`)
  }
  if (newTrends.length > 20) {
    lines.push(`\n_...và ${newTrends.length - 20} bài khác. Xem đầy đủ trên dashboard._`)
  }
  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' })
}

// ─── Bot instance ─────────────────────────────────────────────────

let bot: TelegramBot

export function initBot(): TelegramBot {
  bot = new TelegramBot(config.telegram.botToken, { polling: true })

  // Commands cho member/viewer
  bot.setMyCommands([
    { command: 'start', description: 'Mở menu chính' },
    { command: 'top', description: 'Xem top trends chưa duyệt' },
    { command: 'link', description: 'Phân tích link YouTube/NicoNico' },
    { command: 'add', description: 'Thêm trend thủ công' },
    { command: 'crawl', description: 'Crawl tất cả nguồn ngay' },
    { command: 'help', description: 'Hướng dẫn sử dụng' },
  ]).catch(() => {})

  // Commands bổ sung cho admin (hiển thị thêm)
  bot.setMyCommands([
    { command: 'start', description: 'Mở menu chính' },
    { command: 'top', description: 'Xem top trends chưa duyệt' },
    { command: 'link', description: 'Phân tích link YouTube/NicoNico' },
    { command: 'add', description: 'Thêm trend thủ công' },
    { command: 'crawl', description: 'Crawl tất cả nguồn ngay' },
    { command: 'status', description: 'Thống kê pipeline' },
    { command: 'export', description: 'Xuất CSV bài đã duyệt' },
    { command: 'addchannel', description: 'Theo dõi kênh YT: /addchannel <channelId> <tên> <market> <genre>' },
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

function registerCallbacks(): void {
  bot.on('callback_query', async (query) => {
    if (!query.data || !query.from || !query.message) return
    await bot.answerCallbackQuery(query.id)

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
        await bot.editMessageText('Chưa có kênh nào. Dùng /addchannel để thêm.', {
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
      await bot.answerCallbackQuery(query.id, { text: `Đã xóa ${ch?.name ?? id}` })
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

    // ── Analyze link (set input mode) ───────────────────────────

    if (data === 'cmd_link') {
      if (!canDecide(role)) return
      userModes.set(userId, 'analyze_link')
      await bot.editMessageText(
        `🔗 *Theo dõi link*\n\nGửi link YouTube hoặc NicoNico của bài nhạc bạn muốn phân tích.\n\n_Gõ /cancel để hủy_`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
      )
      return
    }

    // ── Subscribe confirm ────────────────────────────────────────

    if (data.startsWith('cmd_subscribe_')) {
      const key = data.replace('cmd_subscribe_', '')
      const pending = pendingSubs.get(key)
      if (!pending) {
        await bot.editMessageText('⚠️ Hết hạn. Vui lòng phân tích lại link.', {
          chat_id: chatId, message_id: msgId,
        })
        return
      }
      pendingSubs.delete(key)
      saveSubscription({
        name: pending.name,
        styleContext: pending.styleContext,
        sourceUrl: pending.sourceUrl,
        addedBy: pending.userId,
      })
      await bot.editMessageText(
        `⭐ Đã subscribe *${pending.name}*\n\nBot sẽ tự crawl nguồn này định kỳ và tạo trend mới khi có bài hay.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
      )
      return
    }

    if (data.startsWith('cmd_nosubscribe_')) {
      const key = data.replace('cmd_nosubscribe_', '')
      pendingSubs.delete(key)
      await bot.editMessageText('OK, không theo dõi.', { chat_id: chatId, message_id: msgId })
      return
    }

    // ── Add trend (set input mode) ───────────────────────────────

    if (data === 'cmd_add') {
      if (!canDecide(role)) return
      userModes.set(userId, 'add_trend')
      await bot.editMessageText(
        `➕ *Thêm Trend Thủ Công*\n\nGửi tên bài theo định dạng:\n\`Tên bài - Tên artist\`\n\nVí dụ: \`APT. - ROSE\`\n\n_Gõ /cancel để hủy_`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
      )
      return
    }

    // ── Crawl now ────────────────────────────────────────────────

    if (data === 'cmd_crawl') {
      if (!canDecide(role)) return
      await bot.editMessageText(
        `⏳ *Đang crawl tất cả nguồn...*\nSpotify · Apple Music · Shazam · Billboard · Melon · Niconico · Google Trends`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
      )
      const newTrends = await crawlAll()
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

  bot.onText(/\/link/, async (msg) => {
    const userId = msg.from?.id ?? 0
    const role = getRole(userId)
    if (!role) { await denyAccess(msg.chat.id, userId); return }
    if (!canDecide(role)) { await bot.sendMessage(msg.chat.id, '⛔ Bạn không có quyền dùng tính năng này.'); return }
    userModes.set(userId, 'analyze_link')
    await bot.sendMessage(msg.chat.id,
      `🔗 *Theo dõi link*\n\nGửi link YouTube hoặc NicoNico của bài nhạc bạn muốn phân tích.\n\n_Gõ /cancel để hủy_`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.onText(/\/add/, async (msg) => {
    const userId = msg.from?.id ?? 0
    const role = getRole(userId)
    if (!role) { await denyAccess(msg.chat.id, userId); return }
    if (!canDecide(role)) { await bot.sendMessage(msg.chat.id, '⛔ Bạn không có quyền dùng tính năng này.'); return }
    userModes.set(userId, 'add_trend')
    await bot.sendMessage(msg.chat.id,
      `➕ *Thêm Trend Thủ Công*\n\nGửi tên bài theo định dạng:\n\`Tên bài - Tên artist\`\n\nVí dụ: \`APT. - ROSE\`\n\n_Gõ /cancel để hủy_`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.onText(/\/crawl/, async (msg) => {
    const userId = msg.from?.id ?? 0
    const role = getRole(userId)
    if (!role) { await denyAccess(msg.chat.id, userId); return }
    if (!canDecide(role)) { await bot.sendMessage(msg.chat.id, '⛔ Bạn không có quyền dùng tính năng này.'); return }
    await bot.sendMessage(msg.chat.id, '⏳ *Đang crawl tất cả nguồn...*\nSpotify · Apple Music · Shazam · Billboard · Melon · Niconico · Google Trends', { parse_mode: 'Markdown' })
    const newTrends = await crawlAll()
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
    userModes.delete(userId)
    const role = getRole(userId)
    if (!role) return
    await bot.sendMessage(msg.chat.id, txtMainMenu(role), {
      parse_mode: 'Markdown', reply_markup: kbMain(role),
    })
  })

  // /addchannel <youtube_url> <market> [genre]
  bot.onText(/\/addchannel (.+)/, async (msg, match) => {
    const userId = msg.from?.id ?? 0
    if (getRole(userId) !== 'admin') { await denyAccess(msg.chat.id, userId); return }

    const parts = (match![1] ?? '').trim().split(' ')
    const urlOrId = parts[0] ?? ''
    const market = parts[1]?.toUpperCase() ?? 'US'
    const genre = parts.slice(2).join(' ') || 'funk'

    if (!urlOrId) {
      await bot.sendMessage(msg.chat.id,
        `⚠️ Cú pháp:\n\`/addchannel <youtube_url> <market> [genre]\`\n\nVí dụ:\n\`/addchannel https://youtube.com/@vulfpeck US funk\`\n\`/addchannel https://youtube.com/@yoasobi JP j-pop\``,
        { parse_mode: 'Markdown' }
      )
      return
    }

    // If it's already a UC... ID, use directly
    if (urlOrId.startsWith('UC') && urlOrId.length === 24) {
      addChannel({ channelId: urlOrId, name: urlOrId, market, genre })
      await bot.sendMessage(msg.chat.id,
        `✅ Đã thêm channel ID \`${urlOrId}\` (${market})\n\nBot crawl lúc 09:00 và 18:00 hàng ngày.`,
        { parse_mode: 'Markdown' }
      )
      return
    }

    const loadingMsg = await bot.sendMessage(msg.chat.id, '⏳ Đang lấy thông tin kênh...')

    const resolved = await resolveChannelUrl(urlOrId)
    if (!resolved) {
      await bot.editMessageText(
        `❌ Không lấy được channel ID từ URL này.\n\nThử dùng URL dạng:\n\`https://youtube.com/@channelname\``,
        { chat_id: msg.chat.id, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
      )
      return
    }

    addChannel({ channelId: resolved.channelId, name: resolved.name, market, genre })
    await bot.editMessageText(
      `✅ Đã thêm kênh *${resolved.name}* (${market})\nID: \`${resolved.channelId}\`\n\nBot crawl lúc 09:00 và 18:00 hàng ngày.`,
      { chat_id: msg.chat.id, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
    )
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

    const mode = userModes.get(userId)
    if (!mode) return

    if (mode === 'analyze_link') {
      userModes.delete(userId)
      const url = msg.text.trim()

      const isYoutube = url.includes('youtube.com') || url.includes('youtu.be')
      const isNico = url.includes('nicovideo.jp') || url.includes('nico.ms')
      if (!isYoutube && !isNico) {
        await bot.sendMessage(msg.chat.id,
          '⚠️ Chỉ hỗ trợ link YouTube hoặc NicoNico.\n\nGửi lại link hợp lệ hoặc /cancel để hủy.',
          { parse_mode: 'Markdown' }
        )
        userModes.set(userId, 'analyze_link')
        return
      }

      const loadingMsg = await bot.sendMessage(msg.chat.id,
        '⏳ Đang phân tích...\nVui lòng chờ ~15 giây',
      )

      try {
        const result = await analyzeLink(url)
        const { meta, suggestions, styleContext, savedCount } = result

        const suggestionLines = suggestions.map((s, i) =>
          `${i + 1}. *${s.title}* — ${s.artist} [${s.market}]\n   _${s.reason}_`
        ).join('\n\n')

        await bot.editMessageText(
          `✅ *Phân tích: "${meta.title}"*\nby ${meta.author}\n\n` +
          `🎼 Style: _${styleContext}_\n\n` +
          `━━━━━━━━━━━━━━━\n` +
          `💡 *${savedCount} bài tương tự đã thêm vào queue:*\n\n${suggestionLines}`,
          {
            chat_id: msg.chat.id, message_id: loadingMsg.message_id,
            parse_mode: 'Markdown',
          }
        )

        // Offer subscription
        const key = Date.now().toString(36)
        pendingSubs.set(key, {
          name: meta.author,
          styleContext,
          sourceUrl: url,
          userId,
        })
        // Auto-expire after 10 minutes
        setTimeout(() => pendingSubs.delete(key), 10 * 60 * 1000)

        await bot.sendMessage(msg.chat.id,
          `⭐ Muốn theo dõi *${meta.author}* để bot tự crawl định kỳ?`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Có, theo dõi', callback_data: `cmd_subscribe_${key}` },
                { text: '❌ Không', callback_data: `cmd_nosubscribe_${key}` },
              ]],
            },
          }
        )
      } catch (err) {
        await bot.editMessageText(
          `❌ Lỗi: ${err instanceof Error ? err.message : 'Không thể phân tích link này.'}`,
          { chat_id: msg.chat.id, message_id: loadingMsg.message_id }
        )
      }
      return
    }

    if (mode === 'add_trend') {
      userModes.delete(userId)
      const parts = msg.text.split(' - ')
      const title = parts[0]?.trim() ?? msg.text
      const artist = parts[1]?.trim() ?? 'Manual'

      await prisma.trend.create({
        data: {
          externalId: `manual_${Date.now()}`,
          source: 'MANUAL',
          title,
          artist,
          market: 'US',
          type: classifyTrend('MANUAL', 'US'),
        },
      })

      await bot.sendMessage(msg.chat.id,
        `✅ Đã thêm: *${title}* — ${artist}\n\nTrend đã vào hàng chờ chấm điểm.`,
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
