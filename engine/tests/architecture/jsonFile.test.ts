/**
 * `engine/scripts/jsonFile.mjs` — the one Node-side JSON file read (#1799). A leading UTF-8 BOM is
 * read through; a missing file and a damaged one stay distinguishable.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripBom, parseJsonText, readJsonFile, tryReadJsonFile } from '../../scripts/jsonFile.mjs';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const BOM = '\uFEFF';

function write(name: string, text: string): string {
  const file = path.join(makeScratchDir('modoki-jsonfile-'), name);
  fs.writeFileSync(file, text);
  return file;
}

describe('jsonFile.mjs', () => {
  it('reads a file that starts with a BOM, as Notepad and PowerShell 5.1 write one', () => {
    const file = write('bom.json', `${BOM}{\r\n  "id": "a"\r\n}\r\n`);
    // The premise: Node keeps the BOM, and a raw parse throws on it.
    expect(() => JSON.parse(fs.readFileSync(file, 'utf8'))).toThrow();
    expect(readJsonFile(file)).toEqual({ id: 'a' });
    expect(tryReadJsonFile(file)).toEqual({ ok: true, value: { id: 'a' } });
  });

  it('reads a file with no BOM unchanged', () => {
    expect(readJsonFile(write('plain.json', '{"id":"b"}'))).toEqual({ id: 'b' });
  });

  it('strips only a LEADING BOM — one inside a string is content', () => {
    expect(stripBom(`${BOM}x`)).toBe('x');
    expect(parseJsonText(`{"s":"${BOM}"}`)).toEqual({ s: BOM });
  });

  it('tells a missing file from a damaged one (#731: never a bare "nothing here")', () => {
    const dir = makeScratchDir('modoki-jsonfile-');
    expect(tryReadJsonFile(path.join(dir, 'nope.json'))).toMatchObject({ ok: false, reason: 'absent' });
    expect(tryReadJsonFile(write('bad.json', '{"id": '))).toMatchObject({ ok: false, reason: 'unparsable' });
    expect(tryReadJsonFile(write('empty.json', ''))).toMatchObject({ ok: false, reason: 'unparsable' });
    expect(tryReadJsonFile(dir), 'a directory is there but is not a readable file').toMatchObject({ ok: false, reason: 'unreadable' });
    expect(() => readJsonFile(path.join(dir, 'nope.json'))).toThrow();
  });
});
