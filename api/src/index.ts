import type { Context } from 'hono'
import { Hono } from 'hono'

type App = Hono<{ Bindings: Env }>
type AppContext = Context<{ Bindings: Env }>

type HomeRow = { id: string; name: string }
type MemberRow = { id: string; home_id: string; name: string }
type OrderedMemberRow = MemberRow & { insertion_order: number }
type ShareRow = {
  id: string
  member_id: string
  amount_cents: number
  paid_at: string | null
  idempotency_key: string | null
}
type BillRow = { id: string; home_id: string; title: string; total_cents: number }
type BalanceRow = { member_id: string; name: string; outstanding_cents: number }

const app: App = new Hono<{ Bindings: Env }>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function readBody(c: AppContext): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json()
    return isRecord(body) ? body : null
  } catch {
    return null
  }
}

function error(c: AppContext, status: 400 | 404 | 409 | 422, message: string) {
  return c.json({ error: message }, status)
}

function shareResponse(row: ShareRow) {
  return {
    id: row.id,
    memberId: row.member_id,
    amountCents: row.amount_cents,
    paidAt: row.paid_at,
  }
}

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.post('/api/homes', async (c) => {
  const body = await readBody(c)
  if (!body || typeof body.name !== 'string') return error(c, 422, 'name must be a string')

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, body.name).run()
  return c.json({ id, name: body.name }, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const body = await readBody(c)
  if (!body || typeof body.name !== 'string') return error(c, 422, 'name must be a string')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()
  if (!home) return error(c, 404, 'home not found')

  const nextOrder = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(insertion_order), -1) + 1 AS next_order FROM members WHERE home_id = ?',
  )
    .bind(homeId)
    .first<{ next_order: number }>()
  const id = crypto.randomUUID()
  const insertionOrder = nextOrder?.next_order ?? 0
  await c.env.DB.prepare(
    'INSERT INTO members (id, home_id, name, insertion_order) VALUES (?, ?, ?, ?)',
  )
    .bind(id, homeId, body.name, insertionOrder)
    .run()

  return c.json({ id, homeId, name: body.name }, 201)
})

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const body = await readBody(c)
  if (
    !body ||
    typeof body.title !== 'string' ||
    typeof body.totalCents !== 'number' ||
    !Number.isInteger(body.totalCents) ||
    body.totalCents <= 0
  ) {
    return error(c, 422, 'totalCents must be a positive integer')
  }

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()
  if (!home) return error(c, 404, 'home not found')

  const members = await c.env.DB.prepare(
    'SELECT id, home_id, name, insertion_order FROM members WHERE home_id = ? ORDER BY insertion_order',
  )
    .bind(homeId)
    .all<OrderedMemberRow>()
  if (members.results.length === 0) return error(c, 422, 'home has no members')

  const totalCents = body.totalCents
  const base = Math.floor(totalCents / members.results.length)
  const remainder = totalCents % members.results.length
  const billId = crypto.randomUUID()
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(billId, homeId, body.title, totalCents),
  ]
  const shares: Array<{ id: string; memberId: string; amountCents: number }> = []

  for (const [index, member] of members.results.entries()) {
    const amountCents = base + (index < remainder ? 1 : 0)
    const share = { id: crypto.randomUUID(), memberId: member.id, amountCents }
    shares.push(share)
    statements.push(
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      ).bind(share.id, billId, share.memberId, share.amountCents),
    )
  }
  await c.env.DB.batch(statements)

  return c.json(
    {
      id: billId,
      homeId,
      title: body.title,
      totalCents,
      shares: shares.map((share) => ({ ...share, paidAt: null })),
    },
    201,
  )
})

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()
  if (!home) return error(c, 404, 'home not found')

  const bills = await c.env.DB.prepare(
    'SELECT id, home_id, title, total_cents FROM bills WHERE home_id = ? ORDER BY rowid',
  )
    .bind(homeId)
    .all<BillRow>()
  const result = []
  for (const bill of bills.results) {
    const shares = await c.env.DB.prepare(
      'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE bill_id = ? ORDER BY rowid',
    )
      .bind(bill.id)
      .all<ShareRow>()
    result.push({
      id: bill.id,
      homeId: bill.home_id,
      title: bill.title,
      totalCents: bill.total_cents,
      shares: shares.results.map(shareResponse),
    })
  }
  return c.json({ bills: result })
})

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const key = c.req.header('Idempotency-Key')
  if (!key) return error(c, 400, 'Idempotency-Key header is required')

  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const paidAt = new Date().toISOString()
  const update = await c.env.DB.prepare(
    'UPDATE shares SET paid_at = ?, idempotency_key = ? WHERE id = ? AND bill_id = ? AND paid_at IS NULL',
  )
    .bind(paidAt, key, shareId, billId)
    .run()

  const share = await c.env.DB.prepare(
    'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
  )
    .bind(shareId, billId)
    .first<ShareRow>()
  if (!share) return error(c, 404, 'bill or share not found')
  if (update.meta.changes === 1 || share.idempotency_key === key)
    return c.json(shareResponse(share))
  return error(c, 409, 'share has already been paid with a different key')
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()
  if (!home) return error(c, 404, 'home not found')

  const balances = await c.env.DB.prepare(
    `SELECT m.id AS member_id, m.name,
      COALESCE(SUM(CASE WHEN s.paid_at IS NULL THEN s.amount_cents ELSE 0 END), 0) AS outstanding_cents
     FROM members m
     LEFT JOIN shares s ON s.member_id = m.id
     LEFT JOIN bills b ON b.id = s.bill_id AND b.home_id = m.home_id
     WHERE m.home_id = ?
     GROUP BY m.id, m.name, m.insertion_order
     ORDER BY m.insertion_order`,
  )
    .bind(homeId)
    .all<BalanceRow>()

  return c.json({
    balances: balances.results.map((balance) => ({
      memberId: balance.member_id,
      name: balance.name,
      outstandingCents: balance.outstanding_cents,
    })),
  })
})

app.notFound((c) => c.json({ error: 'not found' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'internal server error' }, 500)
})

export default app
