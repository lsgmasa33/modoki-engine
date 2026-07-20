/** Shared leaf widgets + small helpers used by the Inspector trait sections AND
 *  the asset-inspector sub-editors (Mesh/Material/AnimSet/Texture/Model).
 *
 *  These were extracted out of Inspector.tsx (editor-inspector.md F2) so the four
 *  asset views could move into their own files without dragging the whole panel —
 *  they're pure presentational widgets with no dependency on the panel shell.
 *  Inspector.tsx re-imports them so behavior is unchanged. */

import { useState, useCallback } from 'react';
import ContextMenu, { type ContextMenuItem } from '../../components/ContextMenu';
import type { FieldHint } from '../../../runtime/ecs/traitRegistry';
import { backendFetch } from '../../backend/editorBackend';
import {
  useBufferedValue, parseNumber, clampRange, Tooltip, inputStyle, readOnlyFieldStyle, MIXED_PLACEHOLDER,
} from '../fields';

/** Single source of truth for the per-type color default (F11). White, not 0/black,
 *  so a newly-bound color `set`-value / un-set material color isn't a surprise
 *  0x000000 — every color fallback references DEFAULT_COLOR so they can't drift. */
export const DEFAULT_COLOR = 0xffffff;

/** Wrap a field label with tooltip if hint has one */
export function FieldLabel({ label, hint, style }: { label: string; hint?: FieldHint; style?: React.CSSProperties }) {
  // Pass the layout `style` (flex:1 / width) to the Tooltip's OWN wrapper span — it's
  // the flex child. Putting it on an inner span (with Tooltip wrapping) left the flex
  // child un-styled → content-width, so tooltip'd labels (e.g. marginTop) misaligned
  // with their tooltip-less siblings. Tooltip spreads `style` onto its span.
  if (hint?.tooltip) return <Tooltip text={hint.tooltip} style={style}>{label}</Tooltip>;
  return <span style={style}>{label}</span>;
}

/** Fire-and-forget POST to /api/write-meta with a loud failure log. Replaces
 *  the swallow-catch pattern (`.catch(() => {})`) that hid dev-server outages
 *  — the user would update a field, see it apply locally, reload, and find
 *  the change reverted silently. */
export function writeMetaOrWarn(path: string, meta: unknown): void {
  backendFetch('/api/write-meta', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, meta }),
  }).then(async (res) => {
    if (!res.ok) console.error(`[Inspector] /api/write-meta failed for ${path}: ${res.status} ${await res.text().catch(() => '')}`);
  }).catch((e) => {
    console.error(`[Inspector] /api/write-meta network error for ${path}:`, e);
  });
}

export function NumberField({ label, value, onChange, step = 0.1, readOnly = false, wide = false, overrideColor = false, hint, mixed = false }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; readOnly?: boolean; wide?: boolean; overrideColor?: boolean; hint?: FieldHint; mixed?: boolean;
}) {
  // Enforce the hint's declared min/max on commit (previously display-only — see
  // BufferedNumberInput). Clamp in `parse` so a typed out-of-range value is capped.
  const parse = useCallback((s: string) => clampRange(parseNumber(s), hint?.min, hint?.max), [hint?.min, hint?.max]);
  const { localValue, onFocus, onBlur, handleChange } = useBufferedValue(value, onChange, parse, mixed);
  // A fully-bounded field (both min AND max declared) gets a drag slider — the
  // range IS the affordance ("how far along the scale"), far more legible than a
  // bare number for effect knobs (glow/weight/opacity). Slider drives the same
  // buffered/clamped commit path; the number box stays for exact entry.
  const bounded = !readOnly && hint?.min !== undefined && hint?.max !== undefined;
  // sliderStep is only consumed inside the `bounded &&` block below (where min/max
  // ARE defined), so guard the derived-step math on `bounded` — a hint-less field
  // (most material knobs) would otherwise deref hint!.max and crash the Inspector.
  const sliderStep = hint?.step ?? (bounded ? Math.max((hint!.max! - hint!.min!) / 100, 0.001) : step);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
      <FieldLabel label={label} hint={hint} style={{ ...(bounded ? { width: 92, flexShrink: 0 } : wide ? { flex: 1 } : { width: 16 }), color: overrideColor ? '#5dade2' : '#888', fontSize: '11px', fontWeight: overrideColor ? 'bold' : 'normal' }} />
      {bounded && (
        <input
          type="range"
          min={hint!.min} max={hint!.max} step={sliderStep}
          value={mixed ? hint!.min! : parseNumber(localValue)}
          onChange={(e) => handleChange(e.target.value)}
          style={{ flex: 1, minWidth: 0, accentColor: '#5dade2', cursor: 'pointer' }}
        />
      )}
      <input
        type="number"
        value={readOnly ? value.toFixed(3) : localValue}
        placeholder={mixed ? MIXED_PLACEHOLDER : undefined}
        step={step}
        readOnly={readOnly}
        onFocus={onFocus}
        onBlur={onBlur}
        onDoubleClick={(e) => (e.target as HTMLInputElement).select()}
        onChange={(e) => handleChange(e.target.value)}
        style={{ ...inputStyle, ...(bounded ? { width: 52, flexShrink: 0 } : { flex: 1 }), color: overrideColor ? '#5dade2' : '#ddd', fontWeight: overrideColor ? 'bold' : 'normal', ...(readOnly ? readOnlyFieldStyle : null) }}
      />
    </div>
  );
}

export function DropdownField({ label, value, options, onChange, hint, mixed = false, disabled = false }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void; hint?: FieldHint; mixed?: boolean; disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
      <FieldLabel label={label} hint={hint} style={{ flex: 1, color: '#888', fontSize: '11px' }} />
      {/* When mixed, the select shows a non-committal placeholder row; picking any
          real option broadcasts it to all selected entities. */}
      <select value={mixed ? '' : value} disabled={disabled} onChange={(e) => { if (e.target.value !== '') onChange(e.target.value); }} style={{ ...inputStyle, flex: 1, cursor: disabled ? 'not-allowed' : undefined }}>
        {mixed && <option value="">{MIXED_PLACEHOLDER}</option>}
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

/** Format a numeric color into the exact `#rrggbb` string `<input type="color">`
 *  requires. `value.toString(16)` alone breaks on out-of-range (> 0xFFFFFF → 7+
 *  chars), non-integer (fractional hex like `ff8000.8`), or NaN/undefined values,
 *  silently resetting the picker to black. Floor + mask to a valid 24-bit int. */
export function colorToHex(value: number): string {
  return '#' + normalizeColor(value).toString(16).padStart(6, '0');
}

/** Coerce any incoming color number to a valid 24-bit int (see colorToHex). */
export function normalizeColor(value: number): number {
  const n = Number.isFinite(value) ? value : 0;
  return (Math.floor(n) & 0xffffff) >>> 0;
}

/** Alpha (0..1 float) → the 8-bit channel a hex string can carry. */
export function alphaToByte(alpha: number): number {
  const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
  return Math.round(a * 255);
}

/** `#rrggbbaa` — the CSS-ordered form, so a value copied out of the inspector
 *  pastes straight into a stylesheet (or another ColorField). */
export function rgbaToHex(value: number, alpha: number): string {
  return colorToHex(value) + alphaToByte(alpha).toString(16).padStart(2, '0');
}

/** Parse `#rrggbb` / `#rrggbbaa` (leading `#` optional) into a color + optional alpha.
 *  Returns null for anything else, which is what gates the live commit.
 *
 *  3/4-digit CSS shorthand (`#abc`) is deliberately REJECTED: the hex input commits as
 *  you type, and a 3-char buffer is itself a valid shorthand — so typing `#aabbcc` would
 *  commit a bogus `#aaaabb` at the third keystroke. Only the full forms are accepted;
 *  pasting (which jumps straight to 6/8 chars) is unaffected. */
export function parseHexColor(raw: string): { color: number; alpha: number | null } | null {
  const s = raw.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  if (s.length !== 6 && s.length !== 8) return null;
  return {
    color: parseInt(s.slice(0, 6), 16),
    alpha: s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : null,
  };
}

/** Alpha-checkerboard behind the swatch, so a low alpha reads at a glance instead of
 *  only as a number (an `<input type=color>` renders its value fully opaque). */
const CHECKER: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, #4a4a5e 25%, transparent 25%), linear-gradient(-45deg, #4a4a5e 25%, transparent 25%),' +
    'linear-gradient(45deg, transparent 75%, #4a4a5e 75%), linear-gradient(-45deg, transparent 75%, #4a4a5e 75%)',
  backgroundSize: '8px 8px',
  backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0px',
};

const hexInputStyle: React.CSSProperties = {
  ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '10.5px', letterSpacing: '0.02em', textAlign: 'right', padding: '2px 5px',
};

/** RGB color swatch with an always-visible, editable `#rrggbb` hex.
 *
 *  When `alpha`/`onAlphaChange` are supplied the field becomes an RGBA picker: an A
 *  (0..1) slider is appended and the hex grows to `#rrggbbaa`, so a color can be copied
 *  and pasted between pickers alpha-and-all. Colors with no sibling alpha field (a
 *  Light's color, `emissive`, `clearColor`) stay 6-digit — there'd be nowhere to store
 *  the 8th/7th digits. Pasting an 8-digit value into such a field applies the RGB and
 *  drops the alpha, since copying a UI color onto a light is a normal thing to do.
 *
 *  With alpha the row is two lines (label+swatch+slider+readout, then the hex): the five
 *  controls don't fit the inspector's column width on one. */
export function ColorField({ label, value, onChange, mixed = false, alpha, onAlphaChange, alphaMixed = false }: {
  label: string; value: number; onChange: (v: number) => void; mixed?: boolean;
  alpha?: number; onAlphaChange?: (a: number) => void; alphaMixed?: boolean;
}) {
  const hex = colorToHex(value);
  const hasAlpha = typeof alpha === 'number' && !!onAlphaChange;
  const a = hasAlpha ? Math.min(1, Math.max(0, alpha!)) : 1;
  const rgb = normalizeColor(value);

  // Commit a typed/pasted hex. The alpha guard matters: alpha is a float but the hex
  // carries 8 bits, so re-deriving it would drift an authored 0.5 to 0.502 the first
  // time the user touched the RGB half. Only write alpha back when the BYTE actually
  // changed — editing rgb leaves the stored float bit-identical.
  //
  // ...but BOTH equality guards compare against the PRIMARY entity's value, which under
  // a mixed multi-select says nothing about the others. Typing the primary's own hex to
  // normalize a mixed selection would short-circuit to a silent no-op, leaving the other
  // selected entities on their old colors. When mixed, always commit.
  const commitHex = useCallback((raw: string) => {
    const p = parseHexColor(raw);
    if (!p) return;
    if (mixed || p.color !== rgb) onChange(p.color);
    if (hasAlpha && p.alpha !== null && (alphaMixed || alphaToByte(p.alpha) !== alphaToByte(a))) onAlphaChange!(p.alpha);
  }, [rgb, a, hasAlpha, mixed, alphaMixed, onChange, onAlphaChange]);

  const hexText = hasAlpha ? rgbaToHex(value, a) : hex;
  const hexMixed = mixed || (hasAlpha && alphaMixed);
  const identity = useCallback((s: string) => s, []);
  const validate = useCallback((s: string) => parseHexColor(s) !== null, []);
  const { localValue, onFocus, onBlur, handleChange, valid } = useBufferedValue(hexText, commitHex, identity, hexMixed, validate);

  const hexField = (
    <input type="text" spellCheck={false} value={localValue} placeholder={hexMixed ? MIXED_PLACEHOLDER : undefined}
      aria-label={`${label} hex`}
      onFocus={(e) => { onFocus(); e.currentTarget.select(); }} onBlur={onBlur}
      onChange={(e) => handleChange(e.target.value)}
      title={valid ? 'Hex color — copy/paste between pickers' : `Not a hex color — expected #rrggbb${hasAlpha ? ' or #rrggbbaa' : ''}`}
      style={{ ...hexInputStyle, width: hasAlpha ? 92 : 78, ...(valid ? null : { outline: '1px solid #e06c6c', outlineOffset: -1 }) }} />
  );

  return (
    <div style={{ marginBottom: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ flex: 1, color: '#888', fontSize: '11px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ ...CHECKER, position: 'relative', width: 28, height: 20, flex: 'none', borderRadius: 2, overflow: 'hidden', opacity: mixed ? 0.4 : 1 }}>
          <span style={{ position: 'absolute', inset: 0, backgroundColor: `rgba(${(rgb >> 16) & 255}, ${(rgb >> 8) & 255}, ${rgb & 255}, ${a})` }} />
          <input type="color" value={hex} aria-label={`${label} color`}
            onChange={(e) => onChange(parseInt(e.target.value.slice(1), 16))}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, border: 'none', padding: 0, cursor: 'pointer' }} />
        </span>
        {hasAlpha && (
          <>
            <input type="range" min={0} max={1} step={0.01} value={a}
              onChange={(e) => onAlphaChange!(parseFloat(e.target.value))}
              title="Alpha" aria-label={`${label} alpha`}
              style={{ width: 56, flex: 'none', cursor: 'pointer', opacity: alphaMixed ? 0.4 : 1 }} />
            <span style={{ color: '#666', fontSize: '10px', width: 26, textAlign: 'right', flex: 'none' }}>{alphaMixed ? MIXED_PLACEHOLDER : a.toFixed(2)}</span>
          </>
        )}
        {!hasAlpha && hexField}
      </div>
      {hasAlpha && <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 3 }}>{hexField}</div>}
    </div>
  );
}

/** Collapsible sub-section within a trait section (lighter styling than main Section). */
export function SubSection({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginTop: 4, marginBottom: 2 }}>
      <div onClick={() => setOpen(!open)}
        style={{ padding: '2px 0', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ color: '#666', fontSize: '9px' }}>{open ? '▼' : '▶'}</span>
        <span style={{ color: '#999', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{title}</span>
      </div>
      {open && <div style={{ paddingLeft: 4, marginTop: 2 }}>{children}</div>}
    </div>
  );
}

/** A collapsible section. `menuItems` and/or `onRemove` put a `⋮` button in the
 *  header that opens a ContextMenu — and right-clicking anywhere on the header
 *  opens the same menu, matching the gesture Hierarchy/Assets already use.
 *
 *  Remove lives INSIDE that menu (last, danger-styled, behind a separator) rather
 *  than as a bare `✕` in the header: an unlabeled one-click destructive control
 *  sitting a few px from the collapse toggle was far too easy to hit by accident.
 *  Unity puts Remove Component in the same kebab for the same reason. The menu is
 *  also what lets Paste express a disabled state, which a bare icon cannot. */
export function Section({ title, children, defaultOpen = true, onRemove, menuItems }: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  onRemove?: () => void;
  menuItems?: ContextMenuItem[];
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const items: ContextMenuItem[] = [
    ...(menuItems ?? []),
    ...(onRemove
      ? [
          ...(menuItems && menuItems.length > 0 ? [{ label: '', separator: true } as ContextMenuItem] : []),
          { label: `Remove ${title}`, danger: true, onClick: onRemove },
        ]
      : []),
  ];
  const hasMenu = items.length > 0;
  const openMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);
  /** The ⋮ button TOGGLES, and two things have to be true for that to work at all:
   *
   *  1. It fires on mousedown and stops propagation. ContextMenu closes itself from a
   *     document-level mousedown listener and the ⋮ sits outside its ref, so a
   *     click-based open would run AFTER that close and merely reopen the menu.
   *  2. The menu anchors under the BUTTON, not under the cursor. ContextMenu opens at
   *     the point it is given; given the cursor, its top-left corner lands ON the ⋮ and
   *     covers it — the next press then hits the menu instead of the button, so the menu
   *     can never be dismissed from where it was opened. (Reproduces only with real
   *     layout: jsdom reports every getBoundingClientRect as zeroes.)
   *
   *  The header's right-click still opens at the cursor, which is what a context menu
   *  should do — no button sits under the pointer there to be occluded. */
  const toggleMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu((m) => (m ? null : { x: r.left, y: r.bottom + 2 }));
  }, []);
  return (
    <div style={{ borderBottom: '1px solid #333', marginBottom: 2 }}>
      {/* Agent addressing (Enact): the header toggles the section, and a COLLAPSED section
          doesn't render its fields into the DOM at all — so expanding it is a real
          prerequisite for reaching anything inside. `title` is the trait/section name. */}
      <div onClick={() => setOpen(!open)}
        onContextMenu={hasMenu ? openMenu : undefined}
        data-ui-id={`inspector.section.${title}.header`}
        data-ui-kind="toggle"
        data-ui-label={title}
        style={{ padding: '6px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, background: '#2a2a40' }}>
        <span style={{ color: '#888', fontSize: '10px' }}>{open ? '▼' : '▶'}</span>
        <span style={{ fontWeight: 'bold', color: '#ddd', fontSize: '11px', flex: 1 }}>{title}</span>
        {hasMenu && (
          <span
            onMouseDown={toggleMenu}
            // The click still bubbles to the header after mousedown — without this it
            // would toggle the section collapsed behind the menu we just opened.
            onClick={(e) => e.stopPropagation()}
            title={`${title} options`}
            // THE surface that motivated Enact Phase 2: a ~4px glyph with no addressing,
            // which an agent could only reach by measuring pixels off a downscaled JPEG.
            data-ui-id={`inspector.section.${title}.menu`}
            data-ui-kind="menu"
            data-ui-label={`${title} options`}
            // The glyph itself is ~4px wide — without a padded hit box a near-miss
            // falls through to the header and silently COLLAPSES the section
            // instead of opening the menu.
            style={{
              color: '#666', fontSize: '13px', cursor: 'pointer', lineHeight: '14px',
              padding: '2px 5px', marginRight: -2, borderRadius: 3, userSelect: 'none',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#ddd'; e.currentTarget.style.background = '#3a3a5c'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#666'; e.currentTarget.style.background = 'transparent'; }}
          >⋮</span>
        )}
      </div>
      {open && <div style={{ padding: '4px 8px 6px' }}>{children}</div>}
      {menu && hasMenu && (
        <ContextMenu items={items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

export function InfoRow({ label, value, color }: { label: string; value: string; color?: number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', fontSize: '11px' }}>
      <span style={{ color: '#888' }}>{label}</span>
      <span style={{ color: '#ccc', display: 'flex', alignItems: 'center', gap: 4 }}>
        {color !== undefined && (
          <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 2, background: colorToHex(color), border: '1px solid #555' }} />
        )}
        {value}
      </span>
    </div>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export const reimportBtnStyle: React.CSSProperties = {
  width: '100%', padding: '4px 10px', border: '1px solid #555', borderRadius: 3,
  background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontSize: '11px',
  fontFamily: 'monospace',
};
