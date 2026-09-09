/**
 * #986: a document-supplied string used as an object key.
 *
 * ⚠️ **Almost every case here uses one of the OTHER SEVEN `Object.prototype` member names, not
 * `__proto__`.** Only `__proto__` goes through a setter; `constructor`, `toString`, `valueOf`,
 * `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable` and `toLocaleString` are ordinary own
 * keys on assignment and reach only the READ half — which is the majority of the sites this fixed.
 * A suite that only ever tries `__proto__` stays green against all of them, so trying it is the
 * point rather than a flourish.
 *
 * ⚠️ **Every block has an ACCEPT case.** A guard proving it REJECTS `constructor` never proves it
 * ACCEPTS an ordinary trait name — `emptyDocMap()` returning a frozen object, or `hasDocKey()`
 * returning a constant `false`, passes every reject case while breaking the engine.
 */

import { describe, expect, it } from 'vitest'
import { emptyDocMap, hasDocKey, putOwn } from '../../src/runtime/core/docKeys'
import { validateAgentToolArgs } from '../../src/runtime/debug/agentToolRegistry'
import { mergeOverrideMaps, mergeNestedOverridePaths, descendNestedOverrides } from '../../src/runtime/loaders/loadSceneFile'
import { normalizeSpriteAnim } from '../../src/runtime/loaders/spriteAnimCache'

/** The full set. A test naming only `__proto__` is the under-reporting this issue warns about. */
const PROTO_NAMES = [
  '__proto__', 'constructor', 'toString', 'valueOf',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
] as const

describe('#986 the primitives', () => {
  it('emptyDocMap answers honestly for all eight names, and holds an ordinary key', () => {
    const bag = emptyDocMap<number>()
    for (const name of PROTO_NAMES) {
      expect(hasDocKey(bag, name), `${name} should be absent`).toBe(false)
      expect(bag[name], `${name} should read undefined`).toBeUndefined()
    }
    // ACCEPT: it is still a working map, not merely an empty one.
    bag.position = 1
    expect(hasDocKey(bag, 'position')).toBe(true)
    expect(bag.position).toBe(1)
  })

  it('emptyDocMap stores __proto__ as a real key instead of losing it to the setter', () => {
    const bag = emptyDocMap<number>()
    bag['__proto__'] = 7
    expect(bag['__proto__']).toBe(7)
    expect(Object.keys(bag)).toContain('__proto__')
    // The control that makes the assertion above meaningful: a PLAIN object loses it silently.
    const plain: Record<string, number> = {}
    plain['__proto__'] = 7
    expect(Object.keys(plain)).not.toContain('__proto__')
  })

  it('putOwn defines the key without replacing an ordinary bag’s prototype', () => {
    const bag: Record<string, unknown> = {}
    putOwn(bag, '__proto__', 7)
    expect(bag['__proto__']).toBe(7)
    expect(Object.keys(bag)).toContain('__proto__')
    // Still an ORDINARY object — that is the whole reason putOwn exists rather than emptyDocMap:
    // these bags cross into koota / three / pixi, which a null prototype would be untested against.
    expect(Object.getPrototypeOf(bag)).toBe(Object.prototype)
    // ACCEPT: an ordinary key still round-trips and stays enumerable.
    putOwn(bag, 'name', 'ok')
    expect(Object.entries(bag)).toContainEqual(['name', 'ok'])
  })

  it('hasDocKey answers for a null-prototype AND an ordinary bag', () => {
    expect(hasDocKey({ toString: 1 }, 'toString')).toBe(true)   // a REAL own key
    expect(hasDocKey({}, 'toString')).toBe(false)               // the inherited one
    expect(hasDocKey(Object.assign(emptyDocMap(), { a: 1 }), 'a')).toBe(true)
  })
})

describe('#986 validateAgentToolArgs — the probe-verified member', () => {
  const def = { name: 'modoki_demo', params: { path: { type: 'string' as const } } }

  it.each(PROTO_NAMES)('rejects an undeclared arg named %s', (name) => {
    const msg = validateAgentToolArgs(def as never, { [name]: 'x' })
    expect(msg, `'${name}' was silently ACCEPTED and forwarded to the handler`).toContain(name)
  })

  it('still accepts a declared arg, and still rejects an ordinary typo', () => {
    // ACCEPT — without this, a validator that rejected everything would pass every case above.
    expect(validateAgentToolArgs(def as never, { path: '/a' })).toBeNull()
    expect(validateAgentToolArgs(def as never, { pth: '/a' })).toContain('pth')
  })

  it('type-checks a declared param whose NAME is a prototype member', () => {
    // The accept-side mirror: `args[key]` on a caller bag would have read a function.
    const odd = { name: 'modoki_demo', params: { toString: { type: 'string' as const, required: true } } }
    expect(validateAgentToolArgs(odd as never, {})).toContain('requires')
    expect(validateAgentToolArgs(odd as never, { toString: 5 })).toContain('must be a string')
    expect(validateAgentToolArgs(odd as never, { toString: 'ok' })).toBeNull()
  })
})

describe('#986 loadSceneFile override maps', () => {
  it.each(PROTO_NAMES)('merges a trait named %s instead of losing or inventing it', (name) => {
    const merged = mergeOverrideMaps(undefined, { 3: { [name]: { x: 1 } } })
    expect(hasDocKey(merged[3], name)).toBe(true)
    expect(merged[3][name]).toEqual({ x: 1 })
  })

  it('does not invent a trait the file never declared', () => {
    // The READ half: against a plain object, `merged[3]['toString']` is a function.
    const merged = mergeOverrideMaps(undefined, { 3: { Transform: { x: 1 } } })
    for (const name of PROTO_NAMES) expect(merged[3][name], name).toBeUndefined()
    // ACCEPT: the real override survived and `b` still wins on conflict.
    expect(merged[3].Transform).toEqual({ x: 1 })
    expect(mergeOverrideMaps({ 3: { Transform: { x: 1 } } }, { 3: { Transform: { x: 2 } } })[3].Transform).toEqual({ x: 2 })
  })

  it('mergeNestedOverridePaths does not walk Object.prototype as if it were an override map', () => {
    // `out[k] ?` was truthy for `toString`, handing a FUNCTION to mergeOverrideMaps.
    const out = mergeNestedOverridePaths({ '3': { 1: { Transform: { x: 1 } } } }, { '3.5': { 2: { Transform: { y: 2 } } } })!
    for (const name of PROTO_NAMES) expect(hasDocKey(out, name), name).toBe(false)
    // ACCEPT: both real paths are present and untouched.
    expect(out['3'][1].Transform).toEqual({ x: 1 })
    expect(out['3.5'][2].Transform).toEqual({ y: 2 })
  })

  it('descendNestedOverrides forwards a crafted __proto__ path segment as a real key', () => {
    const { forward } = descendNestedOverrides({ '3.__proto__': { 1: { Transform: { x: 1 } } } }, 3)
    expect(forward && hasDocKey(forward, '__proto__')).toBe(true)
    // ACCEPT: an ordinary deeper path still forwards with its leading segment stripped.
    expect(descendNestedOverrides({ '3.5': { 1: { Transform: { x: 1 } } } }, 3).forward!['5'][1].Transform).toEqual({ x: 1 })
  })
})

describe('#986 spriteAnimCache — the read half that actually bites', () => {
  it.each(PROTO_NAMES)('a clip named %s is neither invented nor lost', (name) => {
    // Before the fix, `clips['toString']` on a plain bag returned a FUNCTION, so spriteAnimHasClip
    // answered TRUE and resolveSpriteClip handed a function back typed as a SpriteClip.
    const empty = normalizeSpriteAnim({ clips: {} })
    expect(hasDocKey(empty.clips, name), `${name} was invented`).toBe(false)
    const declared = normalizeSpriteAnim({ clips: { [name]: { frames: [], fps: 1 } } as never })
    expect(hasDocKey(declared.clips, name), `${name} was lost`).toBe(true)
  })

  it('still normalizes an ordinary clip', () => {
    const def = normalizeSpriteAnim({ clips: { walk: { frames: [], fps: 12 } } as never })
    expect(hasDocKey(def.clips, 'walk')).toBe(true)
  })
})

/**
 * ⚠️ **`mergeParamDefaults` has NO test here, deliberately — its guard cannot be observed.**
 *
 * Two cases were written and both stayed GREEN with the fix reverted (mutation-checked, 2026-09-09).
 * The reason is `coerceParamValue`: every branch type-checks (`typeof v === 'number'`,
 * `Array.isArray(v)`) and falls back to the schema default, so a `Object.prototype.toString`
 * FUNCTION read through the prototype is sanitised to exactly the value the correct read produces.
 * The output is identical either way.
 *
 * The guard stays in the source as an honest read at a document boundary — and because it stops
 * being unobservable the moment `coerceParamValue` grows a pass-through branch — but a test
 * asserting it would be the unfalsifiable shape this repo keeps finding: green because the
 * mechanism is unreachable, not because it works. Better to record that than to bank a passing
 * assertion that proves nothing.
 */
