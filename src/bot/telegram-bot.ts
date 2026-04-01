import TelegramBot from 'node-telegram-bot-api'
import prisma from '../db.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

let bot: TelegramBot

export function initBot(): TelegramBot {
  bot = new TelegramBot(config.telegram.botToken, { polling: true })
  registerCommands()
  registerCallbacks()
  logger.info('bot', 'Telegram bot started')
  return bot
}

function isAdmin(userId: number): boolean {
  return config.telegram.adminIds.includes(userId)
}

function urgencyEmoji(urgency: string | null): string {
  if (urgency === 'RUSH') return '🔴'
  if (urgency === 'WATCH') return '🟠'
  return '🟡'
}

function formatTrendMessage(trend: {
  title: string; artist: string; source: string; market: string | null;
  totalScore: number; urgency: string | null; vibe: string | null;
  aiSuggest: string | null; scores: string | null
}): string {
  const emoji = urgencyEmoji(trend.urgency)
  const label = trend.urgency ?? 'NEW'
  const scoresObj = trend.scores ? JSON.parse(trend.scores) : {}

  return `${emoji} *${label}* — Score: *${trend.totalScore}/100*
━━━━━━━━━━━━━━━
🎵 ${trend.title} — ${trend.artist}
📡 Nguồn: ${trend.source} | Thị trường: ${trend.market ?? 'N/A'}
🎯 Feasibility: ${scoresObj.feasibility ?? '?'}/10 | Revenue: ${scoresObj.revenuePotential ?? '?'}/25

💬 _${trend.vibe ?? 'Đang phân tích...'}_
💡 ${trend.aiSuggest ?? ''}`
}

function trendInlineKeyboard(trendId: number) {
  return {
    inline_keyboard: [[
      { text: '✅ Duyệt', callback_data: `approve_${trendId}` },
      { text: '⏳ Theo dõi', callback_data: `watch_${trendId}` },
      { text: '❌ Bỏ qua', callback_data: `reject_${trendId}` },
    ]]
  }
}

export async function pushAlert(trend: {
  id: number; title: string; artist: string; source: string; market: string | null;
  totalScore: number; urgency: string | null; vibe: string | null;
  aiSuggest: string | null; scores: string | null; thumbnail: string | null
}) {
  if (!bot) return

  const text = formatTrendMessage(trend)
  const keyboard = trendInlineKeyboard(trend.id)

  for (const adminId of config.telegram.adminIds) {
    try {
      if (trend.thumbnail) {
        await bot.sendPhoto(adminId, trend.thumbnail, {
          caption: text,
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        })
      } else {
        await bot.sendMessage(adminId, text, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        })
      }
    } catch (err) {
      logger.error('bot', `Failed to send alert to ${adminId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function registerCallbacks() {
  bot.on('callback_query', async (query) => {
    if (!query.data || !query.from) return
    if (!isAdmin(query.from.id)) return

    const [action, idStr] = query.data.split('_')
    const trendId = parseInt(idStr ?? '')
    if (isNaN(trendId)) return

    const actionMap: Record<string, 'APPROVE' | 'WATCH' | 'REJECT'> = {
      approve: 'APPROVE',
      watch: 'WATCH',
      reject: 'REJECT',
    }

    const decisionAction = actionMap[action ?? '']
    if (!decisionAction) return

    try {
      await prisma.decision.upsert({
        where: { trendId },
        update: { action: decisionAction, decidedAt: new Date() },
        create: { trendId, action: decisionAction },
      })

      const labels: Record<string, string> = {
        APPROVE: '✅ Đã duyệt',
        WATCH: '⏳ Theo dõi',
        REJECT: '❌ Đã bỏ qua',
      }

      await bot.answerCallbackQuery(query.id, { text: labels[decisionAction] })
      if (query.message?.message_id && query.message.chat.id) {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: query.message.chat.id, message_id: query.message.message_id }
        )
      }
    } catch (err) {
      logger.error('bot', `Failed to save decision: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

function registerCommands() {
  bot.onText(/\/start/, async (msg) => {
    if (!isAdmin(msg.from?.id ?? 0)) return
    await bot.sendMessage(msg.chat.id,
      `🎵 *Music Trend Tool*\n\n` +
      `/status — Thống kê pipeline\n` +
      `/top — Top 5 trends chưa duyệt\n` +
      `/crawlnow — Crawl ngay\n` +
      `/export — Xuất CSV bài đã duyệt\n` +
      `/add <bài - artist> — Thêm trend thủ công\n` +
      `/logs — 20 log gần nhất`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.onText(/\/status/, async (msg) => {
    if (!isAdmin(msg.from?.id ?? 0)) return
    const [pending, completed, approved, rush] = await Promise.all([
      prisma.trend.count({ where: { status: 'PENDING' } }),
      prisma.trend.count({ where: { status: 'COMPLETED' } }),
      prisma.decision.count({ where: { action: 'APPROVE' } }),
      prisma.trend.count({ where: { urgency: 'RUSH', status: 'COMPLETED', decision: null } }),
    ])
    await bot.sendMessage(msg.chat.id,
      `📊 *Pipeline Status*\n\nChờ score: ${pending}\nĐã score: ${completed}\nĐã duyệt: ${approved}\n🔴 RUSH chưa duyệt: ${rush}`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.onText(/\/top/, async (msg) => {
    if (!isAdmin(msg.from?.id ?? 0)) return
    const trends = await prisma.trend.findMany({
      where: { status: 'COMPLETED', decision: null },
      orderBy: { totalScore: 'desc' },
      take: 5,
    })
    if (trends.length === 0) {
      await bot.sendMessage(msg.chat.id, 'Không có trend nào chờ duyệt.')
      return
    }
    for (const trend of trends) {
      await bot.sendMessage(msg.chat.id, formatTrendMessage(trend), {
        parse_mode: 'Markdown',
        reply_markup: trendInlineKeyboard(trend.id),
      })
    }
  })

  bot.onText(/\/add (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from?.id ?? 0)) return
    const input = match?.[1] ?? ''
    const parts = input.split(' - ')
    const title = parts[0]?.trim() ?? input
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
    await bot.sendMessage(msg.chat.id, `✅ Đã thêm: *${title}* — ${artist}`, { parse_mode: 'Markdown' })
  })

  bot.onText(/\/export/, async (msg) => {
    if (!isAdmin(msg.from?.id ?? 0)) return
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
      'Title,Artist,Source,Market,Score,Vibe,AISuggest,DecidedAt',
      ...approved.map(d =>
        `"${d.trend.title}","${d.trend.artist}","${d.trend.source}","${d.trend.market ?? ''}","${d.trend.totalScore}","${(d.trend.vibe ?? '').replace(/"/g, '""')}","${(d.trend.aiSuggest ?? '').replace(/"/g, '""')}","${d.decidedAt.toISOString()}"`
      )
    ].join('\n')

    await bot.sendDocument(msg.chat.id, Buffer.from(csv), {}, {
      filename: `approved-trends-${new Date().toISOString().split('T')[0]}.csv`,
      contentType: 'text/csv',
    })
  })

  bot.onText(/\/crawlnow/, async (msg) => {
    if (!isAdmin(msg.from?.id ?? 0)) return
    await bot.sendMessage(msg.chat.id, '🔄 Đang crawl...')
    process.emit('crawlnow' as any)
  })

  bot.onText(/\/logs/, async (msg) => {
    if (!isAdmin(msg.from?.id ?? 0)) return
    await bot.sendMessage(msg.chat.id,
      '📋 Logs được ghi ra console/PM2.\n\nDùng lệnh: `pm2 logs music-tool --lines 50`',
      { parse_mode: 'Markdown' }
    )
  })
}
