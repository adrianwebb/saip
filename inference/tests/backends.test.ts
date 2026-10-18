import { describe, it, expect } from 'vitest'
import { MemoryStorage } from '../src/lib/backends.js'

describe('MemoryStorage (StorageProvider)', () => {
  it('round-trips put/get', async () => {
    const s = new MemoryStorage()
    await s.put('a/b.txt', 'hello')
    expect(await s.get('a/b.txt')).toBe('hello')
  })

  it('get returns undefined for missing key', async () => {
    const s = new MemoryStorage()
    expect(await s.get('nope')).toBeUndefined()
  })

  it('list returns only matching prefix, sorted', async () => {
    const s = new MemoryStorage()
    await s.put('documents/d2', 'x')
    await s.put('documents/d1', 'y')
    await s.put('knowledge/k1', 'z')
    expect(await s.list('documents/')).toEqual(['documents/d1', 'documents/d2'])
  })

  it('delete removes and reports whether it existed', async () => {
    const s = new MemoryStorage()
    await s.put('k', 'v')
    expect(await s.delete('k')).toBe(true)
    expect(await s.delete('k')).toBe(false)
    expect(await s.get('k')).toBeUndefined()
  })
})
