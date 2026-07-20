/** EditorApp layout-name helpers (Missing Tests #3).
 *
 *  Factored out of EditorApp so the Save-Layout-As name sanitization, the
 *  import-from-file base-name derivation, and the layout-JSON guard are testable
 *  without mounting the whole editor. */

import { describe, it, expect } from 'vitest';
import {
  AUTOSAVE_NAME, isLayoutJson, sanitizeLayoutName, deriveLayoutBaseName,
} from '../../src/editor/utils/layoutNames';

describe('isLayoutJson guard', () => {
  it('accepts an object with a top-level layout node', () => {
    expect(isLayoutJson({ layout: {} })).toBe(true);
    expect(isLayoutJson({ layout: { type: 'row' }, global: {} })).toBe(true);
  });
  it('rejects non-layout shapes', () => {
    expect(isLayoutJson(null)).toBe(false);
    expect(isLayoutJson(undefined)).toBe(false);
    expect(isLayoutJson('layout')).toBe(false);
    expect(isLayoutJson(42)).toBe(false);
    expect(isLayoutJson({})).toBe(false);
    expect(isLayoutJson({ notLayout: 1 })).toBe(false);
  });
});

describe('sanitizeLayoutName', () => {
  it('trims and passes a clean name through', () => {
    expect(sanitizeLayoutName('  My Layout 2  ')).toBe('My-Layout-2');
    expect(sanitizeLayoutName('dev-tools')).toBe('dev-tools');
  });
  it('collapses runs of illegal chars to a single dash and trims edge dashes', () => {
    expect(sanitizeLayoutName('a//b\\c')).toBe('a-b-c');
    expect(sanitizeLayoutName('!!weird!!')).toBe('weird');
    expect(sanitizeLayoutName('foo   bar')).toBe('foo-bar');
  });
  it('rejects the reserved autosave name (returns "")', () => {
    expect(sanitizeLayoutName(AUTOSAVE_NAME)).toBe('');
    expect(sanitizeLayoutName('  autosave  ')).toBe('');
  });
  it('returns "" for empty / all-illegal input', () => {
    expect(sanitizeLayoutName('')).toBe('');
    expect(sanitizeLayoutName('   ')).toBe('');
    expect(sanitizeLayoutName('///')).toBe('');
  });
});

describe('deriveLayoutBaseName', () => {
  it('strips the .layout.json / .json extension', () => {
    expect(deriveLayoutBaseName('My Layout.layout.json')).toBe('My-Layout');
    expect(deriveLayoutBaseName('plain.json')).toBe('plain');
    expect(deriveLayoutBaseName('Plain.JSON')).toBe('Plain');
  });
  it('sanitizes illegal chars like sanitizeLayoutName', () => {
    expect(deriveLayoutBaseName('weird name!.layout.json')).toBe('weird-name');
  });
  it('falls back to "imported" for an empty stem', () => {
    expect(deriveLayoutBaseName('.json')).toBe('imported');
    expect(deriveLayoutBaseName('!!!.layout.json')).toBe('imported');
  });
  it('falls back to "imported" when the stem is the reserved autosave name', () => {
    expect(deriveLayoutBaseName('autosave.layout.json')).toBe('imported');
    expect(deriveLayoutBaseName('autosave.json')).toBe('imported');
  });
});
