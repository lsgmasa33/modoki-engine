# Asset Attribution

## Character sprite sheet — `runtime/assets/sprites/player.png`

**Source:** "Running and Jumping Boy Sprite Sheets" by **bevouliin.com**
https://opengameart.org/content/running-and-jumping-boy-sprite-sheets

**License:** [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) (public
domain dedication). No attribution is required; it is given here because credit is deserved.

**Modifications:** the original ships one transparent PNG per frame across three folders
(`running/` ×6, `Jump/` ×2, `Idle/` ×2) at differing canvas sizes. For this project the ten
frames were cropped to their alpha bounds, scaled by a single uniform factor, and packed into
one 1152×640 sheet of uniform 192×320 cells — bottom-aligned so the character's feet share a
baseline in every clip, and centred horizontally. No artwork was redrawn.

Three constraints shaped that packing and are worth preserving if the sheet is ever rebuilt:

- **Cell aspect stays ~0.6** (192×320). The Player's `Renderable2D` is 33×55 with
  `keepAspect: true`, so the cell aspect — not the artwork — determines the character's
  on-screen size. Changing it silently resizes the character.
- **Sheet dimensions are multiples of 4.** Block-compressed KTX2 requires it; non-multiple-of-4
  with mipmaps renders solid black on Adreno GPUs.
- **One uniform scale across all clips.** Per-clip scaling would make the character visibly
  change size when switching between idle, walk and jump.

## App icon — `art/icon-app-master.png`

**Source:** generated 2026-09-10 with [3D AI Studio](https://www.3daistudio.com) (Nano Banana 2
Lite) from a brief written for this repository. Not a third-party asset, and not derived from one.

⚠️ **No CC0 dedication applies to this one.** Every *other* asset in this file carries a CC0
dedication granted by an upstream author. This one has no upstream author to grant anything — it is
machine-generated output commissioned for this project, and the licence position on such output is
the repository owner's to state, not this file's to assume.

**Design:** flat two-colour line art — pale cream on dark navy, one centred subject — deliberately
matching the language of the bundled Modoki icon it replaces, so the six demos read as one suite
rather than six unrelated marks. The flat two-colour treatment is load-bearing rather than
stylistic: Android's **monochrome** adaptive-icon variant is derived from this master by flattening
it to a single channel, which turns any shaded or painterly art to mud.

## Everything else

All scenes, colliders, joints, and UI in this project are authored data created for this
repository. There are no other third-party assets.
