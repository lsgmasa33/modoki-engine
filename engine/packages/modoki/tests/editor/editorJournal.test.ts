/** Editor Percept (Phase 7) — the human-activity buffer + the undoManager taps that
 *  feed it (!edit / !select / !undo / !redo). */

import { describe, it, expect, beforeEach } from 'vitest';
import { editorEmit, readEditorJournal, clearEditorJournal, setEditorJournalEnabled, withEditorActor } from '../../src/editor/editorJournal';
import { pushAction, pushSelectionChange, undo, redo, clearHistory, _setUndoClock } from '../../src/editor/undo/undoManager';
import { nextCaptureSeq, _resetCaptureSeq } from '../../src/runtime/systems/journal';

beforeEach(() => {
  clearEditorJournal(); setEditorJournalEnabled(true);
  clearHistory(); _setUndoClock(() => performance.now());
  _resetCaptureSeq();
});

describe('editorJournal — buffer', () => {
  it('records events with a monotonic seq + type + payload', () => {
    editorEmit('!edit', { label: 'Set X' });
    editorEmit('!play', {});
    const evs = readEditorJournal();
    expect(evs.map((e) => e.type)).toEqual(['!edit', '!play']);
    expect(evs[0].payload).toEqual({ label: 'Set X' });
    expect(evs[1].seq).toBe(evs[0].seq + 1);
    expect(typeof evs[0].ts).toBe('number');
  });

  it('filters by type and by since (poll cursor)', () => {
    editorEmit('!edit'); editorEmit('!select'); editorEmit('!edit');
    expect(readEditorJournal({ type: '!edit' })).toHaveLength(2);
    const first = readEditorJournal()[0].seq;
    expect(readEditorJournal({ since: first }).map((e) => e.type)).toEqual(['!select', '!edit']);
  });

  it('tags source human by default, agent inside withEditorActor', () => {
    editorEmit('!edit');                                  // human (default)
    withEditorActor('agent', () => editorEmit('!edit'));  // agent
    editorEmit('!select');                                // human again (scope restored)
    expect(readEditorJournal().map((e) => e.source)).toEqual(['human', 'agent', 'human']);
    expect(readEditorJournal({ source: 'human' })).toHaveLength(2);
    expect(readEditorJournal({ source: 'agent' })).toHaveLength(1);
  });

  it('records nothing while disabled', () => {
    setEditorJournalEnabled(false);
    editorEmit('!edit');
    expect(readEditorJournal()).toHaveLength(0);
    setEditorJournalEnabled(true);
  });

  it('shares ONE monotonic cap counter with the game journal — the V3 interleave axis', () => {
    editorEmit('!a');                    // cap 1
    const gameCap = nextCaptureSeq();    // cap 2 — stands in for a game journal emit
    editorEmit('!b');                    // cap 3
    const evs = readEditorJournal();
    expect(evs.map((e) => e.cap)).toEqual([1, 3]); // editor caps skip the game emit's 2
    expect(gameCap).toBe(2);
    // Interleaving all three by cap reproduces the true capture order across streams.
    const timeline = [...evs.map((e) => ({ cap: e.cap, t: e.type })), { cap: gameCap, t: '@game' }]
      .sort((a, b) => a.cap - b.cap).map((x) => x.t);
    expect(timeline).toEqual(['!a', '@game', '!b']);
  });

  it('editor seq stays contiguous (poll cursor) while cap tracks the global order', () => {
    editorEmit('!a');                    // cap 1
    nextCaptureSeq();                    // a game emit bumps cap only
    editorEmit('!b');                    // cap 3
    const evs = readEditorJournal();
    expect(evs[1].seq).toBe(evs[0].seq + 1);       // seq is editor-local + contiguous (skips the game emit)
    expect(evs.map((e) => e.cap)).toEqual([1, 3]); // cap reflects the interleaved order
  });
});

describe('editorJournal — undoManager taps', () => {
  it('emits !edit on a value push and !select on a selection push', () => {
    pushAction({ label: 'Set Transform.x', undo: () => {}, redo: () => {} });
    pushSelectionChange('Select Box', () => {}, () => {});
    const evs = readEditorJournal();
    expect(evs.map((e) => e.type)).toEqual(['!edit', '!select']);
    expect(evs[0].payload).toEqual({ label: 'Set Transform.x' });
  });

  it('emits !undo / !redo when history is traversed', async () => {
    pushAction({ label: 'Move', undo: () => {}, redo: () => {} });
    clearEditorJournal();
    await undo();
    await redo();
    expect(readEditorJournal().map((e) => e.type)).toEqual(['!undo', '!redo']);
  });
});

describe('editorJournal — structured !edit detail (Percept V1)', () => {
  const detail = (over: Partial<{ trait: string; field: string; entities: string[]; old: unknown[]; new: unknown[] }> = {}) => ({
    trait: 'RigidBody2D', field: 'gravityScale', entities: ['g1'], old: [1], new: [0], ...over,
  });

  it('forwards a trait-edit detail into the !edit payload; selection carries none', () => {
    pushAction({ label: 'Edit RigidBody2D.gravityScale', undo: () => {}, redo: () => {}, detail: detail() });
    pushSelectionChange('Select Box', () => {}, () => {});
    const evs = readEditorJournal();
    expect(evs[0].type).toBe('!edit');
    expect((evs[0].payload as { detail?: unknown }).detail).toEqual(detail());
    expect(evs[1].type).toBe('!select');
    expect((evs[1].payload as { detail?: unknown }).detail).toBeUndefined();
  });

  it('snapshots the detail at emit — a later mutation of the action object cannot rewrite the record', () => {
    const d = detail({ old: [1], new: [2] });
    pushAction({ label: 'Edit', undo: () => {}, redo: () => {}, detail: d });
    // Mutate the original detail object AFTER the push (simulates any later aliasing).
    d.new[0] = 999;
    (d.entities as string[]).push('gX');
    const rec = (readEditorJournal({ type: '!edit' })[0].payload as { detail: { new: unknown[]; entities: unknown[] } }).detail;
    expect(rec.new).toEqual([2]);        // frozen, not 999
    expect(rec.entities).toEqual(['g1']); // frozen, not ['g1','gX']
  });

  it('!undo / !redo echo the edit detail so Claude sees what was reverted/reapplied', async () => {
    pushAction({ label: 'Edit', undo: () => {}, redo: () => {}, detail: detail({ old: [1], new: [2] }) });
    clearEditorJournal();
    await undo();
    await redo();
    const evs = readEditorJournal();
    expect(evs.map((e) => e.type)).toEqual(['!undo', '!redo']);
    expect((evs[0].payload as { detail: { old: unknown[] } }).detail.old).toEqual([1]);
    expect((evs[1].payload as { detail: { new: unknown[] } }).detail.new).toEqual([2]);
  });

  it('a coalescing edit yields ONE !edit record, frozen at the first commit (immutable, seq-stable)', () => {
    let t = 1000;
    _setUndoClock(() => t);
    pushAction({ label: 'Edit gravityScale', undo: () => {}, redo: () => {}, coalesceKey: 'k', detail: detail({ old: [1], new: [0.9] }) });
    t = 1100; // within COALESCE_MS (500) → merges into the top entry, emits NO new event
    pushAction({ label: 'Edit gravityScale', undo: () => {}, redo: () => {}, coalesceKey: 'k', detail: detail({ old: [1], new: [0] }) });

    // Journal: ONE !edit (coalesced), snapshot-frozen at the FIRST commit value. Later
    // coalesced pushes do NOT rewrite it (no aliasing) — so a since-cursor poller that
    // read it is never contradicted, and the record stays self-consistent.
    const edits = readEditorJournal({ type: '!edit' });
    expect(edits).toHaveLength(1);
    expect((edits[0].payload as { detail: { new: unknown[]; old: unknown[] } }).detail.new).toEqual([0.9]);
    expect((edits[0].payload as { detail: { old: unknown[] } }).detail.old).toEqual([1]);
  });

  it('kind overrides the sigil; journalPayload is merged into the event, snapshot-frozen (V2)', () => {
    const jp = { entities: ['gA', 'gB'] };
    pushAction({ label: 'Delete 2 Entities', undo: () => {}, redo: () => {}, kind: '!delete', journalPayload: jp });
    jp.entities.push('gX'); // mutate the original after the push — must not affect the record
    const evs = readEditorJournal();
    expect(evs[0].type).toBe('!delete');
    expect(evs[0].payload).toEqual({ label: 'Delete 2 Entities', entities: ['gA', 'gB'] });
  });

  it('!undo echoes the structural payload of the traversed kind action (V2)', async () => {
    pushAction({ label: 'Reparent', undo: () => {}, redo: () => {}, kind: '!reparent',
      journalPayload: { entity: 'g', from: 'root', to: 'gP', reorder: false } });
    clearEditorJournal();
    await undo();
    const ev = readEditorJournal()[0];
    expect(ev.type).toBe('!undo'); // undo of a structural action is still !undo
    expect(ev.payload).toEqual({ label: 'Reparent', entity: 'g', from: 'root', to: 'gP', reorder: false });
  });

  it('a heterogeneous per-entity coalesce never corrupts the emitted detail (finding-2 regression)', () => {
    // Regression: the per-entity write helper's FILTERED entity set can differ between two
    // coalescing pushes. Advancing only detail.new (old aliasing) would leave push-1's
    // entities/old paired with push-2's new → a misaligned/wrong diff. With snapshot-at-emit
    // and no coalesce mutation, the emitted !edit is push-1's self-consistent snapshot.
    let t = 1000;
    _setUndoClock(() => t);
    pushAction({ label: 'Edit binding', undo: () => {}, redo: () => {}, coalesceKey: 'k',
      detail: { trait: 'UIAction', field: 'bindings', entities: ['gA'], old: ['oA'], new: ['nA1'] } });
    t = 1100; // coalesces; push-2 touches a DIFFERENT (larger) entity set
    pushAction({ label: 'Edit binding', undo: () => {}, redo: () => {}, coalesceKey: 'k',
      detail: { trait: 'UIAction', field: 'bindings', entities: ['gA', 'gB'], old: ['oA', 'oB'], new: ['nA0', 'nB0'] } });

    const edits = readEditorJournal({ type: '!edit' });
    expect(edits).toHaveLength(1);
    const d = (edits[0].payload as { detail: { entities: unknown[]; old: unknown[]; new: unknown[] } }).detail;
    // Internally aligned (all three same length) and equal to push-1's snapshot — never a mix.
    expect(d.entities.length).toBe(d.old.length);
    expect(d.old.length).toBe(d.new.length);
    expect(d).toEqual({ trait: 'UIAction', field: 'bindings', entities: ['gA'], old: ['oA'], new: ['nA1'] });
  });
});
