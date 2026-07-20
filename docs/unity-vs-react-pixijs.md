# Unity vs React + PixiJS(/Three.js) — Full Comparison

A comprehensive comparison for a 2D puzzle game studio evaluating a move from Unity to a web-based stack.

---

## Table of Contents

1. [PixiJS vs Three.js — When to Use Which](#pixijs-vs-threejs)
2. [Unity vs React + PixiJS — Head-to-Head](#unity-vs-react--pixijs)
3. [Ecosystem & Libraries](#ecosystem--libraries)
4. [How Capacitor Works (Not Cordova)](#how-capacitor-works)
5. [SDK Compatibility (Adjust, AppLovin, Firebase)](#sdk-compatibility)
6. [Visual Scene / Level Editor (Tier 1 + Tier 2)](#visual-scene--level-editor)
7. [AI-Assisted Development (Claude)](#ai-assisted-development)
8. [Recommended Setup for Prototype](#recommended-setup-for-prototype)
9. [Folder Structure](#folder-structure)
10. [Key Libraries Reference](#key-libraries-reference)
11. [Migration Considerations](#migration-considerations)
12. [Multithreading & Heavy Algorithms](#multithreading--heavy-algorithms)

---

## PixiJS vs Three.js

They solve **different problems** and are not interchangeable:

| | PixiJS | Three.js |
|---|---|---|
| **Dimension** | 2D | 3D |
| **Renders** | Sprites, text, particles, filters | Meshes, cameras, lights, materials |
| **Think of it as** | Unity Canvas/2D Renderer | Unity 3D Engine |
| **WebGL usage** | 2D acceleration | Full 3D scene graph |
| **Performance** | 1M+ sprites at 60fps | Depends on scene complexity |
| **Bundle size** | ~450KB | ~600KB |

### When to use which

| Your game needs | Use |
|---|---|
| 2D puzzle game (tiles, sprites, UI) | **PixiJS only** |
| 3D game or 3D elements | **Three.js** (or react-three-fiber) |
| 2D game with occasional 3D (e.g., 3D piece preview) | **PixiJS** + a small Three.js canvas overlay |
| Isometric/2.5D | Either works — PixiJS with projection, or Three.js with ortho camera |

**For 2D puzzle games: PixiJS alone is sufficient. You do NOT need Three.js.**

If you later need 3D elements, you can add a Three.js canvas alongside PixiJS — they can coexist in the same React app.

---

## Unity vs React + PixiJS

### Core Comparison

| Category | Unity | React + PixiJS |
|---|---|---|
| **Type** | Full game engine | Rendering library + UI framework |
| **Language** | C# | TypeScript/JavaScript |
| **2D Rendering** | Good | Excellent (purpose-built) |
| **3D Rendering** | Excellent | N/A (use Three.js) |
| **UI System** | UI Toolkit / uGUI (mediocre) | HTML/CSS (industry-leading) |
| **Particle System** | Built-in visual editor | PixiJS particles (1M @ 60fps, has visual editor) |
| **Physics** | Box2D / PhysX built-in | matter.js or planck.js (Box2D port) |
| **Animation** | Animator, DOTween | GSAP, Spine runtime, PixiJS tweens |
| **Skeletal Animation** | Spine, DragonBones | Spine (official pixi runtime), DragonBones |
| **Audio** | Built-in AudioSource | Howler.js or @pixi/sound |
| **State Management** | ScriptableObjects, singletons | Zustand, Redux, Jotai |
| **Scene Management** | SceneManager (built-in) | React Router or custom (simple) |

### Development Experience

| | Unity | React + PixiJS |
|---|---|---|
| **IDE** | Unity Editor + VS Code/Rider | VS Code (or Cursor/Windsurf) |
| **Hot Reload** | Partial (domain reload = slow) | Instant (Vite HMR, sub-second) |
| **Build Time** | Seconds to minutes | Sub-second (dev), seconds (prod) |
| **Iteration Speed** | Slow (compile → reload → play) | Fast (save → see) |
| **Scene Editing** | Visual editor (drag & drop) | Code-only (or build your own tools) |
| **Asset Pipeline** | Built-in (import settings, atlases) | Vite + plugins (TexturePacker for atlases) |
| **Debugging** | Unity Console, Profiler | Chrome DevTools (world-class) |
| **Testing** | Unity Test Runner | Jest/Vitest (instant, easy) |
| **Package Manager** | UPM (limited ecosystem) | npm (2M+ packages) |
| **Version Control** | Painful (binary scenes, meta files) | Clean (everything is text/code) |

### Platform Support

| Platform | Unity | React + PixiJS |
|---|---|---|
| **iOS** | Native build | Capacitor (web in native shell) |
| **Android** | Native build | Capacitor (web in native shell) |
| **Web/Browser** | WebGL build (large, slow load) | Native — it IS a web app |
| **Windows** | Native build | Electron or Tauri |
| **macOS** | Native build | Electron or Tauri |
| **Consoles (Switch/PS/Xbox)** | Yes (with license) | **No** |
| **App Size** | 80–150MB+ minimum | 10–30MB |

### Monetization & Analytics SDKs

| SDK | Unity | React + PixiJS (via Capacitor) | Plugin Type |
|---|---|---|---|
| **Adjust** | Official plugin | `capacitor-adjust` | Standalone Capacitor plugin (SPM, wraps Adjust's native SDK) |
| **AppLovin MAX** | Official plugin | `capacitor-applovin-max` | Standalone Capacitor plugin (SPM, wraps AppLovin's native SDK) |
| **Firebase Crashlytics** | Official plugin | `@capacitor-firebase/crashlytics` | Native Capacitor plugin |
| **Firebase Analytics** | Official plugin | `@capacitor-firebase/analytics` | Native Capacitor plugin |
| **In-App Purchase** | Unity IAP | `@capgo/capacitor-native-purchases` / RevenueCat | Native Capacitor plugin |
| **AdMob** | Official plugin | `@capacitor-community/admob` | Native Capacitor plugin |

> **Note on native SDK plugins:** For each native SDK you `npm install` a standalone Capacitor plugin package and `import` it in TypeScript — Capacitor auto-discovers it via SPM and handles the native bridge. Capacitor also has built-in backwards compatibility with legacy Cordova plugins, but **this project deliberately does NOT use Cordova plugins** — they're broken with Capacitor 8's SPM plugin registry. See [How Capacitor Works](#how-capacitor-works) for details.

### Performance

| Metric | Unity | PixiJS v8 |
|---|---|---|
| **Sprite rendering** | Fast | Faster (purpose-built for 2D) |
| **Particles** | 100K+ (GPU) | 1M+ @ 60fps (ParticleContainer) |
| **Draw call batching** | SRP Batcher | Automatic in PixiJS |
| **Memory footprint** | 80MB+ baseline | 10–20MB baseline |
| **Startup time** | 3–10 seconds | < 1 second |
| **60fps on mid-range phone** | Yes | Yes |

### Cost

| | Unity | React + PixiJS |
|---|---|---|
| **Engine/Framework** | Free (< $200K) / $2,040/yr per seat (Pro) | Free (MIT license) |
| **For 200-person team (Pro)** | ~$400,000/year | $0 |
| **UI Middleware** | €9,000–€18,000 (NoesisGUI/Coherent) | $0 (it's already web) |
| **IDE** | Rider ~$170/yr per seat | VS Code (free) |
| **Total for 200 people** | $500K+/year | $0 |

---

## Ecosystem & Libraries

### Rendering & Graphics

| Need | Library | Notes |
|---|---|---|
| 2D rendering | **PixiJS v8** | Core renderer |
| React integration | **@pixi/react** | Official, React 19+, declarative JSX |
| 3D (if needed) | **Three.js** + react-three-fiber | Optional, add later |
| Shaders | PixiJS filters / custom GLSL | Similar to Unity ShaderLab |
| Sprite atlases | **TexturePacker** → JSON atlas | Same tool many Unity devs use |

### Animation

| Need | Library | Notes |
|---|---|---|
| Tweens | **GSAP** | Industry standard, GreenSock |
| Skeletal animation | **@pixi-spine/all** | Official Spine runtime, 50% faster in v8 |
| Skeletal (alt) | **pixi-dragonbones-runtime** | DragonBones support |
| Sprite sheet animation | PixiJS `AnimatedSprite` | Built-in |
| UI animation | **Framer Motion** | For React UI transitions |

### Physics

| Need | Library | Notes |
|---|---|---|
| Simple physics | **matter.js** | Easy API, good for puzzles |
| Box2D-compatible | **planck.js** | Box2D port, deterministic |
| No physics needed | — | Many puzzle games need none |

### Audio

| Need | Library | Notes |
|---|---|---|
| Sound effects & music | **Howler.js** | 7KB, all formats, spatial audio |
| PixiJS-integrated audio | **@pixi/sound** | Official PixiJS plugin |

### State Management & Data

| Need | Library | Notes |
|---|---|---|
| Game state | **Zustand** | Minimal, fast, React-friendly |
| Complex state | **Redux Toolkit** | If you need middleware, time-travel debug |
| Server/API state | **TanStack Query** | Caching, sync, retries |
| Local persistence | **localforage** or IndexedDB | Save games |

### Monetization & Native Features (via Capacitor)

| Need | Library | Notes |
|---|---|---|
| IAP | **@capgo/capacitor-native-purchases** | StoreKit 2 + Google Billing |
| IAP (managed) | **RevenueCat Capacitor SDK** | Handles receipt validation |
| Ads (AppLovin MAX) | **capacitor-applovin-max** | Standalone Capacitor plugin (SPM) wrapping AppLovin's native SDK |
| Ads (AdMob) | **@capacitor-community/admob** | Banners, interstitial, rewarded |
| Attribution | **capacitor-adjust** | Standalone Capacitor plugin (SPM) wrapping Adjust's native SDK |
| Analytics | **@capacitor-firebase/analytics** | Native Capacitor plugin |
| Crashlytics | **@capacitor-firebase/crashlytics** | Native Capacitor plugin |
| Push notifications | **@capacitor/push-notifications** | Official Capacitor plugin |
| Haptics | **@capacitor/haptics** | Vibration feedback |

### Testing

| Need | Library | Notes |
|---|---|---|
| Unit tests | **Vitest** | Fast, Vite-native |
| Component tests | **React Testing Library** | UI component testing |
| E2E tests | **Playwright** | Cross-browser, visual testing |

---

## How Capacitor Works

Capacitor is the native shell that wraps your React + PixiJS web app into a real iOS/Android app. It is **not Cordova** — it's a modern replacement built by the Ionic team.

### Architecture

```
┌─────────────────────────────────────────────────┐
│  Your Code (React + PixiJS + TypeScript)        │
│  ↓ imports                                       │
├─────────────────────────────────────────────────┤
│  Capacitor API (JavaScript)                      │
│  ↓ bridges to                                    │
├─────────────────────────────────────────────────┤
│  Native iOS/Android Shell                        │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────┐ │
│  │ Capacitor   │ │ Cordova      │ │ Custom    │ │
│  │ Plugins     │ │ Plugins      │ │ Native    │ │
│  │ (native)    │ │ (compatible) │ │ Code      │ │
│  └─────────────┘ └──────────────┘ └───────────┘ │
└─────────────────────────────────────────────────┘
```

### Key points

- **You write React + PixiJS** — your game is a web app
- **Capacitor wraps it** into a native app with a WebView + native bridge
- **Native Capacitor plugins** (like `@capacitor-firebase/*`) are purpose-built for Capacitor
- **Native SDKs are wrapped as standalone Capacitor plugins** (like `capacitor-adjust`) — auto-discovered via SPM. Capacitor *can* also load legacy Cordova plugins, but this project avoids them (broken with Capacitor 8's SPM registry)
- **You never use the Cordova CLI** — just `npm install` and `import`
- **Your TypeScript code looks the same** for every plugin:

```typescript
// Firebase Analytics — native Capacitor plugin
import { FirebaseAnalytics } from '@capacitor-firebase/analytics';
await FirebaseAnalytics.logEvent({ name: 'level_complete', params: { level: 42 } });

// Adjust — standalone Capacitor plugin (same pattern)
import { Adjust, AdjustEvent } from 'capacitor-adjust';
const event = new AdjustEvent('abc123');
Adjust.trackEvent(event);

// Both work identically. You don't notice the difference.
```

### Capacitor vs Cordova

| | Capacitor | Cordova |
|---|---|---|
| **Project structure** | Native projects (Xcode/Android Studio) are first-class | Hidden behind CLI abstractions |
| **Native code access** | Direct — edit Swift/Kotlin freely | Difficult |
| **Plugin ecosystem** | Capacitor plugins + Cordova plugins | Cordova plugins only |
| **Maintenance** | Actively developed (Ionic team) | Legacy, declining |
| **Web app support** | Runs as PWA too | Not designed for web |

---

## SDK Compatibility

### Required SDKs

| SDK | Package | Type | Status |
|---|---|---|---|
| **Adjust** | `capacitor-adjust` | Standalone Capacitor plugin (SPM) | Available — wraps [Adjust's native iOS/Android SDK](https://dev.adjust.com/en/sdk/) |
| **AppLovin MAX** | `capacitor-applovin-max` | Standalone Capacitor plugin (SPM) | Available — wraps [AppLovin MAX's native SDK](https://developers.applovin.com/en/max/overview/) |
| **Firebase Crashlytics** | `@capacitor-firebase/crashlytics` | Native Capacitor plugin | Available — [well-maintained](https://github.com/capawesome-team/capacitor-firebase) |
| **Firebase Analytics** | `@capacitor-firebase/analytics` | Native Capacitor plugin | Available — [well-maintained](https://github.com/capawesome-team/capacitor-firebase) |

**Revised estimate with Claude + test suite: ~1 day for code generation, ~1-2 days for human review and live API validation.**

The rewrite is possible because:
- The C# SDK has 887 files due to Unity boilerplate, abstractions, and editor tooling
- The actual API surface is ~10 endpoints with JWT auth
- TypeScript's `fetch()` + async/await makes HTTP clients trivial
- No need for the debug panels, build tools, or EDM checker in a web app

### What Claude can do

Claude can read the C# source files, understand the API contracts (request/response shapes, headers, auth flow), and generate the TypeScript client. The C# code serves as the **specification**, not the code to translate.

---

## Visual Scene / Level Editor

### Two tiers of editor needs

**Tier 1: Puzzle level editor** — simple, code-driven games where designers define boards, objectives, and rules.

**Tier 2: Full scene editor** — artists and designers create 2.5D backgrounds, meta game scenes, prefabs with hierarchy, animations, materials, and particles. This is comparable to Unity's Scene View + Inspector + Animation window.

---

### Tier 1: Puzzle Level Editor

For code-driven puzzle games, a simple level editor is sufficient:

```
┌─────────────────────────────────────────────────┐
│  Level Editor (React web app)                    │
│                                                  │
│  ┌──────────────────┐  ┌─────────────────────┐  │
│  │                  │  │ Properties Panel     │  │
│  │  PixiJS Canvas   │  │                     │  │
│  │  (click to place │  │ Tile type: [bomb ▼] │  │
│  │   tiles, drag    │  │ Board size: 9x9     │  │
│  │   to rearrange)  │  │ Moves: [25]         │  │
│  │                  │  │ Target: [5000]       │  │
│  └──────────────────┘  │ [Save] [Test Play]  │  │
│                        └─────────────────────┘  │
└─────────────────────────────────────────────────┘
```

**Effort: 1-2 days with Claude.** Game components ARE editor components — just add click handlers and a properties panel.

---

### Tier 2: Full Scene Editor — Traditional Approach vs Claude-as-Editor

If artists and designers need full scene authoring (2.5D backgrounds, meta game, prefabs, animations, materials), there are two approaches:

#### Approach A: Build a custom web-based editor (traditional)

| Component | Effort with Claude |
|---|---|
| Scene view with pan/zoom/select | 1-2 weeks |
| Object hierarchy tree | 1 week |
| Prefab system (create, instantiate, override, nested) | 2-4 weeks |
| Inspector (auto-generate from component props) | 2-3 weeks |
| Expose custom script properties | 1-2 weeks |
| Animation curve editor (keyframes, bezier) | 3-6 weeks |
| Material editor | 2-3 weeks |
| Particle editor | Already exists (PixiJS Particle Editor) |
| Asset browser | 1-2 weeks |
| Undo/redo across all operations | 2-3 weeks |
| Save/load serialization | 2-3 weeks |
| Polish for non-technical users | 4-8 weeks |
| **Total** | **4-8 months** |

#### Approach B: Claude Code IS the editor (recommended)

If artists and designers use Claude Code directly, the workflow changes fundamentally. Instead of building a visual editor, **Claude becomes the editor** with the browser as the scene view:

```
Artist's workflow:
┌─────────────────────────────┬──────────────────────────┐
│                             │                          │
│   Browser (game running)    │   Claude Code terminal   │
│   Hot reload, live preview  │                          │
│                             │   "Add a waterfall on    │
│   ← artist sees results     │    the left side, behind │
│      instantly              │    the bridge"           │
│                             │                          │
│                             │   "Make it taller, add   │
│                             │    mist particles at     │
│                             │    the base"             │
│                             │                          │
│                             │   "Animate the water     │
│                             │    flow — gentle loop"   │
│                             │                          │
└─────────────────────────────┴──────────────────────────┘
```

**What Claude replaces:**

| Editor feature | How Claude handles it | Still need visual tool? |
|---|---|---|
| **Scene composition** | "Put the castle at center, mountains in back" → Claude writes it, hot reload shows result | No |
| **Object hierarchy** | "Move the torch under the gate, make it a child" → Claude reparents in code | No |
| **Prefab creation** | "Create a TreasureChest prefab with lid, glow, sparkle" → Claude creates component file | No |
| **Property editing** | "Change opacity to 0.7, tint it blue, scale to 1.2" → Claude edits values | No |
| **Custom script properties** | "What properties does the waterfall have? Set flow speed to 3" → Claude reads and edits code | No |
| **Material editing** | "Add a glow filter, blue tint, shimmer effect" → Claude adds PixiJS filters, hot reload shows result | No |
| **Particle editing** | PixiJS Particle Editor already exists as a web tool | Already solved |
| **Asset management** | "What sprites do we have for trees?" → Claude lists files | No |
| **Undo/redo** | Git — Claude can revert any change | No |
| **Save/load** | It's already code/JSON files | No |
| **Animation (simple)** | "Bounce ease-out over 0.5s, then fade" → Claude writes GSAP animation | No |
| **Animation curves (complex)** | Multi-keyframe bezier curves are hard to describe verbally | **Yes — use Theatre.js** |
| **Fine spatial positioning** | "Move 3px left" works but slow for precise layout | **Yes — build drag gizmo** |

**What you still build (minimal visual tools):**

| Tool | What it does | Effort with Claude |
|---|---|---|
| **Transform gizmo overlay** | Drag handles on canvas for move/scale/rotate | 2-3 days |
| **Theatre.js integration** | Visual animation curve editor (keyframes + bezier handles) | 3-5 days |
| **Simple hierarchy panel** | Collapsible tree showing scene objects, click to select | 2-3 days |
| **Quick property panel** | Shows selected object's editable properties | 3-5 days |
| **PixiJS Particle Editor** | Visual particle design | Already exists |
| **Spine Editor** | Skeletal animation | Already exists (artists know it) |
| **Total** | | **2-4 weeks** |

#### Effort comparison

| Approach | Time | Maintenance |
|---|---|---|
| Build full custom editor (Approach A) | 4-8 months | Ongoing — you maintain it |
| **Claude-as-editor + minimal tools (Approach B)** | **2-4 weeks** | **Minimal — Claude improves via Anthropic, not you** |

#### Artist daily workflow with Claude Code

1. Open terminal + browser side by side
2. Game runs with hot reload (`npm run dev`)
3. Artist talks to Claude:
   - "Open the forest background scene"
   - "Add a waterfall on the left side, behind the bridge"
   - "Make it taller, add mist particles at the base"
   - "Animate the water flow — gentle loop, 2 second cycle"
4. For fine positioning: drag objects with transform gizmo overlay
5. For complex animation curves: open Theatre.js panel, drag bezier handles
6. "Save this as a prefab called ForestWaterfall" → Claude creates component
7. "Add ForestWaterfall to the village scene too, but smaller" → Claude imports and places it
8. All changes are code/JSON — clean git history, easy code review

#### Honest caveats of Claude-as-editor

| Concern | Reality |
|---|---|
| **Artist adoption** | Some will love it, some will resist. Not everyone wants to talk to AI instead of using a mouse. Training and culture change needed. |
| **Speed for spatial layout** | Drag-and-drop IS faster for precise positioning. The gizmo overlay helps, but a full scene editor is still faster for layout-heavy work. |
| **Claude latency** | Each response takes 2-5 seconds. For rapid "nudge left, nudge right" iteration, this is slower than real-time. The gizmo overlay solves this for transforms. |
| **Complex scenes** | 100+ objects — Claude handles it, but artist needs to reference objects by name. The hierarchy panel solves this. |
| **Learning curve** | Artists need to learn to work with Claude Code. This is a new skill, not just a new tool. Budget 1-2 weeks for training. |

### Existing visual tools (no custom build needed)

| Tool | Solution | Notes |
|---|---|---|
| **React UI editor** | [Puck](https://puckeditor.com/) | Open source (MIT), embeddable drag-and-drop editor for React. Register your own game UI components (Button, Modal, CurrencyDisplay, etc.), designers drag-and-drop to build screens, export JSON. Effort to integrate: 2-3 days. |
| **Particle editor** | [PixiJS Particle Editor](https://particle-emitter-editor.pixijs.io/) | Web-based, exports JSON config |
| **Animation curves** | [Theatre.js](https://www.theatrejs.com/) | Visual timeline + bezier curve editor |
| **Spine animation** | Spine Editor (desktop app) | Same tool Unity devs already use |
| **UI layout debugging** | Chrome DevTools | Inspect, tweak CSS live |
| **Performance profiling** | Chrome DevTools Performance tab | Frame-by-frame analysis |

---

## AI-Assisted Development

### Why React + PixiJS works better with Claude

| Aspect | Unity | React + PixiJS |
|---|---|---|
| **Code editing** | Claude writes C#, but needs Unity to compile | Claude writes TypeScript, immediately valid |
| **Scene editing** | Binary/YAML scenes — needs MCP bridge | Everything is code — direct file editing |
| **Viewing results** | Requires Unity MCP bridge | Chrome DevTools MCP — screenshot, click, inspect |
| **Running the game** | Unity Editor must be open | `npm run dev` → browser |
| **Running tests** | Unity Test Runner via MCP | `npm test` — direct CLI |
| **Debugging** | Limited MCP access to Console | Full Chrome DevTools access |
| **Asset management** | Unity meta files, import settings | Plain files in `/public` |
| **Refactoring** | Works but can't verify compilation | Full TypeScript checking via CLI |
| **End-to-end workflow** | Write → MCP bridge → Editor → Play → MCP screenshot | Write → save → hot reload → screenshot |

### Claude can directly:

- Write and edit all game code (TypeScript)
- Create and modify every UI screen (React + CSS)
- Configure particle effects (JSON configs)
- Set up animations (GSAP timelines)
- Write and run all tests (Vitest)
- View the game (Chrome DevTools screenshot)
- Interact with the game (Chrome DevTools click/type)
- Debug issues (console logs, network requests)
- Build for production (`npm run build`)
- Manage dependencies (`npm install`)

**No MCP bridge, no Editor dependency, no binary formats.**

---

## Recommended Setup for Prototype

### Editor

| Choice | Why |
|---|---|
| **VS Code** (recommended) | Free, TypeScript-native, best extension ecosystem |
| **Cursor** | VS Code fork with built-in AI (if team wants AI in-editor) |
| **WebStorm** | JetBrains — familiar if team uses Rider for Unity |

### Prerequisites

```bash
# Node.js (LTS)
node >= 20.x

# Package manager (pick one)
npm    # comes with Node
pnpm   # faster, stricter (recommended)
```

### Create Project

```bash
# Option 1: PixiJS official template with React
npm create pixi.js@latest -- --template framework-react

# Option 2: Vite + React + manual PixiJS setup (more control)
npm create vite@latest my-puzzle-game -- --template react-ts
cd my-puzzle-game
npm install pixi.js @pixi/react
npm install gsap howler zustand
npm install -D vitest @testing-library/react
```

### Add Mobile Support (Capacitor)

```bash
npm install @capacitor/core @capacitor/cli
npx cap init "My Puzzle Game" com.yourcompany.puzzlegame
npm install @capacitor/ios @capacitor/android
npx cap add ios
npx cap add android
```

### Dev Commands

```bash
npm run dev        # Start dev server with hot reload
npm run build      # Production build
npm run test       # Run tests
npx cap sync       # Sync web build to native projects
npx cap open ios   # Open in Xcode
npx cap open android  # Open in Android Studio
```

---

## Folder Structure

```
my-puzzle-game/
├── public/                     # Static assets (served as-is)
│   ├── sprites/                # Sprite sheets, atlases
│   │   ├── tiles.json          # TexturePacker atlas
│   │   └── tiles.png
│   ├── particles/              # Particle effect configs
│   │   ├── star-burst.json     # Exported from particle editor
│   │   └── confetti.json
│   ├── audio/
│   │   ├── sfx/
│   │   │   ├── match.mp3
│   │   │   └── pop.mp3
│   │   └── music/
│   │       └── theme.mp3
│   ├── spine/                  # Spine animations (if used)
│   │   ├── character.json
│   │   └── character.atlas
│   └── fonts/
│       └── game-font.woff2
│
├── src/
│   ├── main.tsx                # Entry point
│   ├── App.tsx                 # Root React component
│   │
│   ├── game/                   # PixiJS game layer
│   │   ├── Game.tsx            # Main PixiJS canvas (React component)
│   │   ├── scenes/             # Game scenes (like Unity scenes)
│   │   │   ├── GameScene.tsx   # Main puzzle gameplay
│   │   │   ├── MenuScene.tsx   # Title/menu screen
│   │   │   └── ResultScene.tsx # Level complete
│   │   ├── entities/           # Game objects (like Unity GameObjects)
│   │   │   ├── Tile.tsx        # A puzzle tile
│   │   │   ├── Board.tsx       # The puzzle board
│   │   │   └── PowerUp.tsx     # Special items
│   │   ├── systems/            # Game logic (like Unity MonoBehaviour systems)
│   │   │   ├── MatchSystem.ts  # Match detection
│   │   │   ├── GravitySystem.ts # Tile falling
│   │   │   └── ScoreSystem.ts  # Scoring rules
│   │   ├── effects/            # Visual effects
│   │   │   ├── ParticleManager.ts
│   │   │   ├── ScreenShake.ts
│   │   │   └── TileAnimation.ts
│   │   └── input/              # Input handling
│   │       ├── TouchHandler.ts
│   │       └── GestureDetector.ts
│   │
│   ├── ui/                     # React UI layer (HTML/CSS)
│   │   ├── components/         # Reusable UI components
│   │   │   ├── Button.tsx
│   │   │   ├── Modal.tsx
│   │   │   ├── CurrencyDisplay.tsx
│   │   │   └── ProgressBar.tsx
│   │   ├── screens/            # Full-screen UI pages
│   │   │   ├── HomeScreen.tsx
│   │   │   ├── ShopScreen.tsx
│   │   │   ├── SettingsScreen.tsx
│   │   │   └── LeaderboardScreen.tsx
│   │   └── styles/             # CSS / CSS modules
│   │       ├── global.css
│   │       ├── Button.module.css
│   │       └── theme.ts        # Design tokens (colors, spacing)
│   │
│   ├── store/                  # State management (Zustand)
│   │   ├── gameStore.ts        # Game state (score, level, moves)
│   │   ├── playerStore.ts      # Player data (currency, progression)
│   │   └── settingsStore.ts    # Audio, language, etc.
│   │
│   ├── services/               # External integrations
│   │   ├── audio.ts            # Howler.js wrapper
│   │   ├── analytics.ts        # Firebase Analytics wrapper
│   │   ├── crashlytics.ts      # Firebase Crashlytics wrapper
│   │   ├── iap.ts              # In-app purchase wrapper
│   │   ├── ads.ts              # AppLovin MAX wrapper
│   │   └── attribution.ts      # Adjust wrapper
│   │
│   ├── data/                   # Game data / configs
│   │   ├── levels/             # Level definitions
│   │   │   ├── level001.json
│   │   │   ├── level002.json
│   │   │   └── index.ts        # Level loader
│   │   └── config.ts           # Game balance, tuning
│   │
│   ├── utils/                  # Shared utilities
│   │   ├── math.ts
│   │   ├── random.ts
│   │   └── timer.ts
│   │
│   └── types/                  # TypeScript type definitions
│       ├── game.ts
│       └── store.ts
│
├── tests/                      # Test files
│   ├── systems/
│   │   └── MatchSystem.test.ts
│   └── store/
│       └── gameStore.test.ts
│
├── ios/                        # Capacitor iOS project (auto-generated)
├── android/                    # Capacitor Android project (auto-generated)
│
├── index.html                  # HTML entry point
├── vite.config.ts              # Vite configuration
├── capacitor.config.ts         # Capacitor configuration
├── tsconfig.json               # TypeScript config
├── package.json
└── .eslintrc.cjs
```

### Key Architectural Decisions

**Two-layer architecture** (like having Unity Canvas + HTML overlay):

```
┌─────────────────────────────────────────┐
│         React UI Layer (HTML/CSS)       │  ← Menus, shop, HUD, modals
│         Rendered by browser DOM         │
├─────────────────────────────────────────┤
│       PixiJS Game Layer (WebGL)         │  ← Puzzle board, tiles, effects
│       Rendered on <canvas>              │
└─────────────────────────────────────────┘
│           Zustand Store                 │  ← Shared state between layers
└─────────────────────────────────────────┘
```

- **React** handles all UI (menus, popups, shop, settings) — this is where web shines
- **PixiJS** handles the game canvas (puzzle board, tiles, particles, animations)
- **Zustand** bridges data between the two layers (score changes in PixiJS → React HUD updates)
- Both layers run in the same app, same process, no bridge needed

---

## Key Libraries Reference

### Must-have (core stack)

| Package | Purpose | Unity Equivalent |
|---|---|---|
| `pixi.js` | 2D WebGL renderer | Unity 2D Renderer |
| `@pixi/react` | React ↔ PixiJS integration | — |
| `react` + `react-dom` | UI framework | UI Toolkit / uGUI |
| `zustand` | State management | ScriptableObjects / singletons |
| `gsap` | Animation / tweens | DOTween |
| `howler` | Audio | AudioSource |
| `vite` | Build tool + dev server | Unity Build Pipeline |
| `typescript` | Type safety | C# type system |

### Recommended (most games will need)

| Package | Purpose | Unity Equivalent |
|---|---|---|
| `@pixi/particle-emitter` | Particle effects | Particle System |
| `@pixi-spine/all` | Spine skeletal animation | Spine Unity Runtime |
| `framer-motion` | UI animations/transitions | UI animation / DOTween |
| `react-router-dom` | Screen navigation | SceneManager |
| `localforage` | Save game data (IndexedDB) | PlayerPrefs / JSON save |
| `vitest` | Unit testing | NUnit / Unity Test Runner |

### For mobile shipping (Capacitor)

| Package | Purpose |
|---|---|
| `@capacitor/core` | Native bridge |
| `@capacitor/ios` + `@capacitor/android` | Platform targets |
| `@capgo/capacitor-native-purchases` | In-App Purchases |
| `@capacitor-community/admob` | AdMob ads |
| `@capacitor/haptics` | Vibration feedback |
| `@capacitor/push-notifications` | Push notifications |
| `@capacitor-firebase/analytics` | Analytics |

### Optional (add as needed)

| Package | Purpose | When to add |
|---|---|---|
| `three` + `@react-three/fiber` | 3D rendering | If you need 3D elements |
| `matter-js` or `planck-js` | 2D physics | If puzzles need physics simulation |
| `i18next` + `react-i18next` | Localization | Multi-language support |
| `@pixi/tilemap` | Tilemap rendering | If game uses tilemaps |

---

## Migration Considerations

### What translates well from Unity

| Unity Concept | Web Equivalent |
|---|---|
| GameObject + Components | React component + hooks |
| MonoBehaviour.Update() | PixiJS ticker (`app.ticker.add`) or `useFrame` |
| ScriptableObject | TypeScript object / JSON config |
| Prefabs | React components (reusable by design) |
| Scenes | React Router routes or scene components |
| Coroutines | async/await + GSAP timelines |
| UnityEvents | EventEmitter or Zustand subscriptions |
| Inspector (tweaking values) | Hot reload (change code → instant update) |
| Asset Bundles | Dynamic import / code splitting (built into Vite) |
| PlayerPrefs | localStorage / localforage |
| Addressables | Lazy loading with dynamic `import()` |

### What your Unity devs need to learn

| Skill | Difficulty | Time to productive |
|---|---|---|
| TypeScript (coming from C#) | Easy — very similar | 1–2 weeks |
| React basics | Medium | 2–4 weeks |
| PixiJS API | Easy (simpler than Unity) | 1–2 weeks |
| CSS for game UI | Medium (but powerful) | 2–3 weeks |
| Vite / npm ecosystem | Easy | Days |
| Capacitor (mobile) | Easy | Days |

### What you lose (honestly)

- **Visual scene editor** — no built-in editor, but you can build a custom level editor as a web app using the same React + PixiJS stack (see [Visual Scene / Level Editor](#visual-scene--level-editor)). For puzzle games this is often better than Unity's generic editor since it's tailored to your exact needs.
- **Console deployment** — no Switch, PlayStation, Xbox. Period.
- **Asset Store** — npm has more packages overall, but fewer game-specific assets/tools than Unity Asset Store.
- **Unity-specific tools** — Cinemachine, Timeline, Shader Graph have no direct equivalents. You build what you need or use web alternatives.
- **Established mobile game toolchain** — Unity's mobile profiling, crash reporting, and optimization tools are more mature for games specifically.

---

## Multithreading & Heavy Algorithms

### The concern

Even puzzle games run heavy algorithms — e.g., "what piece to drop next" in match-3 games requires running hundreds of board simulations per move to find the optimal piece. This needs to happen off the main thread to keep 60fps.

### Web Workers — true OS threads

JavaScript has **Web Workers**, which are real OS threads (not green threads or coroutines). They provide true parallel execution without blocking the main thread.

| | Unity (C#) | Web (TypeScript) |
|---|---|---|
| **Threading model** | `System.Threading`, Tasks, Job System | Web Workers |
| **Shared memory** | Direct shared memory | `SharedArrayBuffer` + `Atomics` |
| **Data parallelism** | Burst Compiler + Jobs | Web Workers, or GPU via WebGPU |
| **Async I/O** | async/await, Tasks | async/await, Promises |
| **Thread count** | Unlimited (OS threads) | Unlimited Web Workers (OS threads) |

### How board solving works with Web Workers

```typescript
// Main thread — game loop stays at 60fps, no frame drops
const solver = new Worker(
  new URL('./board-solver.ts', import.meta.url),
  { type: 'module' }
);

solver.postMessage({ board: currentBoard, emptySlots: slots });
solver.onmessage = (e) => {
  dropPieces(e.data.bestPieces);
};
```

```typescript
// board-solver.ts — runs on a separate OS thread
self.onmessage = (e) => {
  const { board, emptySlots } = e.data;
  const bestPieces = runSimulations(board, emptySlots, 500); // heavy work
  self.postMessage({ bestPieces });
};
```

You can spin up multiple workers for parallel simulation:

```
Main thread (60fps, animations, input)
  ├── Worker 1: simulates boards with piece set A
  ├── Worker 2: simulates boards with piece set B
  ├── Worker 3: simulates boards with piece set C
  └── Merge results → pick best drop
```

### Performance

| | Unity Job System | Web Workers |
|---|---|---|
| Board simulation (500 iterations) | ~2-5ms (Burst compiled) | ~5-15ms (V8 JIT) |
| Blocks main thread? | No | No |
| Parallel workers | Job System schedules automatically | You manage workers explicitly |

V8's JIT may be 2-3x slower than Burst-compiled C#, but 5-15ms vs 2-5ms are both well under a single frame (16ms at 60fps). For maximum performance, you can compile hot paths to **WebAssembly (WASM)** via Rust/C++ for near-native speed.

### Development & platform support

| | Works? |
|---|---|
| Web Workers in Chrome (dev) | Yes — Vite has built-in support, no config needed |
| Web Workers in production | Yes |
| Web Workers on iOS (Capacitor) | Yes |
| Web Workers on Android (Capacitor) | Yes |
| Chrome DevTools debugging | Yes — dedicated Threads panel with breakpoints |

### SharedArrayBuffer vs postMessage — use postMessage

`SharedArrayBuffer` (zero-copy shared memory) requires COOP/COEP HTTP headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These headers **break ad SDKs** — ad creatives loaded in iframes from third-party networks won't send the required `Cross-Origin-Resource-Policy` headers.

**Recommendation: use `postMessage` instead.** It copies data to the worker, but for puzzle game boards this is negligible:

| Approach | SharedArrayBuffer needed | Extra headers | Ad SDK compatible | Board transfer cost |
|---|---|---|---|---|
| **`postMessage` (copy)** | No | None | Yes | ~microseconds for a 9x9 board |
| `SharedArrayBuffer` (shared) | Yes | COOP + COEP | Breaks ads | Zero-copy |

`SharedArrayBuffer` is for streaming megabytes per frame (audio, video, physics). For sending a board state to a solver, `postMessage` is the right choice.

---

## Summary

For a studio making **2D puzzle games** that doesn't need **console support**:

| Factor | Winner |
|---|---|
| UI quality | React + PixiJS |
| Dev speed / iteration | React + PixiJS |
| 2D rendering performance | React + PixiJS |
| AI-assisted development | React + PixiJS (no bridge needed) |
| Cost | React + PixiJS ($0 vs $500K+/yr) |
| App size | React + PixiJS (10–30MB vs 80–150MB) |
| Ecosystem (packages) | React + PixiJS (npm) |
| Version control | React + PixiJS (all text files) |
| Team hiring pool | React + PixiJS (more web devs than Unity devs) |
| 3D capability | Unity |
| Console support | Unity |
| Visual editor | Unity (built-in) / React+PixiJS (Claude-as-editor + 2-4 weeks of minimal tools) |
| Mature game tooling | Unity |

The web stack isn't just "good enough" for 2D puzzle games — it's genuinely better in most dimensions that matter for this genre.
