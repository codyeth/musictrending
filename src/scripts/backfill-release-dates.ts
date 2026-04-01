import 'dotenv/config'
import prisma from '../db.js'
import { lookupReleaseDate, isRecent } from '../utils/spotify-lookup.js'

const SKIP_SOURCES = ['GOOGLE_TRENDS', 'REDDIT']

// Patterns indicating garbage records from bad crawl parsing
const GARBAGE_PATTERNS = [
  /^[\d\s,]+$/, // pure numbers
  /opacity|cursor|font-family|border|background/i, // CSS
  /buildId:|assetPrefix/i, // JS bundle artifacts
  /^Unknown$/i,
  /^See you soon/i,
  /marks \d+ year/i,
]

function isGarbage(title: string): boolean {
  return GARBAGE_PATTERNS.some(p => p.test(title)) || title.length < 2
}

async function main() {
  // 1. Delete garbage records
  const all = await prisma.trend.findMany({ select: { id: true, title: true, source: true } })
  const garbageIds = all.filter(t => isGarbage(t.title)).map(t => t.id)

  if (garbageIds.length > 0) {
    await prisma.decision.deleteMany({ where: { trendId: { in: garbageIds } } })
    await prisma.trend.deleteMany({ where: { id: { in: garbageIds } } })
    console.log(`Deleted ${garbageIds.length} garbage records`)
  }

  // 2. Backfill release dates for real songs
  const trends = await prisma.trend.findMany({
    where: { source: { notIn: SKIP_SOURCES as any } },
    select: { id: true, title: true, artist: true, rawData: true, alerted: true, status: true },
  })

  const needLookup = trends.filter(t => {
    try { return !JSON.parse(t.rawData ?? '{}').releaseDate }
    catch { return true }
  })

  console.log(`Need release date lookup: ${needLookup.length}`)

  let updated = 0, stale = 0, notFound = 0

  for (let i = 0; i < needLookup.length; i++) {
    const t = needLookup[i]!
    process.stdout.write(`\r[${i + 1}/${needLookup.length}] ${t.title.slice(0, 40).padEnd(40)}`)

    const releaseDate = await lookupReleaseDate(t.title, t.artist)
    await new Promise(r => setTimeout(r, 300))

    if (!releaseDate) { notFound++; continue }

    const raw = JSON.parse(t.rawData ?? '{}')
    const isOld = !isRecent(releaseDate, 30)

    await prisma.trend.update({
      where: { id: t.id },
      data: {
        rawData: JSON.stringify({ ...raw, releaseDate }),
        ...(isOld && t.status === 'PENDING' ? { status: 'FAILED' } : {}),
        ...(isOld && t.alerted ? { urgency: null } : {}),
      },
    })
    updated++
    if (isOld) stale++
  }

  console.log(`\n\nDone.`)
  console.log(`Updated: ${updated} | Stale (>1 month): ${stale} | Not found: ${notFound}`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
