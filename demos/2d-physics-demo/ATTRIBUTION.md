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

## Everything else

All scenes, colliders, joints, and UI in this project are authored data created for this
repository. There are no other third-party assets.
