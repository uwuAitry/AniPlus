<p align="center">
  <img src="icon.svg" width="72" alt="AniPlus icon" />
</p>

<h1 align="center">dsh-AniPlus</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-aniplus"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-aniplus?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/dsh-aniplus"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-aniplus?style=flat-square" /></a>
  <a href="https://github.com/uwuAitry/AniPlus/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/uwuAitry/AniPlus?style=flat-square" /></a>
  <a href="https://github.com/uwuAitry/AniPlus/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/uwuAitry/AniPlus?style=flat-square" /></a>
  <img alt="DSH compatibility" src="https://img.shields.io/badge/dsh-0.2.2--rc.3-4b8dff?style=flat-square" />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="powered by dsh" src="https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" /></a>
</p>

<p align="center">
  English | <a href="./README.zh-CN.md">简体中文</a>
</p>

**Directional, non-linear motion for the DSH web UI.**

dsh-AniPlus is a client-side DSH plugin that gives menus, dialogs, lists, sidebars,
conversation rows and small controls a coherent motion language. It adds the motion
from inside the running page: no host component is replaced, patched or forked.

The plugin is deliberately motion-first: entry and exit follow the same direction,
so a popover that rises from its trigger also retracts toward that trigger instead
of fading away in place.

## Features

- **Menus and popovers** — every `MenuSurface` (model picker, command palette,
  permission presets, slash menu, context menus, submenus) enters from its anchor
  direction with a short `translate + scale`; the entrance beat uses a briefly
  opaque material so the composer placeholder cannot bleed through.
- **Dialogs and panels** — modals, Settings, approval dialogs and page panels use a
  soft `scale + rise + blur` entrance; closing overlays are replayed as a short
  directional ghost.
- **Directional retract** — menus return to their anchor edge, dialogs shrink back
  toward their resting position, tooltips return to their side, and toasts slide
  back down before fading.
- **Left and right sidebars** — the host keeps ownership of the track duration, so
  `dsh-perf-tuner`-style fast tracks are not slowed down; only the easing changes
  and content rows get a small entrance.
- **Lists and chat** — session rows, file rows, plugin rows, schedule tasks and the
  last few conversation rows rise and fade without fighting host FLIP animations.
- **Micro-interactions** — switch thumb spring, segmented-tab indicator glide, row
  hover nudge and scroll-to-bottom pop-in.
- **Settings page** — Settings → **AniPlus** with a master switch, three intensity
  levels, per-group switches and reset.

All added motion is opt-in under `prefers-reduced-motion: no-preference`; when the
OS asks for reduced motion, the plugin adds nothing.

## Install

### From npm

```sh
dsh plugin --profile <profile> add dsh-aniplus
```

### From a release archive

Download `dsh-aniplus-<version>.tgz` from
[Releases](https://github.com/uwuAitry/AniPlus/releases), then:

```sh
dsh plugin --profile <profile> add ./dsh-aniplus-<version>.tgz
```

### From source

```sh
git clone https://github.com/uwuAitry/AniPlus.git
dsh plugin --profile <profile> add ./AniPlus
```

The bundle id is `dsh-aniplus`; the display name is **dsh-AniPlus**. If the plugin
row reports `restart-required`, restart DSH once.

## Settings

Open **Settings → AniPlus**:

| Control | Meaning |
|---|---|
| Motion enabled | Master switch; off restores the native DSH feel without uninstalling. |
| Intensity | `Subtle` / `Standard` / `Expressive`: distance, scale and duration. |
| Motion groups | Menus, dialogs, notifications, retract animations, left sidebar, right sidebar, lists, conversation, micro-interactions, pages. |
| Reset to defaults | Restores the standard profile. |

Settings are stored in the current browser under `dsh-aniplus:settings`; they are
not written into the DSH profile and changes apply immediately.

## Motion model

| Token | Value | Used for |
|---|---|---|
| `--anip-ease-emphasized` | `cubic-bezier(0.16, 1, 0.3, 1)` | menus, dialogs and page entrances: fast start, long soft landing |
| `--anip-ease-standard` | `cubic-bezier(0.22, 1, 0.36, 1)` | structure motion and the global `--ds-ease-in-out` replacement |
| `--anip-ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | returns and dismissals: accelerate away |
| `--anip-ease-spring` | `cubic-bezier(0.34, 1.36, 0.64, 1)` | small elements only: toast, switch, scroll button |

Durations follow a 90 / 150 / 200 / 280–320 ms scale. Distances are deliberately
small (`2–12px`) and scale values are kept between `0.96` and `0.99`.

See [docs/MOTION.md](docs/MOTION.md) for the full per-surface table.

## What it touches

The plugin uses only stable hooks the host renders verbatim:

- `data-menu-material`, `data-menu-phase`, `data-anchor-side`, `data-anchor-align`
- `data-trigger-menu`, `data-slot="conversation.input.overlay"`,
  `--dsh-model-anchor`
- `role="dialog"`, `aria-modal`, `role="tooltip"`, `data-side`
- `data-composer-placeholder`, `data-chat-flow-key`, `data-chat-flow-kind`
- `data-files-entry`, `data-plugin-row`, `data-plugin-item`, `data-row-key`

No CSS-Module class name is selected. If a DSH release renames a hook, the rule
stops matching and becomes a no-op instead of hitting the wrong element.

## Compatibility

- DSH `0.2.2-rc.3` / DSH Desktop `2.0.23-next`.
- Coexists with `dsh-perf-tuner`: host duration tokens and `[data-animating]` track
  timing are not changed.
- Leaves `assistant-step` rows alone when `dsh-plugin-smooth-stream` is installed.
- Right-panel and dockkit rules apply inside `dsh-better-sidebar` as well; the group
  can be switched off independently.

## Known limits

- The plugin does not patch React components. Closing surfaces that the host
  unmounts immediately are replayed through a bounded, pointer-inert ghost clone
  (90–180 ms) and then removed.
- Ghosts skip elements containing `iframe`, `video`, `canvas`, `object` or `embed`.
- The host's `AnimatedRows` WAAPI durations are left untouched; list entrance uses
  only properties that do not conflict with its transform/opacity animation.
- HoverCard's compact card has no stable hook and is not covered.
- Visual verification is manual: `verify.mjs` is an offline contract check, not a
  screenshot suite.

## Development

```sh
node verify.mjs   # offline contract checks against the installed DSH
```

The checker validates manifest shape, locale resources, icon limits, CSS brace
balance, keyframe names, attribute existence against the installed DSH client
packages, slot names, reduced-motion wrapping and the single bounded
`MutationObserver` used by retract ghosts. `DSH_INSTALL_DIR` may point the checks
at another installation.

```text
AniPlus/
├─ package.json
├─ cordis.patch.yml
├─ index.js            # Host half: no-op
├─ client.js           # browser half: styles, theme layer, settings, ghosts
├─ locale/             # en / zh
├─ docs/
│  ├─ ARCHITECTURE.md
│  └─ MOTION.md
├─ icon.svg
├─ verify.mjs
└─ LICENSE
```

## Publishing (maintainers)

1. Run the offline checks:

   ```sh
   node verify.mjs
   ```

2. Bump the version in `package.json`, commit, and tag:

   ```sh
   git commit -am "release: vX.Y.Z"
   git tag -a vX.Y.Z -m "AniPlus vX.Y.Z"
   git push origin main vX.Y.Z
   ```

3. Build and publish the tarball:

   ```sh
   npm pack                      # or: pnpm pack
   npm publish dsh-aniplus-<version>.tgz --access public
   ```

   `publishConfig.access` is already set to `public`; an npm account with an
   `automation` token (`npm login` or `NPM_TOKEN`) is required for the publish step.

4. Attach the tarball to a GitHub release:

   ```sh
   gh release create vX.Y.Z dsh-aniplus-<version>.tgz --title "AniPlus vX.Y.Z" --generate-notes
   ```

## License

MIT. See [LICENSE](LICENSE).

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
