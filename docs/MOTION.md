# Motion reference

## Tokens

| Token | Value | Intent |
|---|---|---|
| `--anip-ease-emphasized` | `cubic-bezier(0.16, 1, 0.3, 1)` | entrances that should feel quick but land softly |
| `--anip-ease-standard` | `cubic-bezier(0.22, 1, 0.36, 1)` | structural movement; also replaces host `--ds-ease-in-out` |
| `--anip-ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | retract / dismiss; accelerate away |
| `--anip-ease-spring` | `cubic-bezier(0.34, 1.36, 0.64, 1)` | small elements only |

| Variable | Subtle | Standard | Expressive |
|---|---|---|---|
| Menu distance | 2px | 4px | 8px |
| Menu scale | 0.99 | 0.97 | 0.95 |
| Dialog distance | 4px | 8px | 12px |
| Dialog scale | 0.99 | 0.97 | 0.955 |
| Toast distance | 6px | 10px | 14px |
| Row distance | 2px | 3px | 6px |
| Chat distance | 3px | 6px | 10px |

## Per-surface behavior

| Surface | Selection | Enter | Retract |
|---|---|---|---|
| Any `MenuSurface` | `[data-menu-material="translucent"]` | anchor-relative `translate` + `scale`; content opacity; transient opaque material | reverse `translate` + scale ghost |
| Context / submenu | `[data-menu-phase]`, `[data-submenu-layout]` | host phase, 80–160ms | 60–80ms fade, material fades separately |
| Model picker | inline `--dsh-model-anchor` | from below, `transform-origin: bottom` | back down |
| Command palette / slash menu | `[data-slot="conversation.input.overlay"]`, `[data-trigger-menu]` | from below | back down |
| Permission presets | `[data-anchor-side="top"]` | from below | back down |
| Tooltip | `[role="tooltip"][data-side]` | 2px from anchor side, `scale .98` | back to side |
| Modal | `[role="dialog"][aria-modal="true"]` | `scale .97 + 8px + blur 2px`, 220ms | panel recedes + mask fades, 180ms |
| Settings | `[data-shortcut-modal="settings"]` | `scale .985 + 6px`, no blur | panel recedes + mask fades |
| Image lightbox | dialog containing `> div > img` | fade only | fade only |
| Toast | `body > [role="alert"]` | 10px rise + spring | last 30% slides down before fade |
| Left sidebar | `[data-animating][data-sidebar-collapsed]` | host track, standard easing; rows 4px rise | exit easing; host keeps duration |
| Right panel | `[data-sidebar-right-panel]` | content 8px rise | exit easing + host slide |
| File / plugin / schedule rows | `[data-files-entry]`, `[data-plugin-row]`, `[data-plugin-item]`, `[data-session-schedule-task]` | 3px rise + fade | none (host unmount) |
| Chat row | `[data-chat-flow-key]` except `assistant-step`, last 3 | 6px rise + fade | host fold motion |
| Composer placeholder | `[data-composer-placeholder]` | hidden while any menu is open | returns after menu closes |
| Switch | `[role="switch"] > span` | thumb spring | same spring |
| Segmented tabs | `[role="tablist"] > span:first-child` | indicator glide | same |
| Page panels | `[data-global-panel] > [data-slot="main"] > *` | 8px rise + fade + 2px blur | ghost not used |

## Timing rules

- Open is slower than close: menu 180ms → 110ms; dialog 220ms → 180ms; tooltip 140ms → 90ms.
- Hover-in is shorter than hover-out; layout/width tracks never get a private duration.
- Stagger is limited to small batches; chat only animates the last three rows so opening a long
  session does not launch hundreds of animations.
- Reduced motion removes all added transitions/animations; the retract ghost checks the media
  query before cloning anything.
