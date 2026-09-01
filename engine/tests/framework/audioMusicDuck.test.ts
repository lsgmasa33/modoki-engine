/**
 * Music-bus ducking (`setMusicDucked`/`isMusicDucked`, #548) — the engine half of auto-ducking
 * Court's music while another app's audio plays.
 *
 * Graph shape under test (see audioService.ts's header comment):
 *   buses.music → musicDuck → master ← sfx/ui buses (straight, unaffected)
 *
 * The whole reason `musicDuck` is its own GainNode rather than `setBusVolume('music', 0)` is so
 * ducking and the player's music-volume slider COMPOSE instead of clobbering each other — that
 * is `composition does not clobber either direction` below, and it is written to fail against a
 * naive "duck == zero the bus volume" implementation (which would report the bus volume as 0
 * after ducking, not the authored value).
 *
 * jsdom has no real Web Audio, so this wires up a minimal fake AudioContext/GainNode and
 * recovers the built graph's topology from the `connect()` calls it recorded — not from creation
 * order — so the test survives an internal reshuffle of `graphOrNull()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Minimal fake Web Audio graph ──────────────────────────────────────────
interface FakeNode {
  gain: { value: number };
  connect(target: unknown): void;
  disconnect(): void;
}
let edges: Array<{ from: FakeNode; to: unknown }>;
let destinationSentinel: object;

function makeGain(): FakeNode {
  const node: FakeNode = {
    gain: { value: 1 },
    connect(target: unknown) { edges.push({ from: node, to: target }); },
    disconnect() { /* no-op */ },
  };
  return node;
}

class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = destinationSentinel;
  listener = {};
  createGain(): FakeNode { return makeGain(); }
  resume(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
}

/** Find the most recent edge matching `pred` — "most recent" is what lets this see the CURRENT
 *  graph after a dispose()+recreate appended a second full set of nodes to `edges`. */
function findLastEdge(pred: (e: { from: FakeNode; to: unknown }) => boolean) {
  for (let i = edges.length - 1; i >= 0; i--) if (pred(edges[i])) return edges[i];
  return undefined;
}

/** Recover the live graph's music-duck and music-bus nodes by topology (buses.music →
 *  musicDuck → master ← mute's destination chain), not by creation order. */
function currentDuckNodes(): { musicDuck: FakeNode; musicBus: FakeNode } {
  const mute = findLastEdge((e) => e.to === destinationSentinel)?.from;
  if (!mute) throw new Error('no mute node found — graph not built');
  const master = findLastEdge((e) => e.to === mute)?.from;
  if (!master) throw new Error('no master node found — graph not built');
  const intoMaster = edges.filter((e) => e.to === master).map((e) => e.from);
  // musicDuck is the only one of {musicDuck, sfxBus, uiBus} feeding master that ITSELF has an
  // incoming connection (from the music bus) — sfx/ui buses connect straight to master.
  const musicDuck = intoMaster.find((n) => edges.some((e) => e.to === n));
  if (!musicDuck) throw new Error('no musicDuck node found — graph not built');
  const musicBus = findLastEdge((e) => e.to === musicDuck)?.from;
  if (!musicBus) throw new Error('no music bus node found — graph not built');
  return { musicDuck, musicBus };
}

// ── Test setup ─────────────────────────────────────────────────────────────
let audioService: typeof import('../../packages/modoki/src/runtime/audio/audioService');

beforeEach(async () => {
  edges = [];
  destinationSentinel = { __destination: true };
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  vi.resetModules();
  audioService = await import('../../packages/modoki/src/runtime/audio/audioService');
  audioService.setAudioRecordMode(false);
  audioService.clearAudioLog();
});

afterEach(() => {
  audioService.dispose();
  audioService.setAudioRecordMode(false);
  audioService.clearAudioLog();
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
});

describe('setMusicDucked / isMusicDucked — live graph', () => {
  it('ducking multiplies onto the music bus, not overwrite: setBusVolume then duck', () => {
    audioService.setBusVolume('music', 0.5);
    audioService.setMusicDucked(true);

    const { musicDuck, musicBus } = currentDuckNodes();
    expect(musicBus.gain.value).toBe(0.5); // untouched by ducking
    expect(musicDuck.gain.value).toBe(0);  // fully ducked
    expect(audioService.isMusicDucked()).toBe(true);
  });

  it('ducking multiplies onto the music bus, not overwrite: duck then setBusVolume', () => {
    audioService.setMusicDucked(true);
    audioService.setBusVolume('music', 0.5);

    const { musicDuck, musicBus } = currentDuckNodes();
    expect(musicBus.gain.value).toBe(0.5); // the slider still lands on the bus node
    expect(musicDuck.gain.value).toBe(0);  // duck node is untouched by setBusVolume
    expect(audioService.isMusicDucked()).toBe(true);
  });

  it('un-ducking restores the duck node to unity while the bus volume is unaffected', () => {
    audioService.setBusVolume('music', 0.3);
    audioService.setMusicDucked(true);
    audioService.setMusicDucked(false);

    const { musicDuck, musicBus } = currentDuckNodes();
    expect(musicDuck.gain.value).toBe(1);
    expect(musicBus.gain.value).toBe(0.3);
    expect(audioService.isMusicDucked()).toBe(false);
  });

  it('duck state survives graph recreation (dispose + rebuild), like `muted` and the bus mix', () => {
    audioService.setBusVolume('music', 0.4);
    audioService.setMusicDucked(true);
    expect(audioService.isMusicDucked()).toBe(true);

    // Error-recovery / editor stop-restart: the graph is torn down and lazily rebuilt on next use.
    audioService.dispose();
    audioService.setBusVolume('sfx', 1); // force graphOrNull() to rebuild the graph

    const { musicDuck, musicBus } = currentDuckNodes();
    expect(musicDuck.gain.value).toBe(0);   // reapplied on the fresh node
    expect(musicBus.gain.value).toBe(0.4);  // busVolumes snapshot reapplied too
    expect(audioService.isMusicDucked()).toBe(true);
  });
});

describe('setMusicDucked — record mode (headless, no AudioContext)', () => {
  beforeEach(() => {
    audioService.setAudioRecordMode(true);
  });

  it('updates the flag and logs, without touching a graph', () => {
    audioService.setMusicDucked(true);
    expect(audioService.isMusicDucked()).toBe(true);
    expect(audioService.getAudioLog()).toContainEqual({ op: 'setMusicDucked', ducked: true });

    audioService.setMusicDucked(false);
    expect(audioService.isMusicDucked()).toBe(false);
    expect(audioService.getAudioLog()).toContainEqual({ op: 'setMusicDucked', ducked: false });
  });
});
