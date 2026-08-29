# Model Routing Audit — 2026-08-29

This is the audit behind the Sonnet-delegation triggers in `CLAUDE.md` § "Model routing — Opus is
default, Sonnet is delegated to for implementation".

## Measurement

A token-usage audit across all four worker clones found `opus-reviewer` delegation working as
designed (4–12 calls per 6 sessions each), but `sonnet-implementer` essentially unused (0–1 calls
per 6 sessions, same clones) — hundreds of `grep`/`sed`/`cat` searches and dozens of mechanical
edits per session were running inline on Opus instead, for an Opus share of 73–100% of turns across
clones over that period.

**"Delegate freely" was too soft to survive being mid-task** — so the finding produced two
mechanical triggers instead of a judgement call, so there's nothing left to skip under pressure:

- **About to make a second read-only search in a row** (another `grep`/`sed`/`cat`/`ls` chase, no
  edit yet) → stop, call `Explore` instead of continuing to search inline.
- **About to make the first `Edit`/`Write` after the approach is already decided** (a plan exists, a
  brief could be stated right now) → stop, call `sonnet-implementer` with that brief instead of
  typing the edit yourself.

"But this one's quick" is exactly the reasoning that produced the 73–100% number — it applies to the
next call, not to a category you get to judge case-by-case.
