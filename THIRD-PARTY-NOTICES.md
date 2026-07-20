# Third-Party Notices

Modoki Engine depends on third-party open-source software. Each component is the property of its
respective owners and is licensed under its own terms. This file summarizes the notable direct
dependencies and their licenses.

> **Authoritative list is generated at publish time.** The definitive, complete listing (every
> transitive dependency, with full license texts) is produced from the installed `node_modules`
> as part of the publish pipeline — e.g. `npx license-checker-rseidelsohn --production
> --relativeLicensePath --files oss/licenses`. The generated file is what ships in a release. The
> table below is a hand-verified summary of the significant direct dependencies.

## Significant direct dependencies

| Dependency | License | Role |
|---|---|---|
| three | MIT | 3D rendering |
| @types/three | MIT | 3D types |
| pixi.js, @pixi/react | MIT | 2D rendering |
| koota | ISC | ECS |
| @dimforge/rapier2d-compat, @dimforge/rapier3d-compat | Apache-2.0 | Physics |
| react, react-dom | MIT | UI runtime |
| @vitejs/plugin-react | MIT | Build |
| zustand | MIT | State management |
| vite | MIT | Build tooling |
| electron | MIT | Desktop editor shell |
| electron-updater | MIT | Editor self-update |
| flexlayout-react | ISC | Editor docking layout |
| @capacitor/* | MIT | Native iOS/Android shell |
| sharp | Apache-2.0 | Image processing (build) |
| meshoptimizer | MIT | Mesh optimization |
| @gltf-transform/core, /extensions, /functions | MIT | GLB processing |
| @monogrid/gainmap-js | MIT | HDR gain maps |
| @zappar/msdf-generator | MIT | MSDF text atlas |
| maxrects-packer | MIT | Atlas packing |
| chokidar | MIT | File watching (dev) |
| chess.js | BSD-2-Clause | Chess rules (demo dependency) |

All of the above are permissive (MIT / ISC / BSD / Apache-2.0) and compatible with redistribution
under Apache-2.0.

## License-compatibility notes

- **GSAP** (non-permissive "Standard 'no charge' license") was previously a declared dependency but
  is **not used by the engine** — no source imported it. It has been removed from the engine's
  dependencies, so it does not ship in this repository. A game project that wants GSAP may add it
  as its own (game-scoped) dependency and comply with GSAP's license there.

Where a dependency requires reproduction of its license text and/or copyright notice, that text is
included in the generated `oss/licenses/` output shipped with releases.
