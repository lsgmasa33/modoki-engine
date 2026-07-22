/**
 * Filter `/api/console-logs` (on stdin) down to genuine renderer errors, one per line.
 * Prints nothing when clean, so the smoke can test with `[ -n "$out" ]`.
 *
 * Replaces a `grep -iE "...|error"` over the raw response. That response is a SINGLE
 * JSON line carrying a `"byLevel":{"log":N,"error":N}` summary, so the word "error" is
 * present whenever the endpoint answers at all — the grep matched the tally, echoed the
 * whole blob, and failed the gate unconditionally. It could not tell a real error from
 * the counter, which made the console assertion useless in both directions.
 */
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    // Unreachable endpoint / truncated body is itself worth failing on — but say so
    // precisely instead of dumping the payload.
    if (raw.trim()) console.log('console-logs response was not JSON (app may have died)');
    process.exit(0);
  }
  const logs = Array.isArray(parsed?.logs) ? parsed.logs : [];
  const bad = logs.filter((l) => l?.level === 'error' || /^\[(uncaught|unhandledrejection)\]/i.test(String(l?.text ?? '')));

  // The ring only holds the last N entries, so byLevel can report errors that scrolled
  // out of `logs`. Surface that rather than silently passing.
  const counted = Number(parsed?.byLevel?.error ?? 0);
  if (bad.length === 0 && counted > 0) {
    console.log(`${counted} error-level entr${counted === 1 ? 'y' : 'ies'} reported by byLevel but outside the returned window — re-run with a larger limit to see them`);
    process.exit(0);
  }

  for (const l of bad.slice(0, 10)) console.log(String(l.text ?? '').replace(/\s+/g, ' ').slice(0, 300));
});
