# Contributing to Modoki Engine

Thanks for your interest in improving Modoki! Please read this before opening a pull request.

## Contributor License Agreement (required)

Before any pull request can be merged, you must agree to the
[Contributor License Agreement](./CLA.md). A bot will prompt you to sign on your first PR; the
merge is blocked until you have. In short: you keep authorship of your work, but you grant the
project owner a broad, perpetual license to use **and relicense** your contribution — this keeps
the project's licensing future flexible. Please read the CLA in full.

## How this repository works

This repo is a **public snapshot mirror** of a private development repository. Day-to-day
development happens privately; tagged engine snapshots are published here, and releases are cut
here. Practically, that means:

- **Issues and PRs are welcome here.** Merged PRs are ported back into the private repo by the
  maintainer, so a merge may show up as part of a later snapshot rather than an immediate
  fast-forward. Please be patient with the round-trip.
- Large or architectural changes: **open an issue to discuss first** — it may already be in
  flight privately.

## Development setup

Requirements: Node.js 22+, npm.

```bash
npm install        # installs deps AND builds workspace plugins (postinstall) — required
npm run dev        # Vite dev server + editor at http://localhost:5173/#/editor
```

## Before you open a PR

Run the same gate CI runs:

```bash
npm run verify     # typecheck + lint + engine tests (app + @modoki/engine package)
```

- **`npm test`** runs the engine test suite (`engine/tests/**` + `engine/packages/modoki/tests/**`).
  No native toolchain or game project is required for the engine tests.
- Add or update tests for behavior you change. Engine tests must pass with no game project present.
- Keep changes focused; match the style and conventions of the surrounding code.

## Reporting bugs

Open an issue with a minimal reproduction (a small scene/project or a failing test is ideal) and
the platform/version. For rendering issues, prefer describing the data/state that's wrong over
screenshots where possible.

## License of contributions

By contributing you agree your contributions are licensed under the project's
[Apache-2.0 License](./LICENSE) and are additionally subject to the [CLA](./CLA.md).
