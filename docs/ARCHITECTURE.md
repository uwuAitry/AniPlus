# Architecture

dsh-AniPlus is a **client-only motion layer** with an intentionally empty Host half.

## Runtime shape

```text
package.json
  dsh.bundle.patch  -> cordis.patch.yml   (one Host row)
  dsh.client.platform -> web              (browser artifact)
  exports["./client"] -> client.js

index.js   Host half: export function apply() {}
client.js  Browser half:
  __ModuleLoader__.load({ id: "dsh-aniplus", factory })
  ├─ injects one owned <style data-plugin-css="dsh-aniplus/motion.css">
  ├─ installs one theme token layer (--ds-ease-in-out)
  ├─ projects settings onto <html> as data-anip / data-anip-intensity / anip-off-*
  ├─ gates first-paint replay with data-anip-ready
  ├─ registers the Settings → AniPlus section and nav icon
  └─ runs one bounded MutationObserver for retract ghosts
```

The Host row exists only so the Loader knows the package. Every visible effect is page-side.

## Selector contract

The plugin never selects a CSS-Modules class name. The only hooks are attributes and
ARIA state the host renders verbatim:

| Area | Hooks |
|---|---|
| Menus | `[data-menu-material="translucent"]`, `[data-menu-phase]`, `[data-anchor-side]`, `[data-anchor-align]`, `[data-trigger-menu]` |
| Composer popovers | `[data-slot="conversation.input.overlay"]`, `[data-composer-placeholder]` |
| Model picker | inline `--dsh-model-anchor` |
| Dialogs | `[role="dialog"][aria-modal="true"]`, `[data-shortcut-modal]` |
| Tooltips | `[role="tooltip"]`, `[data-side]` |
| Lists | `[data-row-key]`, `[data-files-entry]`, `[data-plugin-row]`, `[data-plugin-item]` |
| Conversation | `[data-chat-flow-key]`, `[data-chat-flow-kind]` |
| Panels | `[data-sidebar-right-panel]`, `[data-dockkit-pane]`, `[data-global-panel]` |
| Slots | `[data-slot="sidebar.workspaces"]`, `[data-slot="main"]`, `[data-slot="settings.section"]` |

A removed or renamed hook becomes a no-op: the rule stops matching, so no other
element receives the motion by accident.

## Motion pipeline

1. **Tokens** live on `:root` (`--anip-*`). `html[data-anip-intensity]` switches
   distance / scale / duration profiles.
2. **Entry** uses `@starting-style` where the host leaves a transition-able element
   alone, and plugin-local `@keyframes` where the host already animates opacity or
   needs a phase-specific exit.
3. **Global easing** is supplied twice: as a CSS fallback on
   `html[data-anip="on"]` and through `ctx.theme.overrideTokens()` so the host
   presenter keeps ownership when available.
4. **Retract** is handled per surface:
   - Host-managed exits (sidebar, right panel, context menus, toast) use host
     transitions or `data-menu-phase`.
   - React-unmounted overlays use a short ghost replay.

## Retract ghosts

`client.js` observes `document.body` with a single `MutationObserver`:

- Added nodes are matched against a fixed target list; their rects are cached.
- A removed match is cloned **before** its rect is discarded.
- The clone is fixed at the last rect, `pointer-events: none`,
  `data-anip-ghost` and `aria-hidden`, and removed on `animationend` (with a
  timeout fallback).
- Direction comes from `data-anchor-side`, `data-side`, `--dsh-model-anchor`,
  or the composer-overlay annotation; dialogs split into a fading mask and a
  receding panel.
- Contains `iframe`, `video`, `canvas`, `object` or `embed` → skip the clone.
- The controller is disabled when motion, the retract group, or
  `prefers-reduced-motion` says no.

This is the only place that writes DOM outside plugin-owned components. It never
patches host components, host state, `Element.prototype`, or host event handlers.

## Settings

`client.js` owns a small store persisted under `dsh-aniplus:settings`. It sanitizes
unknown / corrupt values to defaults and projects the result onto
`<html data-anip="on" ...>` plus `anip-off-<group>` classes. The Settings page is
registered through `settings.section` and `settings.section.icon`.

## Reduced motion

All added animation and transition declarations are wrapped in
`@media (prefers-reduced-motion: no-preference)`. The retract ghost also checks
`matchMedia('(prefers-reduced-motion: reduce)')` before cloning. Turning the master
switch off removes `data-anip`, which disables the stylesheet half even if the
plugin remains installed.

## Compatibility notes

- `dsh-perf-tuner`: the plugin never overrides `--ds-transition-duration-slow` /
  `--ds-transition-duration-fast`; sidebar tracks keep the host duration.
- `dsh-plugin-smooth-stream`: `assistant-step` rows are excluded from row entrances.
- `dsh-better-sidebar`: right-panel/dockkit rules are additive and can be disabled
  through the right-sidebar group.
- Host releases: `verify.mjs` checks every `data-*` selector against the installed
  client packages, so a renamed hook fails the check instead of silently drifting.
