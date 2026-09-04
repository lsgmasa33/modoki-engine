# Task claiming across clones (GitHub Issues)

**Open work lives in GitHub Issues, not in a file.** Six clones run concurrent Claude
sessions against the same repo, and a git-tracked list can't stop two of them starting the
same task: a `docs/todo.md` entry only crosses clones when someone pushes *and* the other
fetches, so the collision surfaces at merge time — after both sessions have done the work.
Issues are a **live query**, shared by every clone with no sync delay.

This file is the normative ritual. `CLAUDE.md` carries a short pointer to it.

## What goes where

| Kind of thing | Home | Why |
|---|---|---|
| **Open, claimable work** — a bug to fix, a feature to build | **GitHub Issue** | Must be claimable across clones with no sync delay |
| **Closed incident write-up** — root cause, wrong theories, the lesson | **The feature doc** for the subsystem it broke (`prefabs.md`, `scene-loading.md`, …) — NOT `todo.md`, which was cleared of them 2026-08-10 | Code-adjacent, greppable, versioned with the code it describes, and read by whoever next touches that subsystem. An Issue buries it behind search; a todo list buries it under everything else |
| **Declined decision** — considered and rejected, with the trigger to revisit | `docs/todo.md` "Deferred decisions" | Its job is to stop the question being re-litigated; it is not work |
| **Capability backlog** — "what a mature engine has that Modoki doesn't" | `docs/todo.md` "Missing features" | A roadmap, not claimable tasks. Promote an entry to an Issue when it becomes real work |

The rule of thumb: **if a session could start it, it's an Issue. If it's a record of
something, it stays in the repo.**

## The ritual

### 1. At session start, look before you leap

```bash
gh issue list --state open                       # what's open
gh issue list --state open --label "wip/work-ai2"  # what THIS clone already claimed
# what's actually available to an agent right now:
gh issue list --state open --search "-label:needs-owner -label:blocked -label:wip/main -label:wip/work-ai -label:wip/work-ai2 -label:wip/work-ai3 -label:wip/work-qa -label:wip/win"
```

Anything carrying a `wip/*` label is **taken by another session** — pick something else,
or ask the owner. A claim that isn't yours is not an invitation.

Two more labels mean **not claimable**, and exist so the open count reflects real available
work rather than a queue that only grows:

| Label | Means | Don't claim it because |
|---|---|---|
| `needs-owner` | Needs the repo owner's judgement — feel, art direction, difficulty, a product call | No amount of agent work closes it; the issue is *waiting*, not *open* |
| `blocked` | Waiting on another issue to land first (the body names which) | Doing it early does the wrong work — e.g. generating a level cohort before the constraint that filters it |

A third case never reaches the queue at all: a **decision already made** ("considered and
declined", or a watch item with a trigger) belongs in `docs/todo.md` § "Deferred decisions",
not in Issues. Filed as an issue it can only age — nothing can close it, so it inflates the
count forever. If you find one open, move it to `docs/todo.md` **with its trigger to revisit**
and close it `not planned`.

### 2. Claim BEFORE doing any work

The label is the claim. Derive it from the **current branch**, not the directory name:

| Branch | Label | Clone |
|---|---|---|
| `main` | `wip/main` | `~/Projects/modoki` (integration hub) |
| `work-ai` | `wip/work-ai` | `~/Projects/modoki-ai` |
| `work-ai2` | `wip/work-ai2` | `~/Projects/modoki-ai2` |
| `work-ai3` | `wip/work-ai3` | `~/Projects/modoki-ai3` |
| `work-qa` | `wip/work-qa` | `~/Projects/modoki-qa` |
| `win` | `wip/win` | Windows machine |

```bash
gh issue edit <N> --add-label "wip/$(git branch --show-current)"
```

Re-read the issue immediately before claiming — the list you fetched at session start is
already stale. **The race shrinks, it does not vanish:** two sessions claiming in the same
second both succeed, because GitHub has no compare-and-set here. If you find a foreign
`wip/*` label already on an issue you were about to start, that session got there first —
drop it, whatever your local state says.

### 3. Filing a bug: validate first, and say what you tried

**Any issue reporting a defect must record a validation attempt, and its outcome — whatever
label it carries.** This is not scoped to the `bug` label: of 248 issues opened since
2026-08-23, only 156 carry `bug` — 92 don't, and several of those are genuine defects filed
under something else (#571 anti-rollback is `enhancement`; #574 is `needs-owner`; #572 carries
only `court`). A defect filed as `enhancement` is still a defect. Of those same 248, at least
78 came from `/close-out` sibling sweeps, 23 self-declared "read-not-reproduced", and #487
shipped nine items whose own author flagged items 3-9 as unverified. The cost of an
unvalidated finding does not disappear — it moves to the next session, which loads full
context before discovering the bug is not real. This rule puts the cost on the filer, not
the reader.

This is **not** "reproduce or don't file" — a race that cannot be triggered on demand is still
worth filing, and the sweep findings did include real defects (Court payout losses, #536/#555).
The requirement is the attempt and the honest outcome, not a green repro.

An issue's validation must land in one of three states:

| Outcome | What it means | Worked line |
|---|---|---|
| **Observed** | You saw the defect happen, and can cite the evidence | "Observed: `modoki_journal` shows `payout.amount: -4` at tick 812 — see attached line." |
| **Attempted, could not trigger** | You tried to make it fire and it didn't — this is a legitimate filing, not a weaker one | "Attempted: drove the interleaving 20x via `createTestWorld` at seed 7; could not reproduce the double-fire. Filing anyway because the code path is real and the race window is narrow." |
| **Read-only** | You have not run it at all — allowed, but only when declared up front, with the reason | "Read-only (no evidence attempted) — this game has no running fixture on this clone; filing from the code path in `runtime/systems.ts`." |

**The declaration goes on the FIRST LINE of the issue body, not buried** — a reader deciding
whether to pick the ticket up must see it without scrolling past the mechanism and the "why it
matters" first.

The repo's own corpus already does part of this voluntarily — 23 issues in the window above
said "read-not-reproduced" unprompted. This rule makes that universal, and adds the attempt:
a read-only filing needs a *reason*, not just a disclaimer.

### 4. Release a claim you abandon

A stale claim is worse than no claim: it blocks every other clone indefinitely, and nothing
expires it.

```bash
gh issue edit <N> --remove-label "wip/$(git branch --show-current)"
```

Do this whenever you stop without landing — the owner redirects you, the task turns out to
be blocked, or you were wrong about the scope.

### 5. Keep the issue honest while you work

**An issue is a description written before the work — so the work is what tests it.** Comment
on the issue when what you learn changes what it says. Three cases that always warrant one:

- **The premise turned out to be wrong.** Say what is actually true, with the evidence. #35
  described a prefab instance as carrying `UIElement.width` in its `traits`; measured across
  all 29 committed instances, an instance's `traits` holds only `PrefabInstance` — every
  override lives in a sibling `overrides` map. That changed the fix, and a reader of the
  closed issue would otherwise inherit the wrong model of the file format.
- **The scope moved.** Something split out into its own issue, or part of it turned out to be
  a different bug. Link both ways — an issue that quietly grew or shrank is unreviewable.
- **You stopped without landing.** Say why, in the same breath as releasing the claim (step
  4). "Blocked on X" is a useful issue; a silently unclaimed one just looks untouched.

**This is not step 6.** Comment about the ISSUE — its premise, scope, status. The durable
engineering knowledge still goes in the feature doc, because that is what survives the close.

The cheap test: *if the owner read only this issue, would they believe something false?* If
yes, comment. If it is merely more detail, it belongs in the doc or the commit message.

### 6. Close it yourself when the work is done and verified

Two halves, and you need both:

- **Put `Fixes #<N>` in the commit message.** This is what ties the issue to the code
  forever — a reader of either one finds the other.
- **Then close the issue by hand**, once the work is committed AND verified:

```bash
gh issue close <N> --reason completed --comment "Landed in <sha> on <branch>; <how it was verified>."
gh issue edit <N> --remove-label "wip/$(git branch --show-current)"
```

**Do not wait for the merge to close it.** GitHub only auto-closes on a commit reaching the
**default branch** (`main`), and worker clones commit to
`work-ai`/`work-ai2`/`work-ai3`/`work-qa`/`win` — so
relying on the trailer alone leaves finished work sitting in the open list, indistinguishable
from untouched work, until the owner next integrates. That is the stale-checkbox class the
Issues migration existed to kill, reappearing one level up. Closing early costs nothing: the
`Fixes #N` trailer fires later against an already-closed issue as a harmless no-op, and the
link is made either way.

Say **in the close comment** what shipped and how you know — the sha, the branch, and the
gate you ran. "Fixed" is not a close comment. The open/closed bit records *that* it is done;
the comment is the only place recording *that it works*.

Drop the `wip/*` label in the same breath (the command above). A closed issue wearing a live
claim reads as still-owned in every `wip/*` query.

**A closed issue is not integrated work.** It says the work is done and verified on some
branch — the merge into `main` is the owner's separate, deliberate act. If a branch is
dropped or a change reverted, reopen the issue; do not assume closed means shipped.

### 7. Write the incident record before the issue closes

An Issue's value dies when it closes. Before landing a non-trivial fix, put the durable part
— root cause, what the wrong theories were, the lesson — in the **feature doc** it belongs
to, per [doc-conventions.md](./doc-conventions.md). The Issue tracks *that the work happened*;
the repo explains *what was learned*. The best of these write-ups record a diagnosis that was
wrong for a day — see the prefab-persistence and scene-id incidents in
[prefabs.md](./prefabs.md) and [scene-loading.md](./scene-loading.md) — and that content must
not evaporate into a closed ticket.

## Filing new work

```bash
gh issue create --title "..." --body "..."
```

If the issue reports a defect, § 3 above applies: the body's **first line** must record the
validation outcome — observed, attempted but could not trigger, or read-only with the reason.
**`gh issue create` with `--title` and `--body`/`--body-file` consults no issue template** —
`.github/ISSUE_TEMPLATE/bug.yml` only renders in the GitHub web New-Issue chooser (or via
`gh issue create --template "Bug report"`). Since every issue in this repo is filed with the CLI
recipe above, nothing mechanical prompts for the validation line — the filer writes it or it is
absent. Verified against `gh issue create --help`, gh 2.92.0: `-T, --template name   Template name
to use as starting body text`.

Write the body the way the incident write-ups in the feature docs are written — the measured evidence,
the file and line, what was ruled out — not a one-line summary. The detail is what makes an
item actionable months later by a session with none of today's context.

## What this deliberately costs

- **The open backlog is no longer greppable** alongside the code. That's a real loss; step 1's
  `gh issue list` is the mitigation, not a cure.
- **It needs network + `gh` auth.** Offline, fall back to asking the owner rather than guessing
  at what's claimed.
