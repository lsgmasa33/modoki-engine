/** UltraHDR encode helpers — the Node-testable pure bits (the gainmap encode itself
 *  is browser-only). hashBytes drives the prod `?v=<hash>` cache-bust, so its
 *  determinism matters. See docs/asset-inspector-plan.md Phase 4b. */

import { describe, it, expect } from 'vitest';
import { hashBytes, bytesToBase64 } from '../../packages/modoki/src/editor/panels/assetViews/encodeUltraHDR';

describe('hashBytes', () => {
  it('is deterministic + 16 hex chars', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    expect(hashBytes(a)).toBe(hashBytes(new Uint8Array([1, 2, 3, 4, 5])));
    expect(hashBytes(a)).toMatch(/^[0-9a-f]{16}$/);
  });
  it('changes when the bytes change', () => {
    expect(hashBytes(new Uint8Array([1, 2, 3]))).not.toBe(hashBytes(new Uint8Array([1, 2, 4])));
    expect(hashBytes(new Uint8Array([1, 2, 3]))).not.toBe(hashBytes(new Uint8Array([1, 2, 3, 0])));
  });
});

describe('bytesToBase64', () => {
  it('round-trips through atob', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64]);
    const b64 = bytesToBase64(bytes);
    const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });
  it('handles a large buffer (> the 0x8000 fromCharCode chunk)', () => {
    const bytes = new Uint8Array(70000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const back = Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0));
    expect(back.length).toBe(bytes.length);
    expect(back[69999]).toBe(69999 & 0xff);
  });
});
