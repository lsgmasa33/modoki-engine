/** `since`, in ONE base wording (#1559 C-6, conventions §2). It meant a seq cursor on the editor
 *  journal and `wait_for_edit` but an epoch-ms timestamp on `get_console_logs`, and the difference hid
 *  behind the PER_TOOL_MEANING pardon. Every `since` is now a forward cursor over a reply's `seq`s and
 *  hands the next one back as `nextSeq`; each tool appends only what is its own. */
export const SINCE_CURSOR_BASE = 'Forward cursor (a prior `seq`/`nextSeq`): only entries after it';

/** `epoch`, in ONE wording: every `since` cursor comes back with the identity of the counter it
 *  counts, because a reload restarts `seq` and a cursor's value alone cannot see that once the new
 *  counter has passed it (#1559 review — the console ring dropped the boot lines of the reload a
 *  game-code edit caused). */
export const EPOCH_BASE = 'The `epoch` returned with the cursor; send it back with the cursor (a stale one replays from the start: `cursorReset`)';
