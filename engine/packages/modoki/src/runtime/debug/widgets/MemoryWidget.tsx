/** Memory widget — live JS-heap usage chart (Chromium only). */

import type { CSSProperties } from 'react';
import { Sparkline } from '../Sparkline';
import { useSampledHistory } from '../useSampled';
import { readMemory, MB } from '../perfSources';

const HISTORY = 60;
const SAMPLE_MS = 500;

export function MemoryWidget() {
  const hist = useSampledHistory(() => (readMemory()?.usedJSHeapSize ?? 0) / MB, SAMPLE_MS, HISTORY);
  const mem = readMemory();
  return (
    <div>
      <div style={rowStyle}>
        <span style={labelStyle}>JS Heap</span>
        <span style={valueStyle}>{mem ? `${(mem.usedJSHeapSize / MB).toFixed(1)} MB` : 'n/a'}</span>
      </div>
      {mem ? (
        <Sparkline data={hist} color="#60a5fa" min={0} width={168} height={38} />
      ) : (
        <div style={mutedStyle}>Memory API unavailable (Chromium only).</div>
      )}
    </div>
  );
}

const rowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 };
const labelStyle: CSSProperties = { fontSize: 11, color: '#8b8ba7', textTransform: 'uppercase', letterSpacing: 0.5 };
const valueStyle: CSSProperties = { fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: '#e6e6ff' };
const mutedStyle: CSSProperties = { fontSize: 10, color: '#6b6b85', fontStyle: 'italic' };
