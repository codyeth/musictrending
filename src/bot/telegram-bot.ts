import TelegramBot from 'node-telegram-bot-api'
import prisma from '../db.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'
import { analyzeLink } from '../processor/analyzer.js'
import { saveSubscription, loadSubscriptions } from '../crawlers/subscriptions.js'
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
  return `❓ *Hướng dẫn sử dụng*
━━━━━━━━━━━━━━━
📊 *TRENDS*

🔥 *Top Trends*
Hiện top 5 trends chưa duyệt, sắp xếp theo điểm.
Member/Admin có thể duyệt ngay từ inline button.

🔗 *Theo dõi link* _(Member/Admin)_
Gửi link YouTube hoặc NicoNico → bot phân tích bài đó và gợi ý 5 bài tương tự đang trending.
Sau khi phân tích, có thể subscribe artist/nguồn để bot tự crawl định kỳ.

➕ *Thêm Trend* _(Member/Admin)_
Thêm trend thủ công vào hệ thống.
Bot sẽ yêu cầu nhập theo định dạng: \`Tên bài - Artist\`
Ví dụ: \`APT. - ROSE\`

🔄 *Crawl Ngay* _(Member/Admin)_
Chạy ngay 1 lần crawl tất cả nguồn dữ liệu.
━━━━━━━━━━━━━━━
⚙️ *QUẢN LÝ* _(Admin)_

📈 *Thống kê*
Xem trạng thái pipeline: chờ score, đã score, đã duyệt.

📤 *Export CSV*
Xuất file CSV tất cả bài đã được duyệt.

📋 *Logs*
Hướng dẫn xem logs hệ thống qua PM2.
━━━━━━━━━━━━━━━
👥 *QUẢN LÝ USER* _(Admin)_

\`/adduser <id> member\` — Thêm user xem + duyệt
\`/adduser <id> viewer\` — Thêm user chỉ xem
\`/removeuser <id>\` — Xóa user
━━━━━━━━━━━━━━━
🔔 *ALERTS TỰ ĐỘNG*
Khi trend mới đạt score >= ${config.scoring.alertThreshold}, bot tự gửi thông báo.
Member/Admin nhận nút APPROVE/WATCH/REJECT.
Viewer nhận thông báo nhưng không có nút duyệt.`
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

  lines.push(``)
  lines.push(`💬 _${trend.vibe ?? 'Đang phân tích...'}_`)
  if (trend.aiSuggest) lines.push(`💡 ${trend.aiSuggest}`)

  return lines.join('\n')
}

// ─── Bot instance ─────────────────────────────────────────────────

let bot: TelegramBot

export function initBot(): TelegramBot {
  bot = new TelegramBot(config.telegram.botToken, { polling: true })

  bot.setMyCommands([
    { command: 'start', description: 'Mở menu chính' },
    { command: 'help', description: 'Hướng dẫn sử dụng' },
    { command: 'adduser', description: 'Thêm user: /adduser <id> member|viewer (Admin)' },
    { command: 'removeuser', description: 'Xóa user: /removeuser <id> (Admin)' },
  ]).catch(() => {})

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
        `⏳ *Đang crawl tất cả nguồn...*\nVui lòng chờ ~30 giây`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
      )
      process.emit('crawlnow' as never)
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

  bot.onText(/\/cancel/, async (msg) => {
    const userId = msg.from?.id ?? 0
    userModes.delete(userId)
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
