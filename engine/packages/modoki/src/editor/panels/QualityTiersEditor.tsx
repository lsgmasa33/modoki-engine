/** The quality-tier MATRIX — the widget behind the 'quality-tiers' Project Settings field
 *  (docs/rendering.md § "Quality tiers"). One row per setting, one column per tier: Default, then
 *  `mid` and `low` once added.
 *
 *  ⚠️ **IT WAS A STACK OF PER-TIER CARDS, AND THAT SHAPE HID THE ONE QUESTION IT EXISTS TO ANSWER**
 *  (#403). Each tier printed its own twenty fields, each with its measurement rationale in full
 *  underneath, so comparing what `mid` and `low` did to the SAME setting meant scrolling between
 *  two cards a screen apart and remembering a number. A matrix puts them on one line. The
 *  rationale moves onto a hover (i) rather than being deleted — it is the reason the seeded values
 *  are what they are, and it was worth keeping, just not worth 20 permanent paragraphs.
 *
 *  ⚠️ **THE DEFAULT COLUMN EDITS REAL PROJECT FIELDS, and half of them are new (#403).** Six
 *  (`pixelRatioCap`, `antialias`, `shadows`, `targetFps`, and the two `pixi` twins) already existed
 *  and used to ALSO be rendered as standalone fields in the Three.js/PixiJS groups — the same
 *  setting authored in two places, with nothing saying so. Those duplicates are gone from
 *  `setup.ts`; this column is now their only home. Another EIGHT existed ONLY inside a tier, with
 *  the default hardcoded in the engine — the author could degrade a value they had no way to set.
 *  See `TIER_DEFAULT_FIELDS` (runtime/rendering/qualityTier.ts), which is the one list both the
 *  type and the resolver's read derive from.
 *
 *  ⚠️ `textureMaxSize` is the one tier field with NO Default cell, and that is deliberate: the
 *  BUILD honours it, not the runtime, and it only emits a downscaled variant for a cap a `mid`/
 *  `low` tier names. Its row explains itself — see `qualityTiersModel.ts`.
 *
 *  The DECISIONS — the row table, the paths, seeding, remove-by-omission — live in
 *  `qualityTiersModel.ts` and are unit-tested there; this file only renders them. */

import React from 'react';
import { Tooltip, BufferedNumberInput } from './fields';
import {
  type TierRenderOverrides,
  type PostFXEffect,
} from '../../runtime/rendering/qualityTier';
import {
  MATRIX_GROUPS,
  type MatrixRow,
  type TieredKey,
  authoredTiersOf,
  withAuthoredTiers,
  readRenderingPath,
  writeRenderingPath,
  addTier,
  removeTier,
  withField,
  withPostFX,
} from './qualityTiersModel';

/** Weakest LAST, so the columns read left-to-right as "full quality, then what each weaker band
 *  gives up" — the direction the author is actually thinking in. (`TIER_ORDER` in the runtime is
 *  weakest-first because promotion walks it; that is a different question.) */
const TIER_COLUMNS: readonly TieredKey[] = ['mid', 'low'];

const TIER_LABELS: Record<TieredKey, string> = { mid: 'Mid', low: 'Low' };

const wrap: React.CSSProperties = {
  overflowX: 'auto', border: '1px solid #333', borderRadius: 4, background: '#15151f',
};
const table: React.CSSProperties = {
  borderCollapse: 'collapse', width: '100%', minWidth: 620, fontSize: 12, color: '#ddd',
};
const th: React.CSSProperties = {
  padding: '7px 10px', textAlign: 'left', background: '#181826', borderBottom: '1px solid #444',
  fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#aaa', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = {
  padding: '6px 10px', borderBottom: '1px solid #232330', verticalAlign: 'middle',
};
const groupTd: React.CSSProperties = {
  ...td, background: '#171724', color: '#7a7a9a', fontSize: 10.5,
  textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #333',
};
const numberInput: React.CSSProperties = {
  width: 84, boxSizing: 'border-box', padding: '2px 6px', background: '#0d0d14', color: '#ddd',
  border: '1px solid #444', borderRadius: 3, fontFamily: 'monospace', fontSize: 11.5,
};
const noteCell: React.CSSProperties = { ...td, color: '#666', whiteSpace: 'nowrap' };
const removeBtn: React.CSSProperties = {
  padding: '1px 7px', border: '1px solid #663', borderRadius: 3, background: '#2a2020',
  color: '#e88', cursor: 'pointer', fontFamily: 'monospace', fontSize: 10,
  textTransform: 'none', letterSpacing: 0, marginLeft: 8,
};
const addBtn: React.CSSProperties = {
  padding: '2px 10px', border: '1px dashed #555', borderRadius: 3, background: 'transparent',
  color: '#999', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
  textTransform: 'none', letterSpacing: 0, width: '100%',
};

/** The little (i) that carries a row's measurement. A SPAN inside the Tooltip, not a `title=` —
 *  Electron does not render native title tooltips at all (they are silently absent, not merely
 *  ugly), so every hover explanation in this editor goes through this component. */
function Info({ text }: { text: string }) {
  return (
    <Tooltip text={text} style={{ marginLeft: 6, display: 'inline-flex', verticalAlign: 'middle' }}>
      <span
        aria-label="details"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 14, height: 14, borderRadius: '50%', border: '1px solid #555',
          color: '#666', fontSize: 9, lineHeight: 1, userSelect: 'none',
        }}
      >i</span>
    </Tooltip>
  );
}

/** One cell of a TIER column. `undefined` cfg means the tier is not authored — the cell is inert
 *  rather than absent, so the row keeps its shape and a setting never appears to move between
 *  columns when a tier is added or removed. */
function TierCell({ row, cfg, onChange, tier }: {
  row: MatrixRow;
  cfg: TierRenderOverrides | undefined;
  onChange: (next: TierRenderOverrides) => void;
  tier: TieredKey;
}) {
  if (!cfg) return <td style={{ ...td, color: '#3a3a4a' }}>—</td>;
  const uiId = `quality-tiers.field.${tier}.${row.field}`;

  if (row.kind === 'postfx') {
    const effect = row.field as PostFXEffect;
    return (
      <td style={td}>
        <input type="checkbox" data-ui-id={uiId} checked={Boolean(cfg.postFX?.[effect])}
          onChange={(e) => onChange(withPostFX(cfg, effect, e.target.checked))} />
      </td>
    );
  }

  const field = row.field as keyof Omit<TierRenderOverrides, 'postFX'>;
  if (row.kind === 'checkbox') {
    return (
      <td style={td}>
        <input type="checkbox" data-ui-id={uiId} checked={Boolean(cfg[field])}
          onChange={(e) => onChange(withField(cfg, field, e.target.checked as never))} />
      </td>
    );
  }
  return (
    <td style={td}>
      {/* See DefaultCell below for why this is BufferedNumberInput and not `type="number"`. */}
      <BufferedNumberInput style={numberInput} dataUiId={uiId} step={row.step} value={Number(cfg[field] ?? 0)}
        onChange={(v) => onChange(withField(cfg, field, v as never))} />
    </td>
  );
}

/** One cell of the DEFAULT column — a real project field, or a note saying what governs it when
 *  there is no project-level value to edit (see `MatrixRow.defaultNote`). */
function DefaultCell({ row, rendering, onChange }: {
  row: MatrixRow;
  rendering: unknown;
  onChange: (next: unknown) => void;
}) {
  if (row.defaultPath === null) return <td style={noteCell}>{row.defaultNote}</td>;
  const uiId = `quality-tiers.field.default.${row.field}`;
  const value = readRenderingPath(rendering, row.defaultPath);
  const set = (v: unknown) => onChange(writeRenderingPath(rendering, row.defaultPath as string, v));

  if (row.kind === 'checkbox') {
    return (
      <td style={td}>
        <input type="checkbox" data-ui-id={uiId} checked={Boolean(value)}
          onChange={(e) => set(e.target.checked)} />
      </td>
    );
  }
  return (
    <td style={td}>
      {/* ⚠️ `BufferedNumberInput`, NOT a bare `<input type="number">` — A DECIMAL IS OTHERWISE
          UNTYPEABLE, and for these rows that is most of the point. A number input reports
          `value === ''` for an in-progress entry like `1.`, so a handler that commits 0 on empty
          makes React write "0" back over the keystroke: typing `1.5` yields `15` or `5`. That
          hits exactly the fields whose help text asks for a fraction — pixel-ratio cap (1.5),
          hysteresis (0.15), and both IBL-off boosts (×4, 1.25).
          It is also a REGRESSION guard, not just a nicety: the standalone Project Settings field
          this column replaced committed `''` rather than 0, so `rendering.three.pixelRatioCap`
          accepted 1.5 before this matrix existed and must not stop now. `useBufferedValue`
          (panels/fields.tsx) was written for this exact failure in #242. */}
      <BufferedNumberInput style={numberInput} dataUiId={uiId} step={row.step} value={Number(value ?? 0)}
        onChange={(v) => set(v)} />
    </td>
  );
}

export default function QualityTiersEditor({ value, onChange }: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const authored = authoredTiersOf(value);
  const setTiers = (next: Parameters<typeof withAuthoredTiers>[1]) =>
    onChange(withAuthoredTiers(value, next));

  return (
    <div style={wrap}>
      <table style={table}>
        <thead>
          <tr>
            <th style={{ ...th, color: '#7a7a9a' }}>Setting</th>
            <th style={th}>Default</th>
            {TIER_COLUMNS.map((tier) => (
              <th key={tier} style={th}>
                {authored[tier] ? (
                  <>
                    {TIER_LABELS[tier]}
                    {/* Add/Remove lives in the COLUMN HEADER, not in a row at the foot of the
                        table: at 20 rows the foot is off-screen exactly when the matrix is worth
                        using, and the control belongs with the thing it adds or removes. */}
                    <button style={removeBtn} data-ui-id={`quality-tiers.remove.${tier}`}
                      onClick={() => setTiers(removeTier(authored, tier))}>Remove</button>
                  </>
                ) : (
                  <button style={addBtn} data-ui-id={`quality-tiers.add.${tier}`}
                    onClick={() => setTiers(addTier(authored, tier))}>+ Add {TIER_LABELS[tier]}</button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MATRIX_GROUPS.map((group) => (
            <React.Fragment key={group.title}>
              <tr>
                <td style={groupTd} colSpan={2 + TIER_COLUMNS.length}>
                  {group.title}
                  {group.note && (
                    <span style={{ textTransform: 'none', letterSpacing: 0, color: '#5a5a70', marginLeft: 8 }}>
                      — {group.note}
                    </span>
                  )}
                </td>
              </tr>
              {group.rows.map((row) => (
                <tr key={row.field}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {row.label}
                    <Info text={row.help} />
                  </td>
                  <DefaultCell row={row} rendering={value} onChange={onChange} />
                  {TIER_COLUMNS.map((tier) => (
                    <TierCell key={tier} row={row} tier={tier} cfg={authored[tier]}
                      onChange={(next) => setTiers({ ...authored, [tier]: next })} />
                  ))}
                </tr>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
