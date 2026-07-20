/** Engine-module toggles editor — the widget behind the 'module-toggles' Project
 *  Settings field. Edits `build.modules` (a record of `ModuleToggle = 'auto' |
 *  boolean` per engine module). Each row is a tri-state Auto | On | Off:
 *   - Auto ('auto') → detect from the project's included scenes at build time.
 *   - On (true)     → force-include the module.
 *   - Off (false)   → force-exclude it (the bundler DCEs the whole seam).
 *  The value is the whole modules object; onChange writes a merged copy back
 *  (the host persists it to build.modules.* via setByPath). */

type Toggle = 'auto' | boolean;

/** The six modules, in display order, with a short "what it costs" hint drawn
 *  from the measured bundle table (gzipped) so the choice is informed. */
const MODULES: { key: string; label: string; hint: string }[] = [
  { key: 'render3d', label: '3D rendering', hint: 'Three.js / WebGPU (~173 KB)' },
  { key: 'render2d', label: '2D rendering', hint: 'PixiJS (~21 KB)' },
  { key: 'physics2d', label: '2D physics', hint: 'Rapier2D (~635 KB)' },
  { key: 'physics3d', label: '3D physics', hint: 'Rapier3D (~841 KB)' },
  { key: 'npr', label: 'NPR post-FX', hint: 'outline pass — needs 3D' },
  { key: 'gpuParticles', label: 'GPU particles', hint: 'compute backend — needs 3D + WebGPU' },
];

const OPTIONS: { value: Toggle; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: true, label: 'On' },
  { value: false, label: 'Off' },
];

const row: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px',
  border: '1px solid #333', borderRadius: 3, background: '#15151f', marginBottom: 4,
};
const seg: React.CSSProperties = {
  padding: '1px 9px', border: '1px solid #555', borderRadius: 3, background: '#2a2a40',
  color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12, lineHeight: '16px',
};
// Full `border` shorthand (NOT borderColor) — mixing the shorthand from `seg` with a
// non-shorthand borderColor here makes React warn when a segment toggles seg⇄segOn.
const segOn: React.CSSProperties = { ...seg, background: '#2d5a86', color: '#fff', border: '1px solid #4a8' };

/** Normalize a stored value to a tri-state (unknown/missing → 'auto'). */
function normalize(v: unknown): Toggle {
  return v === true || v === false ? v : 'auto';
}

export default function ModuleTogglesEditor({ value, onChange }: {
  value: unknown;
  onChange: (v: Record<string, Toggle>) => void;
}) {
  const modules = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const set = (key: string, v: Toggle) => {
    // Merge onto a fresh copy of the whole modules object so every key persists.
    const next: Record<string, Toggle> = {};
    for (const m of MODULES) next[m.key] = normalize(modules[m.key]);
    next[key] = v;
    onChange(next);
  };

  return (
    <div style={{ color: '#ddd', fontSize: 12 }}>
      <div style={{ color: '#aaa', fontSize: 11, marginBottom: 6 }}>
        Engine modules in the build
        <span style={{ color: '#666', marginLeft: 6 }}>Auto = detect from scenes</span>
      </div>
      {MODULES.map((m) => {
        const cur = normalize(modules[m.key]);
        return (
          <div key={m.key} style={row}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {m.label}
              <span style={{ color: '#666', marginLeft: 6 }}>{m.hint}</span>
            </span>
            {OPTIONS.map((o) => (
              <button key={String(o.value)} style={cur === o.value ? segOn : seg}
                title={m.key} onClick={() => set(m.key, o.value)}>
                {o.label}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
