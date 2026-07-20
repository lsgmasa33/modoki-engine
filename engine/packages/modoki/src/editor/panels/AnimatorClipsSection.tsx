/** Animator-only Inspector section: owns the named keyframe-clip bank (`clips`, a
 *  JSON-string `[{name, clip, speed?, loop?}]`) AND the active-clip pointer (`clip`, a NAME).
 *
 *  Neither field is in the trait's meta.fields (so the generic renderer ignores them) — this
 *  custom section renders a row editor for the bank (name + `.anim.json` picker + per-clip
 *  speed/loop overrides) plus an active-clip dropdown, mirroring `AudioSourceClips` (the JSON
 *  bank) and `SpriteAnimatorSection` (the active-name dropdown). The clip DATA is authored in
 *  the Animation panel; here you only pick which clips exist and which one plays. */

import { useState } from 'react';
import { findEntity } from '../../runtime/ecs/entityUtils';
import { type TraitMeta } from '../../runtime/ecs/traitRegistry';
import {
  writeTraitFieldPerEntityWithUndo as writeFieldPerEntity,
  writeTraitFieldsPerEntityWithUndo as writeTraitFields,
} from '../undo/entityActions';
import { parseAnimClipBank, stringifyAnimClipBank, type AnimatorClip } from '../../runtime/animation/animClipBank';
import { BufferedTextInput, BufferedNumberInput, inputStyle } from './fields';
import { AssetRefField } from './AssetRefField';

const ANIM_EXT = ['.anim.json'];

export function AnimatorClipsSection({ entityIds, meta }: {
  entityIds: number[]; meta: TraitMeta;
}) {
  // `clips`/`clip` aren't in meta.fields → readTraitData drops them; read the LIVE trait. A
  // local tick re-reads after an edit (the Inspector's refresh diffs readTraitData, which
  // never sees these fields).
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const live = findEntity(entityIds[0])?.get(meta.trait) as { clips?: string; clip?: string } | undefined;
  const bank = parseAnimClipBank(live?.clips);

  // Edit the parsed bank, then write it back as a JSON string (single scalar field).
  const editBank = (fn: (cur: AnimatorClip[]) => AnimatorClip[], label: string) => {
    writeFieldPerEntity(entityIds, meta, 'clips', (old) => stringifyAnimClipBank(fn(parseAnimClipBank(old))), label);
    bump();
  };
  const setNameAt = (i: number, name: string) => editBank((cur) => { if (cur[i]) cur[i] = { ...cur[i], name }; return cur; }, `Edit ${meta.name} clip name`);
  const setRefAt = (i: number, clip: string) => editBank((cur) => { if (!clip) cur.splice(i, 1); else if (cur[i]) cur[i] = { ...cur[i], clip }; return cur; }, `Edit ${meta.name} clip`);
  const setSpeedAt = (i: number, speed: number) => editBank((cur) => { if (cur[i]) cur[i] = { ...cur[i], speed }; return cur; }, `Edit ${meta.name} clip speed`);
  const setLoopAt = (i: number, loop: boolean) => editBank((cur) => { if (cur[i]) cur[i] = { ...cur[i], loop }; return cur; }, `Edit ${meta.name} clip loop`);
  const setFadeAt = (i: number, fadeDuration: number) => editBank((cur) => { if (cur[i]) cur[i] = { ...cur[i], fadeDuration }; return cur; }, `Edit ${meta.name} clip fade`);
  const add = (clip: string) => { if (clip) editBank((cur) => [...cur, { name: uniqueName(cur), clip }], `Add ${meta.name} clip`); };

  // Active-clip dropdown: empty active name → first entry (matches resolveActiveClip).
  const names = bank.map((c) => c.name);
  const activeName = (live?.clip && names.includes(live.clip)) ? live.clip : (names[0] ?? '');
  const selectClip = (name: string) => { writeTraitFields(entityIds, meta, () => ({ clip: name, time: 0 }), `Select ${meta.name} clip`); bump(); };

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ borderTop: '1px solid #444', margin: '6px 0' }} />

      {/* Active-clip pointer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={labelStyle}>clip</span>
        <select value={activeName} onChange={(e) => selectClip(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 0 }} disabled={names.length === 0}>
          {names.length === 0 && <option value="">(no clips)</option>}
          {names.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {/* The named clip bank. Row: name │ .anim.json │ speed │ fade(s) │ loop */}
      <div style={{ fontSize: '11px', color: '#888', marginBottom: 4 }}>
        Clips <span style={{ color: '#666' }}>(name → .anim.json; speed · fade s · loop; switch by name at runtime)</span>
      </div>
      {bank.map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
          <BufferedTextInput
            value={c.name} onChange={(v) => setNameAt(i, v)} placeholder="name"
            style={{ ...inputStyle, width: 64, flex: '0 0 auto' }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <AssetRefField label="" value={c.clip} onChange={(v) => setRefAt(i, v)} accept={ANIM_EXT} />
          </div>
          <BufferedNumberInput
            value={c.speed ?? 1} onChange={(v) => setSpeedAt(i, v)} step={0.1}
            style={{ ...inputStyle, width: 40, flex: '0 0 auto' }}
          />
          <BufferedNumberInput
            value={c.fadeDuration ?? 0} onChange={(v) => setFadeAt(i, v)} step={0.05} min={0}
            style={{ ...inputStyle, width: 40, flex: '0 0 auto' }}
          />
          <input
            type="checkbox" checked={c.loop ?? true} onChange={(e) => setLoopAt(i, e.target.checked)}
            title="Per-clip loop override" style={{ flex: '0 0 auto' }}
          />
        </div>
      ))}
      <AssetRefField label="+ add" value="" onChange={add} accept={ANIM_EXT} placeholder="drop an .anim.json clip" />
    </div>
  );
}

const labelStyle: React.CSSProperties = { width: 40, color: '#9a9aa8', fontSize: 11, flexShrink: 0 };

/** Suggest a fresh, non-colliding clip name (clip / clip2 / clip3 …) for a new entry. */
export function uniqueName(bank: AnimatorClip[]): string {
  const taken = new Set(bank.map((c) => c.name));
  if (!taken.has('clip')) return 'clip';
  for (let n = 2; ; n++) { const s = `clip${n}`; if (!taken.has(s)) return s; }
}
