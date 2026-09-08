/**
 * Audio graph rebuild — reapplying `busVolumes` + `muted` to freshly-created nodes.
 *
 * `dispose()` nulls the graph (editor stop→restart, error recovery); the next call
 * rebuilds it from scratch in `graphOrNull()`. Without reapplying the tracked bus mix
 * and the global mute flag to the fresh nodes, every bus would play at full volume
 * while the `busVolumes` snapshot and the settings slider still report the old
 * values — silent to every existing gate, audible to the player.
 *
 * This test used to be covered incidentally by `audioMusicDuck.test.ts` (#548 ducking),
 * which was deleted along with the ducking feature. The behaviour under test here
 * predates #548 and still ships — this file recovers that coverage.
 *
 * jsdom has no real Web Audio, so this wires up a minimal fake AudioContext/GainNode and
 * recovers the built graph's topology from the `connect()` calls it recorded — not from
 * creation order — for the mute/master/destination chain. The three sibling buses
 * (music/sfx/ui) are topologically IDENTICAL — each is just a gain node feeding
 * `master`, with nothing to structurally tell them apart — so disambiguating them
 * relies on the order `graphOrNull()` creates them in (`{ music: mk(), sfx: mk(),
 * ui: mk() }`), which is the only signal that exists for that.
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

/** Recover the live graph's mute/master nodes by topology (master → mute →
 *  destination), not by creation order — this chain IS structurally distinguishable
 *  (mute is whatever connects to the destination sentinel; master is whatever
 *  connects to that). The three bus nodes feeding master are then split out by
 *  creation order (see file banner — nothing else disambiguates them), taking the
 *  LAST three "connect to master" edges so a dispose()+rebuild's fresh nodes win
 *  over any earlier, now-orphaned generation. */
function currentGraphNodes(): { mute: FakeNode; master: FakeNode; music: FakeNode; sfx: FakeNode; ui: FakeNode } {
  const mute = findLastEdge((e) => e.to === destinationSentinel)?.from;
  if (!mute) throw new Error('no mute node found — graph not built');
  const master = findLastEdge((e) => e.to === mute)?.from;
  if (!master) throw new Error('no master node found — graph not built');
  const intoMaster = edges.filter((e) => e.to === master).map((e) => e.from);
  const fresh = intoMaster.slice(-3); // the current generation's three buses, in creation order
  if (fresh.length !== 3) throw new Error(`expected 3 buses feeding master, found ${fresh.length}`);
  const [music, sfx, ui] = fresh;
  return { mute, master, music, sfx, ui };
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

describe('audio graph rebuild — busVolumes + mute reapplied to fresh nodes', () => {
  it('bus volumes survive a rebuild, each on the RIGHT bus (four distinct values)', () => {
    audioService.setBusVolume('master', 0.15);
    audioService.setBusVolume('music', 0.35);
    audioService.setBusVolume('sfx', 0.55);
    audioService.setBusVolume('ui', 0.75);

    // Error-recovery / editor stop-restart: the graph is torn down and lazily rebuilt
    // on next use. Any call through graphOrNull() forces the rebuild.
    audioService.dispose();
    audioService.setAudioMuted(false); // force graphOrNull() to rebuild the graph

    const { master, music, sfx, ui } = currentGraphNodes();
    expect(master.gain.value).toBe(0.15);
    expect(music.gain.value).toBe(0.35);
    expect(sfx.gain.value).toBe(0.55);
    expect(ui.gain.value).toBe(0.75);
  });

  it('the mute flag survives a rebuild', () => {
    audioService.setAudioMuted(true);
    audioService.dispose();
    audioService.setBusVolume('sfx', 1); // force a rebuild

    expect(currentGraphNodes().mute.gain.value).toBe(0);

    audioService.setAudioMuted(false);
    audioService.dispose();
    audioService.setBusVolume('sfx', 1); // force a rebuild

    expect(currentGraphNodes().mute.gain.value).toBe(1);
  });

  it('topology after rebuild: music/sfx/ui → master → mute → destination', () => {
    audioService.setBusVolume('music', 1);
    audioService.setBusVolume('sfx', 1);
    audioService.setBusVolume('ui', 1);
    audioService.dispose();
    audioService.setBusVolume('master', 1); // force a rebuild

    const { mute, master, music, sfx, ui } = currentGraphNodes();
    expect(edges.some((e) => e.from === music && e.to === master)).toBe(true);
    expect(edges.some((e) => e.from === sfx && e.to === master)).toBe(true);
    expect(edges.some((e) => e.from === ui && e.to === master)).toBe(true);
    expect(edges.some((e) => e.from === master && e.to === mute)).toBe(true);
    expect(edges.some((e) => e.from === mute && e.to === destinationSentinel)).toBe(true);
  });
});
