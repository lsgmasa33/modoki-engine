# Testbed — the engine test suite's own project fixture

This is **not a game**, and nothing here is meant to be played or shipped. It is a controlled,
minimal Modoki project that exists so engine tests have something to point at that is neither
`games/` nor `demos/` (#97).

## Why it exists

Engine tests used to reach into real projects — `games/3d-test`'s confetti particle,
`alien-animal`'s animset, `sling`'s `webBasePath`. That coupled them in both directions:

- **A game edit could redden engine tests.** A real project is live content someone is authoring,
  not a controlled input.
- **The engine could not be tested where games do not exist.** The public OSS snapshot
  (`lsgmasa33/modoki-engine`) ships no `games/`, so those tests failed there — and that gate sat
  red and unwatched until #96 wired it up.

The failure that made the case concrete: `assetRefIntegrity.test.ts` guarded itself with
`discoverProjects(root).length > 0`. Shipping two demos into the snapshot flipped that guard
**true**, so the test ran — and then looked for `alien-animal`'s animset, which was not there. The
guard asked *"are there any projects?"* when the test needed *"is this specific asset here?"* A
fixed fixture removes that entire class of question.

## Why it lives here, under `engine/`

The OSS publish manifest already ships all of `engine/`, so this travels to the public snapshot
**by construction** — no exclusion list to maintain, and no chance of it being mistaken for a
shippable game. Rejected: a new repo root (needs `PROJECT_ROOT_DIRS` plus the two configs that
must be hand-synced with it), and living under `games/` (unportable, and it would be published as
though it were a demo).

Consequence worth knowing: it is **not** discovered by `discoverProjects()`, which only enumerates
`PROJECT_ROOT_DIRS` (`games`, `demos`). That is deliberate — a test must point at this fixture
explicitly, which is the whole point — but it also means the editor does not list it under Open
Project.

## Rules for changing it

- **It ships publicly.** Every asset here must be owned or trivially synthetic. Never copy an asset
  in from `games/` — that licensing exposure is exactly what the snapshot exists to prevent.
- **Minimal and synthetic beats pretty.** The job is covering asset *kinds* (scene, prefab, mesh,
  material, texture, particle, animset, audio, font), not looking good. A two-triangle mesh wins.
- **It is a fixture, not a playground.** Tests assert on these values; changing a GUID, an entity
  name, or `webBasePath` breaks tests elsewhere. Grep before you edit.
- **No native targets** (`ios/`, `android/`, `packages/`). Nothing needs them and they would bloat
  the snapshot.
- Scaffolded with `engine/scripts/scaffold-project.mjs`, so it carries the standard project shape
  (`game.ts` + `project.config.json` + `runtime/`). Keep it that way — a test that relies on the
  standard shape also proves the scaffolder's contract.
