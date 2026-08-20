/** Argument parsing for `upload-dsyms.mjs`, split out so it can be tested (#279).
 *
 *  It is three lines of logic and it carries two bugs' worth of history, which is why it is not
 *  inline any more:
 *
 *  1. **Uploading must be opt-in.** `npm run upload:dsyms games/court --dry-run` silently loses the
 *     flag — `--dry-run` is one of npm's OWN options, so npm consumes it and the script sees only
 *     the path. Measured: it uploaded for real while the caller believed they had asked for a
 *     preview. So the DESTRUCTIVE direction carries the word (`--upload`), and a flag the runner
 *     swallows can now only ever make the tool safer.
 *  2. **The positional walk is explicit.** `args.find(a => …args.indexOf(a)…)` reports the FIRST
 *     occurrence of a repeated string, so `<dir> --dsym <dir>` read the flag's value as the
 *     project. Rare, and silent when it happens: it would resolve a real project and upload the
 *     wrong thing. */

/** @param {string[]} args argv after the node/script entries
 *  @returns {{ projectArg: string|undefined, doUpload: boolean, dsym: string|undefined }} */
export function parseUploadDsymsArgs(args) {
  let projectArg;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (args[i] === '--dsym') i++; // skip the flag's VALUE, never read it as the project
      continue;
    }
    if (projectArg === undefined) projectArg = args[i];
  }
  const i = args.indexOf('--dsym');
  return {
    projectArg,
    doUpload: args.includes('--upload'),
    dsym: i >= 0 ? args[i + 1] : undefined,
  };
}
