/** Physics collision-layers editor — the widget behind the 'physics-layers'
 *  Project Settings field. Edits `{ layers: string[], collisionMatrix: number[] }`:
 *  a list of up to 16 named layers + a symmetric NxN collision matrix (checkbox grid,
 *  matrix[i] = bitmask of layers i collides with). Toggling cell (i,j) flips both
 *  (i,j) and (j,i) so the matrix stays symmetric. Resolves to Rapier bits at runtime
 *  via physicsLayers.resolveColliderBits. The edit decisions live in physicsLayersMatrix.ts. */

import {
  MAX_LAYERS, normalizePhysicsLayers, toggleLayerPair, addPhysicsLayer, removePhysicsLayer,
  layerPairChecked, type PhysicsLayersValue,
} from './physicsLayersMatrix';

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
  const current = normalizePhysicsLayers(value);
  const { layers, collisionMatrix } = current;

  const rename = (i: number, name: string) => {
    // Blanks are allowed transiently (runtime keeps entries by index, so an empty name
    // is a harmless unselectable slot — it never shifts other layers' matrix bits).
    const next = layers.slice(); next[i] = name; onChange({ layers: next, collisionMatrix });
  };

  const toggle = (i: number, j: number) => onChange({ layers, collisionMatrix: toggleLayerPair(collisionMatrix, i, j) });
  const addLayer = () => { if (layers.length < MAX_LAYERS) onChange(addPhysicsLayer(current)); };
  const removeLayer = (k: number) => { if (layers.length > 1) onChange(removePhysicsLayer(current, k)); };
  const checked = (i: number, j: number) => layerPairChecked(collisionMatrix, i, j);

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
                  <input data-ui-id={`physicsLayers.row.${i}.name`} data-ui-kind="field" data-ui-label={`layer ${i} name`} style={nameInput} value={name} onChange={(e) => rename(i, e.target.value)}
                    disabled={i === 0} title={i === 0 ? "The 'Default' layer can't be renamed" : ''} />
                </td>
                {layers.map((_, j) => (
                  <td key={j} style={cell}>
                    <input data-ui-id={`physicsLayers.cell.${i}.${j}`} data-ui-kind="toggle" data-ui-label={`${layers[i]} vs ${layers[j]}`} data-ui-state={checked(i, j) ? 'checked' : 'unchecked'} type="checkbox" checked={checked(i, j)} onChange={() => toggle(i, j)}
                      title={`${layers[i]} ↔ ${layers[j]}`} />
                  </td>
                ))}
                <td style={cell}>
                  {i !== 0 && (
                    <button data-ui-id={`physicsLayers.row.${i}.remove`} data-ui-kind="button" data-ui-label="Remove layer" style={{ ...smallBtn, padding: '0 5px', color: '#c66' }} title="Remove layer"
                      onClick={() => removeLayer(i)}>×</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button data-ui-id="physicsLayers.footer.add" data-ui-kind="button" data-ui-label="Add layer" style={smallBtn} onClick={addLayer} disabled={layers.length >= MAX_LAYERS}>+ Add layer</button>
        <span style={{ color: '#666', fontSize: 10 }}>{layers.length}/{MAX_LAYERS}</span>
      </div>
    </div>
  );
}
