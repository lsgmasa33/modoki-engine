/** MeshAssetView — geometry-stats inspector for a `.mesh.json`. Extracted from
 *  Inspector.tsx (editor-inspector.md F2). Awaits the mesh-cache load promise for
 *  stats instead of polling (F9). */

import { useState, useEffect } from 'react';
import { whenMeshTemplate, meshStatsFromTemplate } from '../../../runtime/loaders/meshTemplateCache';
import { InfoRow, Section } from './widgets';
import { MeshPreview } from '../MeshPreview';

export function MeshAssetView({ path }: { path: string }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  // null = not yet resolved; false = permanently failed to load geometry.
  const [meshInfo, setMeshInfo] = useState<{ vertices: number; triangles: number; attributes: string[] } | null | false>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetch(path, { signal: ac.signal })
      .then(r => r.ok ? r.json() : null)
      .then(setData)
      .catch(e => { if (e.name !== 'AbortError') setData(null); });
    return () => ac.abort();
  }, [path]);

  // Resolve mesh template for geometry stats — await the cache load promise
  // instead of polling (F9). Resolves to undefined on permanent failure.
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    setMeshInfo(null);
    whenMeshTemplate(path).then((template) => {
      if (cancelled) return;
      setMeshInfo(template ? meshStatsFromTemplate(template) : false);
    });
    return () => { cancelled = true; };
  }, [data, path]);

  if (!data) return <div style={{ color: '#555', fontSize: '11px', padding: 4 }}>Loading...</div>;

  return (
    <>
      <MeshPreview path={path} />
      <div style={{ marginBottom: 8 }}>
        <InfoRow label="Model" value={data.model as string} />
        <InfoRow label="Mesh" value={data.mesh as string} />
        <InfoRow label="Postprocessor" value={data.postprocessor as string || 'none'} />
      </div>
      {meshInfo && (
        <Section title="Geometry">
          <InfoRow label="Vertices" value={meshInfo.vertices.toLocaleString()} />
          <InfoRow label="Triangles" value={meshInfo.triangles.toLocaleString()} />
          <InfoRow label="Attributes" value={meshInfo.attributes.join(', ')} />
        </Section>
      )}
      {meshInfo === null && (
        <div style={{ color: '#666', fontSize: '10px', padding: '4px 0' }}>Loading geometry info...</div>
      )}
      {meshInfo === false && (
        <div style={{ color: '#c0392b', fontSize: '10px', padding: '4px 0' }}>Failed to load geometry.</div>
      )}
    </>
  );
}
