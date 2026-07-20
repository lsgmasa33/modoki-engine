/** Physics collision-layers editor — the widget behind the 'physics-layers'
 *  Project Settings field. Edits `{ layers: string[], collisionMatrix: number[] }`:
 *  a list of up to 16 named layers + a symmetric NxN collision matrix (checkbox grid,
 *  matrix[i] = bitmask of layers i collides with). Toggling cell (i,j) flips both
 *  (i,j) and (j,i) so the matrix stays symmetric. Resolves to Rapier bits at runtime
 *  via physicsLayers.resolveColliderBits. */

const MAX_LAYERS = 16;
const ALL = 0xffff;

export interface PhysicsLayersValue {
  layers: string[];
  collisionMatrix: number[];
}

function normalize(value: unknown): PhysicsLayersValue {
  const v = (value ?? {}) as Partial<PhysicsLayersValue>;
  const layers = Array.isArray(v.layers) && v.layers.length > 0 ? v.layers.slice(0, MAX_LAYERS) : ['Default'];
  const src = Array.isArray(v.collisionMatrix) ? v.collisionMatrix : [];
  const matrix = layers.map((_, i) => (typeof src[i] === 'number' ? (src[i] & ALL) >>> 0 : ALL));
  return { layers, collisionMatrix: matrix };
}

/** Drop bit k from a 16-bit mask and shift higher bits down one (layer removal). */
function removeBit(v: number, k: number): number {
  const low = v & ((1 << k) - 1);
  const high = (v >>> (k + 1)) << k;
  return (low | high) & ALL;
}

const cell: React.CSSProperties = { width: 22, height: 22, textAlign: 'center', padding: 0 };
const hdr: React.CSSProperties = { ...cell, color: '#8a8aa8', fontSize: 10, fontFamily: 'monospace' };
const nameInput: React.CSSProperties = {
  width: 110, boxSizing: 'border-box', padding: '2px 5px', background: '#15151f', color: '#ddd',
  border: '1px solid #444', borderRadius: 3, fontFamily: 'monospace', fontSize: 11,
};
const smallBtn: React.CSSProperties = {
  padding: '2px 8px', border: '1px solid #555', borderRadius: 3, background: '#2a2a40',
  color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
};

export default function PhysicsLayersEditor({ value, onChange }: { value: unknown; onChange: (v: PhysicsLayersValue) => void }) {
  const { layers, collisionMatrix } = normalize(value);

  const emit = (layersNext: string[], matrixNext: number[]) => onChange({ layers: layersNext, collisionMatrix: matrixNext });

  const rename = (i: number, name: string) => {
    // Blanks are allowed transiently (runtime keeps entries by index, so an empty name
    // is a harmless unselectable slot — it never shifts other layers' matrix bits).
    const next = layers.slice(); next[i] = name; emit(next, collisionMatrix);
  };

  const uniqueName = () => {
    let n = layers.length;
    let name = `Layer ${n}`;
    while (layers.includes(name)) name = `Layer ${++n}`;
    return name;
  };

  const toggle = (i: number, j: number) => {
    const m = collisionMatrix.slice();
    if (i === j) { m[i] ^= (1 << i); }
    else { m[i] ^= (1 << j); m[j] ^= (1 << i); }
    m[i] &= ALL; m[j] &= ALL;
    emit(layers, m);
  };

  const addLayer = () => {
    if (layers.length >= MAX_LAYERS) return;
    // New layer collides with everything by default; existing rows already have its
    // bit set (defaults are all-ones), and the new row is all-ones too → symmetric.
    emit([...layers, uniqueName()], [...collisionMatrix, ALL]);
  };

  const removeLayer = (k: number) => {
    if (layers.length <= 1) return; // keep at least one
    const layersNext = layers.filter((_, i) => i !== k);
    const matrixNext = collisionMatrix.filter((_, i) => i !== k).map((row) => removeBit(row, k));
    emit(layersNext, matrixNext);
  };

  const checked = (i: number, j: number) => (collisionMatrix[i] & (1 << j)) !== 0;

  return (
    <div style={{ color: '#ddd', fontSize: 12 }}>
      <div style={{ color: '#aaa', fontSize: 11, marginBottom: 6 }}>
        Layers &amp; collision matrix
        <span style={{ color: '#666', marginLeft: 6 }}>check = the two layers collide</span>
      </div>

      <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
        <table style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...hdr, width: 130, textAlign: 'left' }}></th>
              {layers.map((_, j) => <th key={j} style={hdr} title={layers[j]}>{j}</th>)}
              <th style={hdr}></th>
            </tr>
          </thead>
          <tbody>
            {layers.map((name, i) => (
              <tr key={i}>
                <td style={{ padding: '1px 4px 1px 0', whiteSpace: 'nowrap' }}>
                  <span style={{ color: '#8a8aa8', fontSize: 10, marginRight: 4 }}>{i}</span>
                  <input style={nameInput} value={name} onChange={(e) => rename(i, e.target.value)}
                    disabled={i === 0} title={i === 0 ? "The 'Default' layer can't be renamed" : ''} />
                </td>
                {layers.map((_, j) => (
                  <td key={j} style={cell}>
                    <input type="checkbox" checked={checked(i, j)} onChange={() => toggle(i, j)}
                      title={`${layers[i]} ↔ ${layers[j]}`} />
                  </td>
                ))}
                <td style={cell}>
                  {i !== 0 && (
                    <button style={{ ...smallBtn, padding: '0 5px', color: '#c66' }} title="Remove layer"
                      onClick={() => removeLayer(i)}>×</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button style={smallBtn} onClick={addLayer} disabled={layers.length >= MAX_LAYERS}>+ Add layer</button>
        <span style={{ color: '#666', fontSize: 10 }}>{layers.length}/{MAX_LAYERS}</span>
      </div>
    </div>
  );
}
