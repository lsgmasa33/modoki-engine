/**
 * Reading a JSON FILE in Node — the ONE implementation (#1799).
 *
 * `fs.readFileSync(p, 'utf8')` keeps a leading UTF-8 byte-order mark (U+FEFF), and `JSON.parse`
 * throws on it. A BOM is not damage: Notepad's "UTF-8 with BOM", PowerShell 5.1's
 * `Set-Content`/`Out-File -Encoding utf8` and the editor's own verbatim undo (#1774 restores the
 * bytes a file had, BOM included) all produce one. So a Node reader that parses the raw text treats
 * a perfectly good file as unreadable, and each caller then does whatever it does with
 * "unreadable" — #1799 observed a prefab dropping out of the asset manifest, and the publish leak
 * scans skipped such a config without checking it. The browser is not affected: a fetch's
 * `text()`/`json()` strip the BOM as part of UTF-8 decoding.
 *
 * Every Node-side parse of a file goes through here; `engine/tests/architecture/
 * jsonFileReadsStripBom.test.ts` fails a reader that parses a raw file read instead. The rule and
 * its reasons: docs/windows.md § "A BOM is a Windows fact, not corruption".
 *
 * Writers are NOT this module's business: an ordinary save writes no BOM (`assetJsonBytes`,
 * `jsonFileBody`), and a verbatim restore keeps the one the file had — harmless once every reader
 * goes through here.
 */
import fs from 'node:fs';

/** `text` without a leading U+FEFF. Only the first character: a BOM anywhere else is content. */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** `JSON.parse` of text read from a file, BOM stripped first. Throws on anything else unparsable. */
export function parseJsonText(text) {
  return JSON.parse(stripBom(text));
}

/** Read and parse a JSON file. Throws when the file is missing or does not parse — use
 *  {@link tryReadJsonFile} where those two mean different things to the caller. */
export function readJsonFile(file) {
  return parseJsonText(fs.readFileSync(file, 'utf8'));
}

/** Read and parse a JSON file, telling ABSENT from UNPARSABLE (#731's rule: a failure to read must
 *  never look like a clean "nothing here"). `absent` is only a missing file (ENOENT/ENOTDIR);
 *  any other read error is `unreadable`. */
export function tryReadJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'absent', error };
    return { ok: false, reason: 'unreadable', error };
  }
  try {
    return { ok: true, value: parseJsonText(text) };
  } catch (error) {
    return { ok: false, reason: 'unparsable', error };
  }
}
