import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const [homeId, setHomeId] = useState(
    () => new URLSearchParams(window.location.search).get('homeId') ?? '',
  )
  const [inputHomeId, setInputHomeId] = useState(homeId)
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [payingShareId, setPayingShareId] = useState<string | null>(null)

  const loadBills = useCallback(async () => {
    if (!homeId) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/homes/${encodeURIComponent(homeId)}/bills`)
      const data: unknown = await response.json()
      if (!response.ok) throw new Error(readError(data))
      if (!isBillsResponse(data)) throw new Error('The API returned an unexpected response')
      setBills(data.bills)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not load bills')
    } finally {
      setLoading(false)
    }
  }, [homeId])

  useEffect(() => {
    void loadBills()
  }, [loadBills])

  const payShare = async (billId: string, shareId: string) => {
    setPayingShareId(shareId)
    setError(null)
    try {
      const response = await fetch(`/api/bills/${billId}/shares/${shareId}/pay`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      })
      const data: unknown = await response.json()
      if (!response.ok) throw new Error(readError(data))
      if (!isShare(data)) throw new Error('The API returned an unexpected response')
      setBills((current) =>
        current.map((bill) => ({
          ...bill,
          shares: bill.shares.map((share) => (share.id === data.id ? data : share)),
        })),
      )
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not pay share')
    } finally {
      setPayingShareId(null)
    }
  }

  const submitHome = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setHomeId(inputHomeId.trim())
  }

  return (
    <main
      style={{ maxWidth: 760, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}
    >
      <h1>Shared Bill Splitter</h1>
      <form onSubmit={submitHome} style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        <label htmlFor="home-id">Home ID</label>
        <input
          id="home-id"
          value={inputHomeId}
          onChange={(event) => setInputHomeId(event.target.value)}
        />
        <button type="submit">Load bills</button>
      </form>
      {!homeId && <p>Enter a home ID to see its bills.</p>}
      {loading && <p role="status">Loading bills…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && homeId && bills.length === 0 && <p>No bills yet.</p>}
      {!loading &&
        bills.map((bill) => (
          <section
            key={bill.id}
            style={{ border: '1px solid #ddd', padding: 16, marginBottom: 16 }}
          >
            <h2>{bill.title}</h2>
            <p>Total: {formatCents(bill.totalCents)}</p>
            <ul>
              {bill.shares.map((share) => (
                <li key={share.id}>
                  {formatCents(share.amountCents)} — {share.paidAt ? 'Paid' : 'Unpaid'}{' '}
                  {!share.paidAt && (
                    <button
                      type="button"
                      disabled={payingShareId === share.id}
                      onClick={() => void payShare(bill.id, share.id)}
                    >
                      {payingShareId === share.id ? 'Paying…' : 'Pay'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
    </main>
  )
}

type Share = { id: string; memberId: string; amountCents: number; paidAt: string | null }
type Bill = { id: string; homeId: string; title: string; totalCents: number; shares: Share[] }

function isShare(value: unknown): value is Share {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.memberId === 'string' &&
    typeof value.amountCents === 'number' &&
    (typeof value.paidAt === 'string' || value.paidAt === null)
  )
}

function isBillsResponse(value: unknown): value is { bills: Bill[] } {
  return isRecord(value) && Array.isArray(value.bills) && value.bills.every(isBill)
}

function isBill(value: unknown): value is Bill {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.homeId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.totalCents === 'number' &&
    Array.isArray(value.shares) &&
    value.shares.every(isShare)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readError(value: unknown): string {
  return isRecord(value) && typeof value.error === 'string' ? value.error : 'Request failed'
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
