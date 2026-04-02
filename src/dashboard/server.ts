import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import prisma from '../db.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const ALLOWED_ACTIONS = new Set(['APPROVE', 'WATCH', 'REJECT'])

// Simple token auth for dashboard API — reads DASHBOARD_TOKEN from env
// Dashboard is localhost-only but we still protect the API endpoints
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = config.dashboard.token
  if (!token) {
    // No token configured → localhost-only, allow
    next()
    return
  }
  const provided = req.headers['x-dashboard-token'] ?? req.query['token']
  if (provided !== token) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

export function startDashboard() {
  const app = express()
  app.use(express.json())
  app.use(express.static(__dirname))

  // GET /api/trends
  app.get('/api/trends', requireAuth, async (req, res) => {
    try {
      const { source, type, minScore, urgency, decided } = req.query

      const where: Record<string, unknown> = { status: 'COMPLETED' }
      if (source && source !== 'ALL') where.source = source
      if (type && type !== 'ALL') where.type = type
      if (minScore) {
        const score = parseInt(minScore as string, 10)
        if (!isNaN(score)) where.totalScore = { gte: score }
      }
      if (urgency && urgency !== 'ALL') where.urgency = urgency
      if (decided === 'pending') where.decision = null
      if (decided === 'decided') where.NOT = { decision: null }

      const { sortBy } = req.query
      const orderBy =
        sortBy === 'score'    ? { totalScore: 'desc' as const } :
        sortBy === 'score_asc' ? { totalScore: 'asc' as const } :
        sortBy === 'oldest'   ? { createdAt: 'asc' as const } :
        { createdAt: 'desc' as const }  // default: newest first

      const trends = await prisma.trend.findMany({
        where,
        include: { decision: true },
        orderBy,
        take: 200,
      })
      res.json(trends)
    } catch (err) {
      logger.error('dashboard', `GET /api/trends failed: ${err instanceof Error ? err.message : String(err)}`)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /api/decision
  app.post('/api/decision', requireAuth, async (req, res) => {
    try {
      const { trendId, action } = req.body
      if (!trendId || !action) return res.status(400).json({ error: 'Missing fields' })

      if (!ALLOWED_ACTIONS.has(String(action).toUpperCase())) {
        return res.status(400).json({ error: 'Invalid action' })
      }

      const decision = await prisma.decision.upsert({
        where: { trendId: Number(trendId) },
        update: { action: action as 'APPROVE' | 'WATCH' | 'REJECT', decidedAt: new Date() },
        create: { trendId: Number(trendId), action: action as 'APPROVE' | 'WATCH' | 'REJECT' },
      })
      res.json(decision)
    } catch (err) {
      logger.error('dashboard', `POST /api/decision failed: ${err instanceof Error ? err.message : String(err)}`)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /api/stats
  app.get('/api/stats', requireAuth, async (_req, res) => {
    try {
      const today = new Date()
      today.setHours(0, 0, 0, 0)

      const [total, pending, approved, rush] = await Promise.all([
        prisma.trend.count({ where: { createdAt: { gte: today } } }),
        prisma.trend.count({ where: { status: 'COMPLETED', decision: null } }),
        prisma.decision.count({ where: { action: 'APPROVE' } }),
        prisma.trend.count({ where: { urgency: 'RUSH', status: 'COMPLETED', decision: null } }),
      ])
      res.json({ total, pending, approved, rush })
    } catch (err) {
      logger.error('dashboard', `GET /api/stats failed: ${err instanceof Error ? err.message : String(err)}`)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  app.listen(config.dashboard.port, '127.0.0.1', () => {
    logger.info('dashboard', `Running at http://localhost:${config.dashboard.port}`)
  })
}
