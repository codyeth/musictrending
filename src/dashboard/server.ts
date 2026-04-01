import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import prisma from '../db.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function startDashboard() {
  const app = express()
  app.use(express.json())
  app.use(express.static(__dirname))

  // GET /api/trends
  app.get('/api/trends', async (req, res) => {
    try {
      const { source, type, minScore, urgency, decided } = req.query

      const where: Record<string, unknown> = { status: 'COMPLETED' }
      if (source && source !== 'ALL') where.source = source
      if (type && type !== 'ALL') where.type = type
      if (minScore) where.totalScore = { gte: parseInt(minScore as string) }
      if (urgency && urgency !== 'ALL') where.urgency = urgency
      if (decided === 'pending') where.decision = null
      if (decided === 'decided') where.NOT = { decision: null }

      const trends = await prisma.trend.findMany({
        where,
        include: { decision: true },
        orderBy: { totalScore: 'desc' },
        take: 100,
      })
      res.json(trends)
    } catch (err) {
      logger.error('dashboard', `GET /api/trends failed: ${err instanceof Error ? err.message : String(err)}`)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /api/decision
  app.post('/api/decision', async (req, res) => {
    try {
      const { trendId, action } = req.body
      if (!trendId || !action) return res.status(400).json({ error: 'Missing fields' })

      const decision = await prisma.decision.upsert({
        where: { trendId: Number(trendId) },
        update: { action, decidedAt: new Date() },
        create: { trendId: Number(trendId), action },
      })
      res.json(decision)
    } catch (err) {
      logger.error('dashboard', `POST /api/decision failed: ${err instanceof Error ? err.message : String(err)}`)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /api/stats
  app.get('/api/stats', async (_req, res) => {
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

  app.listen(config.dashboard.port, () => {
    logger.info('dashboard', `Running at http://localhost:${config.dashboard.port}`)
  })
}
