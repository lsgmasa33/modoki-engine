/** Particle Editor `data-ui-id` namespacing (#287).
 *
 *  Two different things are asserted here, and the split is the point.
 *
 *  1. The MECHANISM (jsdom): `SectionIdContext` + `useFieldId` actually put an id on a
 *     rendered element. `fieldIds.ts` is React-only, so this renders the real code rather
 *     than a mock — importing `ParticleEditor.tsx` instead would drag in three.js, a WebGPU
 *     renderer and the particle backend at module load, and asserting a tag against that
 *     scaffolding would be asserting the mock (docs/editor.md § Panels).
 *
 *  2. The PROPERTY (source scan): that no two SIMULTANEOUSLY-MOUNTED fields resolve to the
 *     same id. This is the half that motivated the section prefix, and it cannot be checked
 *     by rendering one widget — it is a statement about all ~58 call sites at once.
 *
 *  Neither proves the ids reach the LIVE editor DOM — a tag can exist in source, and even
 *  render in jsdom, while a conditional keeps it off screen. `modoki_handles {editor:'chrome'}`
 *  against a running editor is what closes that, and it is why the sibling guard
 *  (engine/tests/editor/chromeTagging.test.ts) documents itself as a source-level tripwire
 *  rather than a proof. */
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render } from '@testing-library/react';
import { SectionIdContext, particleFieldSlug, useFieldId } from '../../src/editor/panels/particle/fieldIds';
import { readScannedSource } from '../helpers/sourceScanner';

const SRC = path.resolve(__dirname, '../../src/editor/panels/ParticleEditor.tsx');

/** Stand-in for the shared widgets, which all do exactly this one thing with the id. */
function Probe({ label }: { label: string }) {
  return <input data-ui-id={useFieldId(label)} readOnly value="" />;
}

describe('particleFieldSlug', () => {
  it('reduces a human label to an address', () => {
    expect(particleFieldSlug('Rate / sec')).toBe('rate-sec');
    expect(particleFieldSlug('Size (w,h,d)')).toBe('size-w-h-d');
    expect(particleFieldSlug('Angle°')).toBe('angle');   // trailing punctuation must not linger
    expect(particleFieldSlug('Spin °/s')).toBe('spin-s');
    expect(particleFieldSlug('Offset X')).toBe('offset-x');
  });
});

describe('the Section context tags a field', () => {
  it('renders <panel>.<region>.<name> for a field inside a section', () => {
    const { container } = render(
      <SectionIdContext.Provider value={particleFieldSlug('Collision')}>
        <Probe label="Mode" />
      </SectionIdContext.Provider>,
    );
    expect(container.querySelector('[data-ui-id]')?.getAttribute('data-ui-id')).toBe('particle.collision.mode');
  });

  it('the SAME label in two sections yields two different ids', () => {
    // The whole reason the namespace is the section and not the label. Render them TOGETHER,
    // because co-mounting is the condition under which a shared id would actually be ambiguous.
    const { container } = render(
      <>
        <SectionIdContext.Provider value="collision"><Probe label="Mode" /></SectionIdContext.Provider>
        <SectionIdContext.Provider value="render"><Probe label="Mode" /></SectionIdContext.Provider>
      </>,
    );
    const ids = [...container.querySelectorAll('[data-ui-id]')].map((e) => e.getAttribute('data-ui-id'));
    expect(ids).toEqual(['particle.collision.mode', 'particle.render.mode']);
  });

  it('leaves a field OUTSIDE any section untagged rather than half-tagged', () => {
    // A 2-segment `particle.mode` would break the <panel>.<region>.<name> shape AND collide
    // across sections. Absent is the honest answer; wrongly-addressable is not.
    const { container } = render(<Probe label="Mode" />);
    expect(container.querySelector('input')?.hasAttribute('data-ui-id')).toBe(false);
  });
});

/** Every `particle.<section>.<label>` the panel's call sites produce, with the sections each
 *  one came from. Read from source because the property is about all call sites at once. */
function idsFromSource(): Map<string, string[]> {
  const chunks = readScannedSource(SRC).code.split(/<Section title="([^"]+)"/);
  const out = new Map<string, string[]>();
  for (let i = 1; i < chunks.length; i += 2) {
    const section = particleFieldSlug(chunks[i]);
    for (const [, label] of chunks[i + 1].matchAll(/label="([^"]+)"/g)) {
      const id = `particle.${section}.${particleFieldSlug(label)}`;
      out.set(id, [...(out.get(id) ?? []), chunks[i]]);
    }
  }
  return out;
}

describe('no two co-mounted Particle Editor fields share an id', () => {
  const ids = idsFromSource();

  it('finds the panel s fields at all (a scan that matches nothing would pass vacuously)', () => {
    // Without this, a refactor renaming `label=` or `<Section title=` turns every assertion
    // below into a statement about the empty set — green, and measuring nothing.
    expect(ids.size).toBeGreaterThan(50);
  });

  it('the only repeated ids are Collision s mutually-exclusive shape branches', () => {
    // Collision renders ONE of plane/sphere/box/cylinder, so its Center/Radius fields never
    // co-mount. Every OTHER repeat would be a genuine ambiguity, so the allowlist is exact:
    // a new duplicate outside these two fails here rather than silently shadowing a field.
    const repeated = [...ids].filter(([, from]) => from.length > 1).map(([id]) => id).sort();
    expect(repeated).toEqual(['particle.collision.center', 'particle.collision.radius']);
  });

  it('the section prefix is load-bearing — 6 labels would collide without it', () => {
    // The claim `fieldIds.ts` makes in prose, measured. "Mode"/"Shape" (Collision + Render)
    // and "Size"/"Opacity" (Start values + Over life) name fields in sections that mount
    // TOGETHER, so a bare `particle.<label>` would resolve to whichever the DOM ordered first.
    const bySuffix = new Map<string, Set<string>>();
    for (const id of ids.keys()) {
      const [, section, name] = id.split('.');
      bySuffix.set(name, (bySuffix.get(name) ?? new Set()).add(section));
    }
    const wouldCollide = [...bySuffix].filter(([, s]) => s.size > 1).map(([n]) => n).sort();
    expect(wouldCollide).toEqual(['axis', 'length', 'mode', 'opacity', 'shape', 'size']);
  });

  it('every id keeps the <panel>.<region>.<name> shape', () => {
    for (const id of ids.keys()) {
      expect(id.split('.').length, `"${id}" needs at least 3 dot segments`).toBeGreaterThanOrEqual(3);
      expect(id, `"${id}" has an empty segment`).not.toMatch(/\.\./);
    }
  });
});
