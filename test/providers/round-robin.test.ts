import { describe, expect, test } from 'bun:test'
import { RoundRobinSelector } from '../../src/providers/index.ts'

describe('RoundRobinSelector', () => {
  const pool = 'pc_pool'

  test('returns the candidates in strict rotation', () => {
    const selector = new RoundRobinSelector()
    const candidates = ['a', 'b', 'c']

    const chosen = [0, 1, 2, 3, 4, 5].map(() => selector.select(pool, candidates))

    expect(chosen).toEqual(['a', 'b', 'c', 'a', 'b', 'c'])
  })

  test('keeps pools independent so one pool never advances another', () => {
    const selector = new RoundRobinSelector()

    expect(selector.select('pool_a', ['a1', 'a2'])).toBe('a1')
    expect(selector.select('pool_b', ['b1', 'b2'])).toBe('b1')
    expect(selector.select('pool_a', ['a1', 'a2'])).toBe('a2')
    expect(selector.select('pool_b', ['b1', 'b2'])).toBe('b2')
  })

  test('spreads selections fairly across eligible candidates', () => {
    const selector = new RoundRobinSelector()
    const candidates = ['a', 'b', 'c']

    const counts = new Map<string, number>()
    for (let index = 0; index < 300; index++) {
      const chosen = selector.select(pool, candidates)
      expect(chosen).not.toBeNull()
      counts.set(chosen!, (counts.get(chosen!) ?? 0) + 1)
    }

    expect([...counts.values()].sort((left, right) => left - right)).toEqual([100, 100, 100])
  })

  test('is fair under interleaved concurrent callers with no lost or doubled selections', async () => {
    const selector = new RoundRobinSelector()
    const candidates = ['a', 'b', 'c']
    const selections: string[][] = [[], [], []]

    // One hundred callers per pool race, interleaving at an await boundary
    // between their own two selections. Because `select` itself is synchronous
    // with no await inside it, the event loop serialises every call and each
    // still lands exactly once on its rotation — no lock, no database write.
    const callers = Array.from({ length: 150 }, async (_, index) => {
      const pool = index % 3
      selections[pool]!.push(selector.select(`pool_${pool}`, candidates) ?? '')
      await Promise.resolve()
      selections[pool]!.push(selector.select(`pool_${pool}`, candidates) ?? '')
    })
    await Promise.all(callers)

    // Every caller got a real candidate, and each pool still saw the strict
    // rotation a,b,c,a,b,c -- nothing lost, nothing doubled.
    for (const list of selections) {
      expect(list).toHaveLength(100)
      expect(list.every((selection) => selection !== '')).toBe(true)
      list.forEach((selection, position) => {
        expect(selection).toBe(candidates[position % candidates.length]!)
      })
    }
  })

  test('returns null for an empty candidate list and does not advance the cursor', () => {
    const selector = new RoundRobinSelector()

    expect(selector.select(pool, [])).toBeNull()
    expect(selector.select(pool, ['a', 'b'])).toBe('a')
  })

  test('reset returns the rotation to its start without touching anything durable', () => {
    const selector = new RoundRobinSelector()
    const candidates = ['a', 'b']

    expect(selector.select(pool, candidates)).toBe('a')
    expect(selector.select(pool, candidates)).toBe('b')

    selector.reset()

    // After a reset the rotation begins again from the first candidate, exactly
    // what a restart may observe without changing any durable configuration.
    expect(selector.select(pool, candidates)).toBe('a')
  })

  test('a changed candidate list continues from the stored cursor', () => {
    const selector = new RoundRobinSelector()

    expect(selector.select(pool, ['a', 'b', 'c'])).toBe('a')
    expect(selector.select(pool, ['a', 'b'])).toBe('b')
    // The cursor is now 2, so with two candidates the next pick wraps to 'a'.
    expect(selector.select(pool, ['a', 'b'])).toBe('a')
  })
})
