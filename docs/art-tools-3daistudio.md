# 3D AI Studio (3daistudio.com) — what it does, and what we would use it for

**What this doc is:** a capability reference for the external art-generation service named in
Court's art brief. It exists so a generation session does not start by re-reading marketing pages.

⚠️ **Everything here is read from the vendor's own site and docs on 2026-08-05, not measured by us.**
No asset in this repo has been produced through it yet. Treat every capability below as *claimed*
until a generation actually lands — especially the three in "What we still do not know". Vendor
feature sets and credit costs change; re-check before relying on a number.

Sources: [3daistudio.com](https://www.3daistudio.com/) ·
[docs.3daistudio.com](https://docs.3daistudio.com/) · [/MCP](https://www.3daistudio.com/MCP) ·
[/image-studio](https://www.3daistudio.com/image-studio)

---

## 1. The one-line version

It is a **browser-based generation suite that is not only a 3D tool** — it wraps 15+ third-party
image/video models *and* a set of text-to-3D engines behind one account, one credit balance, and
one node editor. The 2D half ("Image Studio") is a full image generator/editor in its own right.

That matters for us because Court's brief (`docs/plans/court-art-direction.md`) needs both halves:
flat 2D icons and tintable tile masters, **and** five chess pieces that must share one camera and
one light rig — which §A6 solves by going to 3D deliberately.

## 2. Three ways in

| Route | What it is | Why it matters here |
|---|---|---|
| **Web app** | The full editor. Everything below is available here. | The only route with the visual canvas + Flow node editor. |
| **REST API** | Programmatic access to the generation/editing tools. | The route a repo script would use for reproducible regeneration. Endpoints not enumerated in the public docs. |
| **MCP connector** | An MCP server the vendor hosts. Claude Code is a **named supported client**. | ⭐ This is the interesting one — see below. |

### The MCP connector deserves its own note

The vendor runs an MCP server, connected **from their Settings page, per assistant**, over
**OAuth** — "no API keys anywhere", nothing to put in a config file, nothing to leak or rotate, and
revoking from Settings deletes the credential immediately. Claude Code is explicitly listed as
tested ("terminal-first, same toolset. Handy for scripted or repeated asset generation").

Claimed tool coverage: 3D generation (text/image), **image generation, editing, and background
removal**, format conversion, and project/library management. The vendor's pitch is exactly our
workflow — *"make the reference art first, edit it in place, then convert the result to 3D without
leaving the conversation."* Small jobs (images) run immediately; larger jobs (3D) ask for
confirmation first, and cost estimates can be requested before committing.

**The individual MCP tool names are not published.** But the OAuth discovery metadata is public and
answers the question that mattered — **image generation is a first-class scope, not 3D-only**:

```
$ curl https://mcp.3daistudio.com/.well-known/oauth-protected-resource
resource: https://mcp.3daistudio.com/mcp        resource_name: "3D AI Studio MCP"
scopes:   credits:read · generation:3d · generation:image · library:read · projects:write
```

`generation:image` and `credits:read` are the two that make an in-session loop viable: generate and
check the balance without leaving the conversation.

### Connecting it (done on `work-ai`, 2026-08-05)

The endpoint is **not** discoverable from the docs site (`docs.3daistudio.com/mcp` is a 404) — it
was found by probing. `www.3daistudio.com/api/mcp` and `/mcp/sse` both answer 200 but serve
`text/html`; they are pages, not endpoints. The real one 401s with a `WWW-Authenticate: Bearer`
header, which is how you know you have it.

```bash
claude mcp add --transport http --scope local 3daistudio https://mcp.3daistudio.com/mcp
# then, in Claude Code:  /mcp  → 3daistudio → authenticate (browser OAuth)
```

**Local scope on purpose.** The repo's `.mcp.json` is git-tracked and mirrored into
`.cursor/`/`.codex/` by `npm run sync:agent-configs`, and it reaches the public OSS snapshot — so a
personal art-vendor subscription does not belong there. Local scope writes to `~/.claude.json`
under this project only. Promote it with `--scope project` if it should reach every clone.

**Plan coverage:** `MCP Connector (Claude & ChatGPT)` is a listed feature of **Basic and Studio**
alike, so any paid tier covers it. It spends the same monthly credit balance as the web app — the
OAuth approval screen states which credits it will spend. Free tier is 100 credits/month, no card.

## 2a. What the MCP surface ACTUALLY exposes (measured 2026-08-05, 22 tools)

⚠️ **The MCP surface is a SUBSET of the web app — plan against this list, not against §3/§4.**
Absent entirely: style reference, Character Sheet, the 14 style converters, Sketch to Image, Pose
Transfer, Image to Prompt, video, texturing, remesh/rigging/UV, and Flow. If a workflow needs one
of those, it happens in the browser.

> 🔴 **THE RULE (owner, 2026-08-05): when the better path is web-only, SAY SO — do not silently
> take the weaker MCP route.** Hand over a paste-ready prompt *with its settings* (model, aspect
> ratio, resolution, format) and say what to bring back; then carry on with whatever CAN be done
> over MCP rather than blocking on the handoff. The owner has a paid Studio license and a browser,
> so the web app is a first-class option, not a fallback. Quietly downgrading spends credits on a
> worse asset *and* conceals that a better one was available — which is the failure this rule
> exists to prevent.

| Tool | Notes |
|---|---|
| `generate_image_nano_lite` | Nano Banana 2 Lite. **Recommended default for generation. TEXT INPUT ONLY** — no image reference. 5 credits flat, any resolution; up to 4 images/call; `png` available for transparency. |
| `generate_image_gpt` | GPT Image 2. Takes text only for generation. Pick it over Nano when **instruction-following or text-in-image** matters. Cost varies with quality × pixel area (low 3/5/8, medium 6/14/25 at 1K/2K/4K, high 30). |
| `edit_image_gpt` | **Recommended default for EDITS** (use `low` quality). Accepts **up to 10 input images**. |
| `edit_image_nano` | Alternative editor, accepts **up to 14 input images**. 7/10/14/20 credits at 0.5K/1K/2K/4K. |
| `remove_background` | birefnet (1 credit, default) · birefnet-v2 (2) · pixelcut (3, product photos). Outputs PNG/RGBA. |
| `upload_image` | Shows an inline card so the user hands over a local file, returning an `upload:<id>` ref. **Chat attachments are NOT reachable by the other tools**, and images must never be re-encoded from vision — this is the only way in. |
| 3D: `generate_prism_3_1` (35cr, recommended) · `generate_p1` (40cr, **low-poly game-ready quads**) · `generate_hunyuan_3_1` (40cr flat, PBR free) · `generate_meshy_6` (35–40cr, 4K/8K textures, image-only) | All take text, image, or **multiview (2–4 images**; Hunyuan up to 8). |
| `convert_model` · `create_project` · `assign_to_project` · `list_projects` · `list_generations` · `get_generation` · `show_generation` · `list_recent_uploads` · `list_available_models` · `get_credit_balance` | Plumbing. |

**Consequences for the icon/piece work:**

1. **Set consistency runs through `edit_*`, not through generation.** Since generation is text-only,
   the keystone workflow is: generate icon #1 → approve → then `edit_image_gpt` with the approved
   icon as an input image, asking for the next icon *in that exact style*. The 10–14 image inputs
   are the real style-reference mechanism here.
2. **§B3's "generate all seven as one sheet" is still the better first move** — one image, one
   style, sliced locally. It sidesteps cross-call drift entirely. Fall back to per-icon `edit_*`
   only for icons the sheet gets wrong.
3. **Generations are async** — 1–5 minutes, returning a `task_id` to poll with `get_generation`.
4. `output_format: 'png'` exists "only when transparency is needed", which *implies* real alpha but
   does not prove it. `remove_background` is the fallback, and it is cheaper (1 credit) than the
   brief's magenta-keying workaround is laborious.

## 3. Image Studio — the 2D half

The part I was wrong about when I first assumed this was a 3D-only tool.

**Generate** — 15+ models from Google, Black Forest Labs, OpenAI and ByteDance. Up to 4 variations
per run, any aspect ratio, up to 4K, typically 3–10s.

| Model | Credits | Claimed strength |
|---|---|---|
| Flux 2 | 4–6 | photorealism; wants natural-language prompts |
| ImageGen 4 | 4 | detail, realistic lighting |
| Nano Banana / Pro / 2 | 4–14 | Gemini-based; quality/speed tiers |
| GPT-Image-1 / 2 | 2–20 | **text rendering inside images**, complex instruction-following |
| Grok, Qwen | — | also offered |

**Edit** — text-described edits, or **paint a mask for precise inpainting**. Models: Gemini Edit,
Flux Kontext, SeedEdit.

**Convert** — 14 named style converters. Free: Convert Anything (describe any target style),
Stylized 3D Render, Table-top Figurine, Pose Generator, Fantasy Character, Anime, Ghibli, Brick
Figure. Paid: Parts Sheet, Bust Maker, Oil Painting, Comic Panel, **Pixel Art Sprite**, Claymation.
Costs 3 credits (GPT Image 2) to 14 (Nano Banana Pro).

**Consistency tools — the ones that answer "how does a set stay on-style":**
- **Style reference** — upload **1–10 style images** and generate new content matching that look.
- **Image reference** — guide a generation toward a specific subject/composition.
- **Character Sheet** — takes ONE character image and outputs a 4-view turnaround (front/left/
  right/back) as a grid, with a built-in splitter to export the panels separately. 4–12 credits.
  Free accounts can preview but **not download**.

**Also:** Sketch to Image, AI Pose Transfer, Image to Prompt (recover a prompt from an image),
and video (Veo 3, Kling, Seedance).

Output: JPEG, PNG or WebP. Typical cost 2–6 credits per generation.

## 4. The 3D half

**Generation:** Text to 3D · Image to 3D · Sketch to 3D · SVG to 3D · 3D Text · Relief Generator ·
Gaussian Splatting (images → splat).

**Engines behind it:** Meshy, Tripo, Rodin, Hunyuan, Trellis, Seed3D, Hitem3D, plus their own
"Prism".

**Texturing:** Texture Generator · Texture Painter (paint AI textures onto a model) · Material AI ·
**Seamless Texture AI** · PBR Extract AI.

**Mesh processing:** Quad-Remesh (retopology, poly reduction, **automatic LOD generation**) ·
Rigging & Animation · Segmentation · UV Unfold · Mesh Repair · GLB Compression · Format
Conversion · Add Base · 3D Print Export · 3D Stager · Model Spinner.

**Export:** GLB, FBX, OBJ, USDZ, STL, DAE, PLY, 3MF, BLEND.

**Flow** — a node-based canvas for chaining these into a repeatable pipeline, with templates and
sharing. This is the closest thing to "run the same recipe for all five pieces".

**Integrations:** Blender, Unity, Unreal, ZBrush, Maya, Godot. (No Modoki, obviously — GLB is our
road in, and the engine already imports GLB with LOD.)

## 5. Pricing

| Plan | Cost | Credits/mo |
|---|---|---|
| Free | — | 100, no card |
| Basic | $12/mo annual | 1,000 |
| Studio | $23/mo annual | 3,500 |
| Pro | $139/mo annual | 18,000 |

Studio is the tier gated to "all creative and production tools" and faster generation. Note the
free tier's **download restriction on at least Character Sheet** — preview-only — so free is for
evaluating, not for producing committed assets.

## 6. What we would actually use it for in Court

Mapping to `docs/plans/court-art-direction.md`, which holds the brief and the prompts for *what* to
make; this section only says *which tool*. ⚠️ That doc is REFERENCE, not a queue — the art pass is
run iteratively (#58), so take the next item from the owner, not from its order of work:

| Brief item | Route |
|---|---|
| **§A6 five pieces** | The brief already mandates this path: generate one reference sheet, then image-to-3D, then **render all five from one camera in one scene**. That is the whole reason to touch 3D at all — consistency comes from a shared rig, not from five lucky prompts. |
| **§B3 icon set** (undo/reset/erase/hint/rules/close/next) | 2D **Generate** as one sheet, then slice. Flat white masters on transparency — the brief explicitly overrides the lighting clause for these. |
| **§B2 button plate**, §B1 panel | 2D Generate; both are nine-slice. |
| **§A1 stone tile**, §A4 wall stone | **Seamless Texture AI** — both must tile, and "seamless" is a named feature rather than something to pray for in a prompt. |
| **§A5 coin, §B4 medallion, §A3 citizen inlay** | 2D Generate. |
| Style coherence across all of the above | "Approve one keystone, generate the rest against it" — but **via the EDIT tools, not a style-reference field**, if you are working over MCP. See §2a. |

## 7. What we still do not know — check these before committing to it

1. **Transparent-PNG alpha.** Nothing in the public docs confirms true alpha output from Generate.
   The brief's §4.7 already assumes it may not: *ask for transparent PNG; if refused, generate on
   flat magenta `#FF00FF` and key it* — which is how the existing `civilian.png` was made. There is
   also a background-removal tool on the MCP surface, which may be the real answer.
2. **Legibility at 32–48 px.** Every Court acceptance test is at device cell size, and both the
   icons (§B3, "legible at 32 pixels") and the pieces (§A6's non-negotiable silhouette test) live
   or die there. Generators optimise for a 1024px thumbnail. Assume the first pass fails this.
3. ~~Whether image generation is really on the MCP surface.~~ **Answered 2026-08-05** — the OAuth
   metadata declares a `generation:image` scope, and the connector is wired (§2). The *tool names*
   are still unknown until the first authenticated call; what the surface can express (batch size,
   aspect ratio, style-reference upload, alpha) is unverified, and item 1 above may well be
   decided by what that surface exposes rather than by what the web app can do.

## 8. Related

- [plans/court-art-direction.md](./plans/court-art-direction.md) — the **reference** for what Court's
  art should be: the three registers, the validated palette, the camera/light convention, the
  technical constraints, and every per-asset prompt. This doc is only the tool reference beside it.
  ⚠️ Not an execution plan and not up to date on what has landed — see its own header.
- [textures.md](./textures.md) — how a generated PNG becomes a shipped texture: `.meta.json`,
  KTX2/WebP, the multiple-of-4 rule, and the `ui`-vs-`3d` type trap that silently draws a circle.
- [model-pipeline.md](./model-pipeline.md) — GLB import + LOD, if a generated mesh ever ships as a
  mesh rather than as a rendered sprite.
