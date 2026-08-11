/** Variable-font instancing (runs in Node — dev server + build).
 *
 *  Pins a variable font's axes to fixed values, producing a static instance whose
 *  outlines ARE the requested weight/width/etc. Both font paths need this and neither
 *  can do it itself:
 *
 *   - **baked** — `msdf-atlas-gen -varfont <file>?wght=700` is a SILENT NO-OP in our
 *     build: the flag is accepted, exit code 0, no warning, and the atlas comes out
 *     BYTE-IDENTICAL to a plain `-font` bake (measured; see docs/fonts.md
 *     §3). So the bake is fed an already-instanced file via plain `-font`, and
 *     `buildAtlasGenArgs` must never grow a `-varfont` (guarded in fontConvert.test.ts).
 *   - **dynamic** — `@zappar/msdf-generator`'s options carry no axis coordinates at all,
 *     and it rasterizes raw font bytes with no CSS/canvas rasterizer to borrow instancing
 *     from. It is handed the instanced bytes instead of the source.
 *
 *  Implemented as direct glue over harfbuzzjs's `harfbuzz-subset.wasm` rather than a
 *  wrapper: the package's typed API is shaping-only, and `subset-font` REQUIRES a subset
 *  charset — which would be wrong here (see "keep everything" below). The wasm has zero
 *  imports (no WASI/emscripten env), so instantiation is a bare `instantiate(mod, {})`.
 *
 *  WASM, not the native `hb-subset` binary, deliberately: no third bundled binary per
 *  platform and no PATH prerequisite (unlike toktx/msdf-atlas-gen), and it behaves
 *  identically on Windows. Verified equivalent — the glue's output bakes to an atlas
 *  byte-identical to the native CLI's.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

/** Axis tag → pinned value, e.g. `{ wght: 700 }` or `{ wght: 600, SHRP: 40 }`. Tags are
 *  raw OpenType axis tags as they appear in the font's `fvar` table. */
export type FontVariationAxes = Record<string, number>;

/** One axis a font actually exposes — the range the Font Inspector offers. */
export interface FontAxisInfo {
  tag: string;
  min: number;
  /** The value used when nothing is pinned. Often NOT 400: Geologica defaults to
   *  wght 100 (Thin) and Nunito to 200 (ExtraLight) — the bug that motivated all this. */
  def: number;
  max: number;
}

export function hasAxes(axes: FontVariationAxes | undefined): axes is FontVariationAxes {
  return !!axes && Object.keys(axes).length > 0;
}

/** Parse the `fvar` table directly — cheap, dependency-free, and it lets us name the
 *  available axes in an error instead of surfacing harfbuzz's bare failure. Returns []
 *  for a static font (no `fvar`) or anything unparseable. */
export function readFontAxes(bytes: Uint8Array): FontAxisInfo[] {
  try {
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numTables = b.readUInt16BE(4);
    let fvar = 0;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (b.toString('latin1', rec, rec + 4) === 'fvar') { fvar = b.readUInt32BE(rec + 8); break; }
    }
    if (!fvar) return [];
    const axesOff = fvar + b.readUInt16BE(fvar + 4);
    const axisCount = b.readUInt16BE(fvar + 8);
    const axisSize = b.readUInt16BE(fvar + 10);
    const out: FontAxisInfo[] = [];
    for (let i = 0; i < axisCount; i++) {
      const o = axesOff + i * axisSize;
      out.push({
        tag: b.toString('latin1', o, o + 4),
        // Fixed 16.16 throughout fvar.
        min: b.readInt32BE(o + 4) / 65536,
        def: b.readInt32BE(o + 8) / 65536,
        max: b.readInt32BE(o + 12) / 65536,
      });
    }
    return out;
  } catch {
    return [];
  }
}

const HB_MEMORY_MODE_WRITABLE = 2;

/** 4-char axis tag → the uint32 harfbuzz expects. */
function tagToInt(tag: string): number {
  if (tag.length !== 4) throw new Error(`[font-instance] axis tag must be exactly 4 characters: "${tag}"`);
  return [...tag].reduce((a, c) => (a << 8) + c.charCodeAt(0), 0) >>> 0;
}

/** Minimal structural types for the two WebAssembly calls this module makes. Declared
 *  locally rather than relying on the ambient `WebAssembly` namespace: this file is
 *  Node-side build code, and the program that typechecks `engine/plugins/**` has no DOM
 *  lib (where those types live) — @types/node does not supply them either. */
interface WasmMemory { buffer: ArrayBuffer }
interface WasmModule { readonly __wasmModule?: unique symbol }
interface WasmInstance { exports: Record<string, unknown> }
interface WasmApi {
  compile(bytes: Uint8Array): Promise<WasmModule>;
  instantiate(mod: WasmModule, imports: Record<string, unknown>): Promise<WasmInstance>;
}
const wasm = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly;

interface HbExports {
  memory: WasmMemory;
  malloc(n: number): number;
  free(p: number): void;
  hb_blob_create(data: number, len: number, mode: number, userData: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, lenOut: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_keep_everything(input: number): void;
  hb_subset_input_pin_axis_location(input: number, face: number, tag: number, value: number): number;
  hb_subset_or_fail(face: number, input: number): number;
  _initialize?(): void;
}

let hbPromise: Promise<HbExports> | null = null;

/** A base path for `createRequire`, valid in BOTH module systems.
 *
 *  ⚠️ `createRequire(import.meta.url)` alone is a trap here. This module is reached from
 *  two very different contexts — the Vite/vite-node ESM graph (where `import.meta.url` is
 *  set) and the Electron backend bundle, which is CJS and leaves it **undefined**. Passing
 *  undefined throws `The argument 'filename' must be a file URL object, file URL string,
 *  or absolute path string`, and the failure is invisible until something actually calls
 *  it: font instancing worked in dev and died the moment `editorBackendRouter` imported
 *  this module, because that pulled it into the CJS bundle. The packaged editor would
 *  have hit the same wall with no import at all. */
function requireBase(): string {
  const metaUrl: string | undefined =
    typeof import.meta !== 'undefined' ? (import.meta as { url?: string }).url : undefined;
  if (metaUrl) return metaUrl;
  // CJS bundle: __dirname is real. createRequire wants a FILE path, not a directory.
  if (typeof __dirname === 'string' && __dirname) return path.join(__dirname, 'noop.cjs');
  return path.join(process.cwd(), 'noop.cjs');
}

/** Locate `harfbuzz-subset.wasm` inside the installed harfbuzzjs package. Resolved via
 *  the package ENTRY (its `exports` map deliberately hides `./package.json`, so the usual
 *  resolve-the-manifest trick does not work); the wasm sits beside it in `dist/`. */
function wasmPath(): string {
  const req = createRequire(requireBase());
  return path.join(path.dirname(req.resolve('harfbuzzjs')), 'harfbuzz-subset.wasm');
}

/** Instantiate once per process and memoize — the module is stateless between calls. */
function loadHarfbuzz(): Promise<HbExports> {
  if (hbPromise) return hbPromise;
  hbPromise = (async () => {
    const mod = await wasm.compile(fs.readFileSync(wasmPath()));
    const inst = await wasm.instantiate(mod, {}); // zero imports
    const e = inst.exports as unknown as HbExports;
    e._initialize?.(); // emscripten reactor init
    return e;
  })();
  return hbPromise;
}

/** For tests — drop the memoized module. */
export function __resetHarfbuzz(): void { hbPromise = null; }

/**
 * Pin `axes` on `srcBytes`, returning a static-instance font.
 *
 * Every glyph and table is retained (`hb_subset_input_keep_everything`) — this instances,
 * it does NOT subset. Subsetting would be wrong in both directions: a dynamic font exists
 * precisely to render arbitrary Unicode, and a baked font's `.ttf` is shipped only when a
 * DOM consumer (`UIElement.fontFamily`) needs it — and that consumer needs the FULL
 * charset, not the atlas's. Trimming to the atlas charset would silently break DOM text.
 *
 * Throws when an axis is absent from the font (naming the ones it does have) rather than
 * quietly producing the default instance — the failure mode that makes `-varfont` useless.
 */
export async function instanceFont(srcBytes: Uint8Array, axes: FontVariationAxes): Promise<Uint8Array> {
  if (!hasAxes(axes)) return srcBytes;

  const available = readFontAxes(srcBytes);
  if (available.length === 0) {
    throw new Error(
      `[font-instance] cannot pin ${Object.keys(axes).join(', ')}: the font has no fvar table (it is not a variable font)`,
    );
  }
  for (const tag of Object.keys(axes)) {
    tagToInt(tag); // reject a malformed tag up front, with a clearer message than "not found"
    if (!available.some((a) => a.tag === tag)) {
      throw new Error(
        `[font-instance] axis "${tag}" is not in this font. Available: ` +
        available.map((a) => `${a.tag} (${a.min}..${a.max}, default ${a.def})`).join(', '),
      );
    }
  }

  // Pin EVERY axis the font has — the requested value where given, its own default
  // otherwise — so the result is fully static. Pinning only the named axes leaves the
  // rest variable, which buys nothing here (both rasterizers ignore axes entirely, so an
  // unpinned axis just silently sits at its default) while carrying the variation tables
  // and leaving "which instance is this?" ambiguous downstream.
  const pins: FontVariationAxes = {};
  for (const a of available) pins[a.tag] = axes[a.tag] ?? a.def;

  const e = await loadHarfbuzz();
  // The heap view is invalidated whenever wasm memory grows — re-read it after any malloc.
  const heap = () => new Uint8Array(e.memory.buffer);

  const fontPtr = e.malloc(srcBytes.byteLength);
  if (!fontPtr) throw new Error('[font-instance] malloc failed for the source font');
  heap().set(srcBytes, fontPtr);

  const blob = e.hb_blob_create(fontPtr, srcBytes.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0);
  const face = e.hb_face_create(blob, 0);
  e.hb_blob_destroy(blob);

  const input = e.hb_subset_input_create_or_fail();
  if (!input) { e.hb_face_destroy(face); e.free(fontPtr); throw new Error('[font-instance] hb_subset_input_create_or_fail returned 0'); }

  try {
    e.hb_subset_input_keep_everything(input);
    for (const [tag, value] of Object.entries(pins)) {
      if (!e.hb_subset_input_pin_axis_location(input, face, tagToInt(tag), value)) {
        throw new Error(`[font-instance] harfbuzz refused to pin ${tag}=${value}`);
      }
    }
    const outFace = e.hb_subset_or_fail(face, input);
    if (!outFace) throw new Error(`[font-instance] hb_subset_or_fail returned 0 for axes ${JSON.stringify(axes)}`);
    try {
      const outBlob = e.hb_face_reference_blob(outFace);
      try {
        const dataPtr = e.hb_blob_get_data(outBlob, 0);
        const len = e.hb_blob_get_length(outBlob);
        if (!dataPtr || !len) throw new Error('[font-instance] instanced face produced an empty blob');
        // Copy OUT of wasm memory before anything is freed.
        return new Uint8Array(heap().subarray(dataPtr, dataPtr + len));
      } finally { e.hb_blob_destroy(outBlob); }
    } finally { e.hb_face_destroy(outFace); }
  } finally {
    e.hb_subset_input_destroy(input);
    e.hb_face_destroy(face);
    e.free(fontPtr);
  }
}
