/**
 * dsh-AniPlus — browser half.
 *
 * A page-side motion layer for the DSH web UI. It never edits host stylesheets
 * or patches host components: one owned <style> element plus one theme token
 * layer. Every selector is a stable data-* attribute, ARIA role/state or a
 * slot wrapper the host renders verbatim — no CSS-Modules class names.
 */
window.__ModuleLoader__.load({
  id: 'dsh-aniplus',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    const PLUGIN_ID = 'dsh-aniplus';
    const STYLE_ID = PLUGIN_ID + '/motion.css';
    const SETTINGS_KEY = PLUGIN_ID + ':settings';
    const LOCALE_NS = 'settings.aniplus';

    const GROUP_KEYS = ['menus', 'dialogs', 'toasts', 'sidebar', 'rightbar', 'lists', 'chat', 'micro', 'pages', 'exits'];
    const INTENSITIES = ['subtle', 'standard', 'expressive'];
    const DEFAULT_SETTINGS = Object.freeze({
      enabled: true,
      intensity: 'standard',
      groups: Object.freeze({
        menus: true,
        dialogs: true,
        toasts: true,
        sidebar: true,
        rightbar: true,
        lists: true,
        chat: true,
        micro: true,
        pages: true,
        exits: true,
      }),
    });

    /* ------------------------------------------------------------- settings -- */

    /**
     * Accept only known scalar values and booleans. A corrupt or partial record
     * falls back to the shipped defaults instead of throwing during boot.
     */
    function sanitize(raw) {
      const input = raw !== null && typeof raw === 'object' ? raw : {};
      const groups = input.groups !== null && typeof input.groups === 'object' ? input.groups : {};
      const next = {
        enabled: input.enabled !== false,
        intensity: INTENSITIES.includes(input.intensity) ? input.intensity : 'standard',
        groups: {},
      };
      for (const key of GROUP_KEYS) next.groups[key] = groups[key] !== false;
      return next;
    }

    function readStoredSettings() {
      try {
        const text = window.localStorage.getItem(SETTINGS_KEY);
        return sanitize(text === null ? null : JSON.parse(text));
      } catch {
        return sanitize(null);
      }
    }

    const settingsStore = {
      value: null,
      listeners: [],
      get() {
        if (this.value === null) this.value = readStoredSettings();
        return this.value;
      },
      set(patch) {
        const current = this.get();
        const next = sanitize({
          enabled: patch.enabled === undefined ? current.enabled : patch.enabled,
          intensity: patch.intensity === undefined ? current.intensity : patch.intensity,
          groups: patch.groups === undefined ? current.groups : Object.assign({}, current.groups, patch.groups),
        });
        this.value = next;
        try {
          window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
        } catch {
          /* A locked-down browser may refuse storage; the in-memory value still applies. */
        }
        for (const listener of this.listeners.slice()) {
          try {
            listener();
          } catch {
            /* One consumer must not break the rest of the page. */
          }
        }
      },
      reset() {
        this.set({
          enabled: DEFAULT_SETTINGS.enabled,
          intensity: DEFAULT_SETTINGS.intensity,
          groups: Object.assign({}, DEFAULT_SETTINGS.groups),
        });
      },
      subscribe(listener) {
        this.listeners.push(listener);
        return () => {
          const at = this.listeners.indexOf(listener);
          if (at !== -1) this.listeners.splice(at, 1);
        };
      },
    };

    /** Project the setting record onto documentElement for the stylesheet. */
    function applySettingsToDom(settings) {
      const root = document.documentElement;
      if (settings.enabled) {
        root.setAttribute('data-anip', 'on');
        root.setAttribute('data-anip-intensity', settings.intensity);
      } else {
        root.removeAttribute('data-anip');
        root.removeAttribute('data-anip-intensity');
      }
      for (const key of GROUP_KEYS) {
        root.classList.toggle('anip-off-' + key, !settings.groups[key]);
      }
    }

    function clearSettingsFromDom() {
      const root = document.documentElement;
      root.removeAttribute('data-anip');
      root.removeAttribute('data-anip-intensity');
      root.removeAttribute('data-anip-ready');
      for (const key of GROUP_KEYS) root.classList.remove('anip-off-' + key);
    }

    /* ---------------------------------------------------------------- exit -- */

    const EXIT_TARGETS = [
      '[data-menu-material="translucent"]',
      '[role="presentation"]:has(> [role="dialog"][aria-modal="true"])',
      '[role="dialog"][aria-modal="true"]',
      '[role="tooltip"]',
      '[data-quote-popover]',
      '[data-document-viewer-menu]',
    ].join(',');
    const EXIT_HINT = '[data-menu-material], [role="dialog"], [role="tooltip"], [data-quote-popover], [data-document-viewer-menu], [role="presentation"]';
    const EXIT_KINDS = [
      ['[data-menu-material="translucent"]', 'menu'],
      ['[role="tooltip"]', 'tooltip'],
      ['[data-quote-popover]', 'menu'],
      ['[data-document-viewer-menu]', 'menu'],
    ];
    const EXIT_ANIMATIONS = {
      menu: 'anip-ghost-menu-out',
      tooltip: 'anip-ghost-tip-out',
      dialog: 'anip-ghost-dialog-out',
    };
    const EXIT_DURATIONS = { menu: 110, tooltip: 90, dialog: 180 };

    /**
     * React unmounts overlays without a close phase. This bounded controller
     * preserves the last painted box of a closing menu, dialog or tooltip as a
     * pointer-inert clone for one short exit animation, then removes it. It
     * never touches host components or their state, and it is skipped entirely
     * when motion or the Retract group is off.
     */
    function createExitGhostController(settings) {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined' || document.body === null) {
        return { dispose() {} };
      }
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
      const tracked = new Set();
      const measured = new WeakMap();
      const ghosted = new WeakSet();
      let frame = 0;
      let observer = null;
      let disposed = false;

      function allowed() {
        const current = settings.get();
        return current.enabled && current.groups.exits && !reduced.matches;
      }

      function measure() {
        for (const element of tracked) {
          if (!element.isConnected) {
            tracked.delete(element);
            continue;
          }
          measured.set(element, element.getBoundingClientRect());
        }
      }

      function scheduleMeasure() {
        if (frame !== 0) return;
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          if (!disposed) measure();
        });
      }

      function collect(node) {
        if (!(node instanceof Element)) return;
        if (node.closest('[data-anip-ghost]') !== null) return;
        const candidates = [];
        if (node.matches(EXIT_TARGETS)) candidates.push(node);
        else if (node.childElementCount > 0 && node.querySelector(EXIT_HINT) !== null) {
          candidates.push(...node.querySelectorAll(EXIT_TARGETS));
        }
        for (const element of candidates) {
          if (element.closest('[data-anip-ghost]') !== null) continue;
          if (element.closest('[data-slot="conversation.input.overlay"]') !== null || element.hasAttribute('data-trigger-menu')) {
            element.setAttribute('data-anip-composer-overlay', '');
          }
          tracked.add(element);
        }
        scheduleMeasure();
      }

      function kindOf(target) {
        for (const [selector, kind] of EXIT_KINDS) {
          if (target.matches(selector)) return kind;
        }
        return 'dialog';
      }

      function findTarget(node) {
        if (!(node instanceof Element)) return null;
        if (node.matches(EXIT_TARGETS)) return node;
        return node.querySelector(EXIT_TARGETS);
      }

      function exitVector(target, kind) {
        if (kind === 'tooltip') {
          const side = target.getAttribute('data-side') || 'right';
          if (side === 'top') return { translate: '0 var(--anip-tip-distance)', origin: 'bottom center', scale: '1' };
          if (side === 'bottom') return { translate: '0 calc(-1 * var(--anip-tip-distance))', origin: 'top center', scale: '1' };
          if (side === 'left') return { translate: 'var(--anip-tip-distance) 0', origin: 'right center', scale: '1' };
          return { translate: 'calc(-1 * var(--anip-tip-distance)) 0', origin: 'left center', scale: '1' };
        }
        if (kind === 'menu') {
          const modelMenu = target instanceof HTMLElement && target.style.getPropertyValue('--dsh-model-anchor') !== '';
          const composerOverlay = target.hasAttribute('data-anip-composer-overlay') || target.hasAttribute('data-trigger-menu');
          const side = modelMenu || composerOverlay ? 'top' : (target.getAttribute('data-anchor-side') || 'bottom');
          const align = target.getAttribute('data-anchor-align');
          let origin = 'top center';
          if (side === 'top') origin = 'bottom center';
          else if (side === 'right') origin = 'left center';
          else if (side === 'left') origin = 'right center';
          if (align === 'end' && (side === 'bottom' || side === 'top')) origin = origin.replace('center', 'right');
          if (side === 'top') return { translate: '0 var(--anip-menu-distance)', origin, scale: '0.97' };
          if (side === 'right') return { translate: 'calc(-1 * var(--anip-menu-distance)) 0', origin, scale: '0.97' };
          if (side === 'left') return { translate: 'var(--anip-menu-distance) 0', origin, scale: '0.97' };
          return { translate: '0 calc(-1 * var(--anip-menu-distance))', origin, scale: '0.97' };
        }
        return { translate: '0 var(--anip-dialog-distance)', origin: 'center', scale: 'var(--anip-dialog-scale)' };
      }

      function makeGhost(target) {
        if (!allowed()) return;
        if (ghosted.has(target)) return;
        if (target.closest('[data-anip-ghost]') !== null) return;
        if (target.hasAttribute('data-menu-phase') || target.closest('[data-menu-phase]') !== null) return;
        if (target.getAttribute('data-shortcut-modal') === 'sidebar') return;
        if (target.querySelector('iframe, video, canvas, object, embed') !== null) return;
        const rect = measured.get(target) ?? target.getBoundingClientRect();
        if (rect === undefined || rect.width < 1 || rect.height < 1) return;
        const kind = kindOf(target);
        for (const element of [target, ...target.querySelectorAll('*')]) {
          ghosted.add(element);
          tracked.delete(element);
        }
        const ghost = target.cloneNode(true);
        if (ghost instanceof Element && ghost.id !== '') ghost.removeAttribute('id');
        for (const element of ghost.querySelectorAll('[id]')) element.removeAttribute('id');
        for (const element of [ghost, ...ghost.querySelectorAll('*')]) {
          if (element instanceof HTMLElement) {
            element.style.animation = 'none';
            element.style.transition = 'none';
          }
        }
        if (!(ghost instanceof HTMLElement)) return;
        ghost.style.position = 'fixed';
        ghost.style.left = rect.left + 'px';
        ghost.style.top = rect.top + 'px';
        ghost.style.right = 'auto';
        ghost.style.bottom = 'auto';
        ghost.style.width = rect.width + 'px';
        ghost.style.height = rect.height + 'px';
        ghost.style.boxSizing = 'border-box';
        ghost.style.margin = '0';
        ghost.style.zIndex = '2147483000';
        ghost.style.pointerEvents = 'none';
        ghost.style.transform = 'none';
        ghost.setAttribute('data-anip-ghost', kind);
        ghost.setAttribute('aria-hidden', 'true');
        const exit = exitVector(target, kind);
        ghost.style.setProperty('--anip-ghost-exit-translate', exit.translate);
        ghost.style.setProperty('--anip-ghost-dialog-scale', exit.scale);
        ghost.style.transformOrigin = exit.origin;
        if (kind === 'dialog') {
          const panel = target.matches('[role="dialog"][aria-modal="true"]') ? ghost : ghost.querySelector('[role="dialog"][aria-modal="true"]');
          const fullscreen = target.matches('[role="dialog"][aria-modal="true"]') && (target.querySelector(':scope > header[data-window-drag]') !== null || target.querySelector(':scope > div > img') !== null);
          if (fullscreen) {
            ghost.style.animation = 'anip-ghost-fade-out ' + String(EXIT_DURATIONS[kind]) + 'ms cubic-bezier(0.4, 0, 1, 1) both';
          } else if (panel instanceof HTMLElement && panel !== ghost) {
            ghost.style.animation = 'anip-ghost-fade-out ' + String(EXIT_DURATIONS[kind]) + 'ms cubic-bezier(0.4, 0, 1, 1) both';
            panel.style.setProperty('--anip-ghost-exit-translate', exit.translate);
            panel.style.setProperty('--anip-ghost-dialog-scale', exit.scale);
            panel.style.transformOrigin = exit.origin;
            panel.style.transform = 'none';
            panel.style.animation = 'anip-ghost-dialog-out ' + String(EXIT_DURATIONS[kind]) + 'ms cubic-bezier(0.4, 0, 1, 1) both';
          } else {
            ghost.style.animation = 'anip-ghost-dialog-out ' + String(EXIT_DURATIONS[kind]) + 'ms cubic-bezier(0.4, 0, 1, 1) both';
          }
        } else {
          ghost.style.animation = EXIT_ANIMATIONS[kind] + ' ' + String(EXIT_DURATIONS[kind]) + 'ms cubic-bezier(0.4, 0, 1, 1) both';
        }
        document.body.appendChild(ghost);
        const remove = () => { ghost.remove(); };
        ghost.addEventListener('animationend', remove, { once: true });
        window.setTimeout(remove, EXIT_DURATIONS[kind] + 80);
        measured.delete(target);
        tracked.delete(target);
      }

      observer = new MutationObserver((records) => {
        if (disposed) return;
        for (const record of records) {
          for (const node of record.addedNodes) collect(node);
          for (const node of record.removedNodes) {
            const target = findTarget(node);
            if (target !== null) makeGhost(target);
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const measureTypes = ['pointerdown', 'pointerup', 'click', 'keydown'];
      const onMeasure = () => { if (!disposed) measure(); };
      for (const type of measureTypes) document.addEventListener(type, onMeasure, true);
      document.addEventListener('pointerout', onMeasure, true);
      document.addEventListener('scroll', scheduleMeasure, true);
      window.addEventListener('resize', scheduleMeasure, { passive: true });
      collect(document.body);

      return {
        dispose() {
          disposed = true;
          if (observer !== null) observer.disconnect();
          for (const type of measureTypes) document.removeEventListener(type, onMeasure, true);
          document.removeEventListener('pointerout', onMeasure, true);
          document.removeEventListener('scroll', scheduleMeasure, true);
          window.removeEventListener('resize', scheduleMeasure);
          if (frame !== 0) window.cancelAnimationFrame(frame);
          for (const ghost of document.querySelectorAll('[data-anip-ghost]')) ghost.remove();
        },
      };
    }

    /* --------------------------------------------------------------- motion -- */

    const MOTION_CSS = String.raw`/* == ANIP_CSS_START == */
/* 01 — design tokens. All durations/distances are shared by the whole layer. */
:root {
  --anip-ease-emphasized: cubic-bezier(0.16, 1, 0.3, 1);
  --anip-ease-standard: cubic-bezier(0.22, 1, 0.36, 1);
  --anip-ease-exit: cubic-bezier(0.4, 0, 1, 1);
  --anip-ease-spring: cubic-bezier(0.34, 1.36, 0.64, 1);
  --anip-dur-micro: 90ms;
  --anip-dur-fast: 150ms;
  --anip-dur-base: 200ms;
  --anip-dur-slow: 280ms;
  --anip-dur-panel: 320ms;
  --anip-menu-duration: 180ms;
  --anip-menu-distance: 4px;
  --anip-menu-scale: 0.97;
  --anip-menu-start: 0 calc(-1 * var(--anip-menu-distance));
  --anip-dialog-duration: 220ms;
  --anip-dialog-distance: 8px;
  --anip-dialog-scale: 0.97;
  --anip-dialog-blur: 2px;
  --anip-toast-duration: 280ms;
  --anip-toast-distance: 10px;
  --anip-toast-scale: 0.98;
  --anip-tip-distance: 2px;
  --anip-row-distance: 3px;
  --anip-row-duration: 150ms;
  --anip-chat-distance: 6px;
  --anip-chat-duration: 200ms;
}

/* The theme layer repeats this through overrideTokens; the CSS fallback keeps
   the easing even in a profile where ui-theme is unavailable. */
html[data-anip="on"] {
  --ds-ease-in-out: var(--anip-ease-standard);
}

html[data-anip-intensity="subtle"] {
  --anip-menu-duration: 150ms;
  --anip-menu-distance: 2px;
  --anip-menu-scale: 0.99;
  --anip-dialog-duration: 180ms;
  --anip-dialog-distance: 4px;
  --anip-dialog-scale: 0.99;
  --anip-toast-duration: 220ms;
  --anip-toast-distance: 6px;
  --anip-row-distance: 2px;
  --anip-chat-distance: 3px;
}

html[data-anip-intensity="expressive"] {
  --anip-menu-duration: 220ms;
  --anip-menu-distance: 8px;
  --anip-menu-scale: 0.95;
  --anip-dialog-duration: 260ms;
  --anip-dialog-distance: 12px;
  --anip-dialog-scale: 0.955;
  --anip-toast-duration: 320ms;
  --anip-toast-distance: 14px;
  --anip-row-distance: 6px;
  --anip-chat-distance: 10px;
}

/* 02 — menus, popovers, context menus and tooltips. */
@media (prefers-reduced-motion: no-preference) {
  html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-menu-material="translucent"]:not([data-menu-phase]) {
    transform-origin: top center;
    transition:
      translate var(--anip-menu-duration) var(--anip-ease-emphasized),
      scale var(--anip-menu-duration) var(--anip-ease-emphasized);
  }
  html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-menu-material="translucent"]:not([data-menu-phase]) > :not([aria-hidden="true"]) {
    transition: opacity calc(var(--anip-menu-duration) * 0.75) var(--anip-ease-standard);
  }
  /* The material is opaque for the first beat of the entrance so the page
     behind cannot show through while the translucent surface settles; the
     final frame restores the original fill and its backdrop blur. */
  html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-menu-material="translucent"]:not([data-menu-phase]) > [aria-hidden="true"] {
    animation: anip-menu-material-in var(--anip-menu-duration) var(--anip-ease-standard) both;
  }
  html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-menu-material="translucent"][data-anchor-side="top"]:not([data-menu-phase]),
  html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-menu-material="translucent"][style*="--dsh-model-anchor"]:not([data-menu-phase]),
  html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-menu-material="translucent"][data-trigger-menu]:not([data-menu-phase]),
  html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-slot="conversation.input.overlay"] [data-menu-material="translucent"]:not([data-menu-phase]) {
    transform-origin: bottom center;
  }
  html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-menu-material="translucent"][data-anchor-side="right"]:not([data-menu-phase]) {
    transform-origin: left center;
  }
  html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-menu-material="translucent"][data-anchor-align="end"]:not([data-menu-phase]) {
    transform-origin: top right;
  }
  html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-menu-material="translucent"][data-anchor-align="end"][data-anchor-side="top"]:not([data-menu-phase]) {
    transform-origin: bottom right;
  }
  @starting-style {
    html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-menu-material="translucent"]:not([data-menu-phase]) {
      translate: var(--anip-menu-start);
      scale: var(--anip-menu-scale);
    }
    html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-menu-material="translucent"][style*="--dsh-model-anchor"]:not([data-menu-phase]),
    html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-menu-material="translucent"][data-trigger-menu]:not([data-menu-phase]),
    html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-slot="conversation.input.overlay"] [data-menu-material="translucent"]:not([data-menu-phase]) {
      translate: 0 var(--anip-menu-distance);
    }
    html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-menu-material="translucent"][data-anchor-side="top"]:not([data-menu-phase]) {
      translate: 0 var(--anip-menu-distance);
    }
    html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-menu-material="translucent"][data-anchor-side="right"]:not([data-menu-phase]) {
      translate: calc(-1 * var(--anip-menu-distance)) 0;
    }
    html[data-anip="on"][data-anip-ready]:not(.anip-off-menus) [data-menu-material="translucent"]:not([data-menu-phase]) > :not([aria-hidden="true"]) {
      opacity: 0;
    }
  }

  html[data-anip="on"]:not(.anip-off-menus) [data-menu-phase="enter"] > :not([aria-hidden="true"]) {
    animation: anip-menu-enter 160ms var(--anip-ease-emphasized) both;
  }
  html[data-anip="on"]:not(.anip-off-menus) [data-menu-phase="enter"] > [aria-hidden="true"] {
    animation: anip-fade-in 80ms var(--anip-ease-emphasized) both;
  }
  html[data-anip="on"]:not(.anip-off-menus) [data-menu-phase="dismiss"] > :not([aria-hidden="true"]) {
    animation: anip-menu-exit 80ms var(--anip-ease-exit) both;
  }
  html[data-anip="on"]:not(.anip-off-menus) [data-menu-phase="dismiss"] > [aria-hidden="true"] {
    animation: anip-fade-out 80ms var(--anip-ease-exit) both;
  }
  html[data-anip="on"]:not(.anip-off-menus) [data-menu-phase="replace"] > :not([aria-hidden="true"]) {
    animation: anip-menu-replace 60ms var(--anip-ease-standard) both;
  }
  html[data-anip="on"]:not(.anip-off-menus) [data-menu-phase="replace"] > [aria-hidden="true"] {
    animation: anip-fade-out 60ms var(--anip-ease-standard) both;
  }
  html[data-anip="on"]:not(.anip-off-menus) [data-menu-backing][data-menu-phase="enter"] {
    animation: anip-backing-in 160ms var(--anip-ease-emphasized) both;
  }
  html[data-anip="on"]:not(.anip-off-menus) [data-menu-backing][data-menu-phase="dismiss"] {
    animation: anip-backing-out 80ms var(--anip-ease-exit) both;
  }

  html[data-anip="on"]:not(.anip-off-menus) [role="tooltip"] {
    animation: anip-tooltip-in 140ms var(--anip-ease-emphasized) both;
  }
  html[data-anip="on"] [role="tooltip"] {
    --anip-tip-start: 0 calc(-1 * var(--anip-tip-distance));
  }
  html[data-anip="on"] [role="tooltip"][data-side="top"] {
    --anip-tip-start: 0 var(--anip-tip-distance);
  }
  html[data-anip="on"] [role="tooltip"][data-side="right"] {
    --anip-tip-start: calc(-1 * var(--anip-tip-distance)) 0;
  }
  html[data-anip="on"] [role="tooltip"][data-side="left"] {
    --anip-tip-start: var(--anip-tip-distance) 0;
  }

  /* 03 — dialogs, settings and full-page panels. */
  html[data-anip="on"]:not(.anip-off-dialogs) [role="dialog"][aria-modal="true"]:not([data-shortcut-modal="sidebar"]):not(:has(> div > img)):not(:has(> header[data-window-drag])) {
    animation: anip-dialog-in var(--anip-dialog-duration) var(--anip-ease-emphasized) both;
  }
  html[data-anip="on"]:not(.anip-off-dialogs) [role="dialog"][aria-modal="true"][data-shortcut-modal="settings"] {
    --anip-dialog-scale: 0.985;
    --anip-dialog-distance: 6px;
    --anip-dialog-blur: 0px;
  }
  html[data-anip="on"]:not(.anip-off-dialogs) [role="dialog"][aria-modal="true"]:has(> header[data-window-drag]) {
    animation: anip-fade-in 160ms var(--anip-ease-standard) both;
  }
  html[data-anip="on"]:not(.anip-off-dialogs) [role="dialog"][aria-modal="true"]:has(> div > img) {
    animation: anip-fade-in 160ms var(--anip-ease-standard) both;
  }
  html[data-anip="on"]:not(.anip-off-dialogs) [role="presentation"]:has(> [role="dialog"][aria-modal="true"]) > [aria-hidden="true"]::after {
    animation: anip-mask-in 160ms var(--anip-ease-standard) both;
  }
  html[data-anip="on"]:not(.anip-off-dialogs) [role="presentation"]:has(> [data-shortcut-modal="settings"]) > [aria-hidden="true"] {
    animation: anip-mask-in 160ms var(--anip-ease-standard) both;
  }
  html[data-anip="on"][data-anip-ready]:not(.anip-off-pages) [data-global-panel] > [data-slot="main"] > * {
    animation: anip-page-in var(--anip-dur-panel) var(--anip-ease-emphasized) both;
  }
  html[data-anip="on"][data-anip-ready]:not(.anip-off-pages) [data-shortcut-modal="settings"] [data-slot="settings.section"] > * {
    animation: anip-page-in-small 180ms var(--anip-ease-emphasized) both;
  }

  /* 04 — notifications. */
  html[data-anip="on"]:not(.anip-off-toasts) body > [role="alert"] {
    animation:
      anip-toast-in var(--anip-toast-duration) var(--anip-ease-spring),
      anip-toast-fade 1000ms ease var(--dsh-toast-hold, 3000ms) forwards;
  }
  html[data-anip="on"][data-anip-ready]:not(.anip-off-toasts) [data-slot="shell.quota-notice"] > * {
    animation: anip-toast-in var(--anip-toast-duration) var(--anip-ease-spring) both;
  }

  /* 05 — left sidebar. The track duration belongs to the host (and perf-tuner);
     only content entrances are added here. */
  html[data-anip="on"][data-anip-ready]:not(.anip-off-sidebar) [data-slot="sidebar.workspaces"] [data-row-key] {
    transition: translate 160ms var(--anip-ease-standard);
  }
  @starting-style {
    html[data-anip="on"][data-anip-ready]:not(.anip-off-sidebar) [data-slot="sidebar.workspaces"] [data-row-key] {
      translate: 0 4px;
    }
  }
  html[data-anip="on"]:not(.anip-off-sidebar) [data-slot="sidebar.workspaces"] [data-row-key]:hover {
    translate: 2px 0;
  }
  /* A collapse gets the accelerate-out curve; the host still owns duration. */
  html[data-anip="on"][data-animating][data-sidebar-collapsed]:not(.anip-off-sidebar) {
    --ds-ease-in-out: var(--anip-ease-exit);
  }

  /* 06 — right panel, dock and list rows. */
  html[data-anip="on"][data-anip-ready]:not(.anip-off-rightbar) [data-sidebar-right-opening] [data-dockkit-pane] {
    animation: anip-panel-content-in var(--anip-dur-base) var(--anip-ease-emphasized) both;
  }
  /* The right panel keeps its host slide; closing gets the quicker exit curve. */
  html[data-anip="on"]:not(.anip-off-rightbar) [data-sidebar-right-panel]:not([data-sidebar-right-open]) {
    --ds-ease-in-out: var(--anip-ease-exit);
  }
  html[data-anip="on"][data-anip-ready]:not(.anip-off-rightbar) [data-sidebar-right-opening] [data-dockkit-pane] > * {
    animation: anip-fade-in 180ms var(--anip-ease-standard) both;
  }
  html[data-anip="on"][data-anip-ready]:not(.anip-off-lists) :is([data-files-entry], [data-plugin-row], [data-plugin-item], [data-session-schedule-task]) {
    transition:
      opacity var(--anip-row-duration) var(--anip-ease-standard),
      translate var(--anip-row-duration) var(--anip-ease-standard);
  }
  @starting-style {
    html[data-anip="on"][data-anip-ready]:not(.anip-off-lists) :is([data-files-entry], [data-plugin-row], [data-plugin-item], [data-session-schedule-task]) {
      opacity: 0;
      translate: 0 var(--anip-row-distance);
    }
  }
  html[data-anip="on"]:not(.anip-off-lists) :is([data-files-entry], [data-plugin-item]):hover {
    translate: 2px 0;
  }

  /* 07 — conversation rows. Only the last few rows of a mounted flow animate,
     so opening a long historic session never launches hundreds of animations. */
  html[data-anip="on"][data-anip-ready]:not(.anip-off-chat) [data-chat-flow-key]:not([data-chat-flow-kind="assistant-step"]):nth-last-child(-n+3) {
    transition:
      opacity var(--anip-chat-duration) var(--anip-ease-standard),
      translate var(--anip-chat-duration) var(--anip-ease-standard);
  }
  @starting-style {
    html[data-anip="on"][data-anip-ready]:not(.anip-off-chat) [data-chat-flow-key]:not([data-chat-flow-kind="assistant-step"]):nth-last-child(-n+3) {
      opacity: 0;
      translate: 0 var(--anip-chat-distance);
    }
  }
  html[data-anip="on"]:not(.anip-off-chat) [data-conversation-tabs] button {
    transition:
      color 160ms var(--anip-ease-standard),
      background-color 160ms var(--anip-ease-standard);
  }
  html[data-anip="on"][data-anip-ready]:not(.anip-off-chat) [data-scroll-down] {
    transition:
      opacity var(--anip-dur-fast) var(--anip-ease-standard),
      scale var(--anip-dur-fast) var(--anip-ease-spring);
  }
  @starting-style {
    html[data-anip="on"][data-anip-ready]:not(.anip-off-chat) [data-scroll-down] {
      opacity: 0;
      scale: 0.96;
    }
  }

  /* 08 — micro-interactions. */
  html[data-anip="on"]:not(.anip-off-micro) [role="switch"] > span {
    transition: transform 220ms var(--anip-ease-spring);
  }
  html[data-anip="on"]:not(.anip-off-micro) [role="tablist"] > span:first-child {
    transition: transform 200ms var(--anip-ease-emphasized);
  }

  /* 09 — keyframes. Kept local so no host CSS-Modules keyframe name is needed. */
  @keyframes anip-menu-enter {
    from {
      opacity: 0;
      scale: var(--anip-menu-scale, 0.97);
      translate: var(--anip-menu-start, 0 -4px);
    }
    to {
      opacity: 1;
      scale: 1;
      translate: 0 0;
    }
  }
  @keyframes anip-menu-exit {
    from { opacity: 1; scale: 1; }
    to { opacity: 0; scale: 0.99; }
  }
  @keyframes anip-menu-replace {
    from { opacity: 1; scale: 1; }
    to { opacity: 0; scale: 0.99; }
  }
  @keyframes anip-backing-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes anip-backing-out {
    from { opacity: 1; }
    to { opacity: 0; }
  }
  @keyframes anip-tooltip-in {
    from {
      opacity: 0;
      scale: 0.98;
      translate: var(--anip-tip-start, 0 -2px);
    }
    to {
      opacity: 1;
      scale: 1;
      translate: 0 0;
    }
  }
  @keyframes anip-dialog-in {
    from {
      opacity: 0;
      scale: var(--anip-dialog-scale, 0.97);
      translate: 0 var(--anip-dialog-distance, 8px);
      filter: blur(var(--anip-dialog-blur, 2px));
    }
    to {
      opacity: 1;
      scale: 1;
      translate: 0 0;
      filter: blur(0);
    }
  }
  @keyframes anip-mask-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes anip-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes anip-fade-out {
    from { opacity: 1; }
    to { opacity: 0; }
  }
  @keyframes anip-page-in {
    from {
      opacity: 0;
      translate: 0 8px;
      filter: blur(2px);
    }
    to {
      opacity: 1;
      translate: 0 0;
      filter: blur(0);
    }
  }
  @keyframes anip-page-in-small {
    from {
      opacity: 0;
      translate: 0 4px;
    }
    to {
      opacity: 1;
      translate: 0 0;
    }
  }
  @keyframes anip-toast-in {
    from {
      opacity: 0;
      scale: var(--anip-toast-scale, 0.98);
      translate: 0 var(--anip-toast-distance, 10px);
      filter: blur(4px);
    }
    to {
      opacity: 1;
      scale: 1;
      translate: 0 0;
      filter: blur(0);
    }
  }
  @keyframes anip-toast-fade {
    0%, 70% {
      opacity: 1;
      translate: 0 0;
    }
    to {
      opacity: 0;
      translate: 0 var(--anip-toast-distance, 10px);
      visibility: hidden;
    }
  }
  @keyframes anip-panel-content-in {
    from {
      opacity: 0;
      translate: 0 8px;
    }
    to {
      opacity: 1;
      translate: 0 0;
    }
  }
  @keyframes anip-ghost-menu-out {
    from { opacity: 1; scale: 1; translate: 0 0; }
    to { opacity: 0; scale: 0.97; translate: var(--anip-ghost-exit-translate, 0 -4px); }
  }
  @keyframes anip-ghost-dialog-out {
    from { opacity: 1; scale: 1; translate: 0 0; }
    to { opacity: 0; scale: var(--anip-ghost-dialog-scale, 0.97); translate: var(--anip-ghost-exit-translate, 0 8px); }
  }
  @keyframes anip-ghost-tip-out {
    from { opacity: 1; scale: 1; translate: 0 0; }
    to { opacity: 0; scale: 0.98; translate: var(--anip-ghost-exit-translate, 0 -2px); }
  }
  @keyframes anip-ghost-fade-out {
    from { opacity: 1; }
    to { opacity: 0; }
  }
  @keyframes anip-menu-material-in {
    from { background-color: var(--dsw-alias-bg-overlay); }
    to { background-color: var(--dsw-menu-surface-fill); }
  }
}
/* While a menu is open, the composer placeholder must not paint over it. */
html[data-anip="on"] body:has([data-menu-material="translucent"]) [data-composer-placeholder] {
  opacity: 0;
  transition: none;
}
@media (prefers-reduced-motion: no-preference) {
  html[data-anip="on"] [data-composer-placeholder] {
    transition: opacity 140ms var(--anip-ease-standard);
  }
}
/* Menus are overlay chrome: keep them above every composer surface even when
   a parent creates its own stacking context. */
html[data-anip="on"] [data-menu-material="translucent"] {
  z-index: 2147483000;
}

/* 10 — settings page (always themed, independent of the motion gate). */
.anip-heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 0 2px;
}
.anip-heading-title {
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
}
.anip-heading-desc {
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.anip-settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 2px 0 24px;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
}
.anip-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 18px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
}
.anip-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.anip-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.anip-title {
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
}
.anip-hint {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.anip-switch {
  position: relative;
  flex: none;
  width: 36px;
  height: 20px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3);
  cursor: pointer;
  transition: background-color 160ms var(--anip-ease-standard);
}
.anip-switch[aria-checked="true"] {
  background: var(--dsw-alias-brand-primary);
}
.anip-switch:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.anip-switch-thumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground);
  transition: transform 220ms var(--anip-ease-spring);
}
.anip-switch[aria-checked="true"] .anip-switch-thumb {
  transform: translateX(16px);
}
.anip-segment {
  display: inline-flex;
  flex: none;
  gap: 2px;
  padding: 2px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
}
.anip-segment-item {
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: calc(var(--dsw-radius-md) - 2px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 160ms var(--anip-ease-standard), color 160ms var(--anip-ease-standard);
}
.anip-segment-item[aria-pressed="true"] {
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
  box-shadow: 0 0 0 0.5px var(--dsw-alias-border-l3);
}
.anip-group-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.anip-group-label {
  min-width: 0;
}
.anip-reset {
  align-self: flex-start;
  height: 28px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.anip-reset:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
@media (max-width: 620px) {
  .anip-row {
    align-items: flex-start;
  }
  .anip-segment {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
}
@media (prefers-reduced-motion: reduce) {
  .anip-switch,
  .anip-switch-thumb,
  .anip-segment-item {
    transition: none;
  }
}
/* == ANIP_CSS_END == */`;

    /** Append the stylesheet once per document, keyed for HMR bookkeeping. */
    function installStyles() {
      if (typeof document === 'undefined') return undefined;
      const existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']');
      if (existing !== null) return undefined;
      const tag = document.createElement('style');
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = MOTION_CSS;
      document.head.appendChild(tag);
      return tag;
    }

    /** Resolve the theme service without assuming the accessor this build offers. */
    function themeService(ctx) {
      const direct = ctx.theme;
      if (direct !== undefined && typeof direct.overrideTokens === 'function') return direct;
      const viaGet = typeof ctx.get === 'function' ? ctx.get('theme') : undefined;
      if (viaGet !== undefined && typeof viaGet.overrideTokens === 'function') return viaGet;
      return undefined;
    }

    /* --------------------------------------------------------------- locale -- */

    const EN = {
      nav: 'AniPlus',
      title: 'AniPlus motion',
      intro: 'A shared non-linear motion layer for the interface. Changes apply immediately and are stored in this browser.',
      enabled: 'Motion enabled',
      enabledHint: 'Turn the whole motion layer on or off. Off restores the native DSH feel.',
      intensity: 'Intensity',
      intensityHint: 'Controls distance, scale and duration. Standard is recommended.',
      subtle: 'Subtle',
      standard: 'Standard',
      expressive: 'Expressive',
      groups: 'Motion groups',
      groupsHint: 'Each group can be disabled independently.',
      groupMenus: 'Menus and popovers',
      groupDialogs: 'Dialogs and windows',
      groupToasts: 'Notifications',
      groupSidebar: 'Left sidebar',
      groupRightbar: 'Right sidebar and dock',
      groupLists: 'Lists',
      groupChat: 'Conversation',
      groupMicro: 'Micro-interactions',
      groupPages: 'Pages and panels',
      groupExits: 'Retract animations',
      reset: 'Reset to defaults',
    };
    const ZH = {
      nav: 'AniPlus',
      title: 'AniPlus 动效',
      intro: '统一的非线性动效层，修改立即生效并保存在当前浏览器。',
      enabled: '启用动效',
      enabledHint: '关闭后完全恢复 DSH 原生观感。',
      intensity: '动效强度',
      intensityHint: '控制位移、缩放与时长，推荐标准档。',
      subtle: '克制',
      standard: '标准',
      expressive: '活泼',
      groups: '动效分组',
      groupsHint: '每组都可以独立关闭。',
      groupMenus: '菜单与浮层',
      groupDialogs: '对话框与窗口',
      groupToasts: '通知',
      groupSidebar: '左侧栏',
      groupRightbar: '右侧栏与工作台',
      groupLists: '列表',
      groupChat: '对话',
      groupMicro: '微交互',
      groupPages: '页面与面板',
      groupExits: '收起动画',
      reset: '恢复默认',
    };
    const LOCALE_DICTS = { en: EN, zh: ZH, ja: EN, es: EN, fr: EN, de: EN, ru: EN, pt: EN };

    const GROUP_LABELS = {
      menus: 'groupMenus',
      dialogs: 'groupDialogs',
      toasts: 'groupToasts',
      sidebar: 'groupSidebar',
      rightbar: 'groupRightbar',
      lists: 'groupLists',
      chat: 'groupChat',
      micro: 'groupMicro',
      pages: 'groupPages',
      exits: 'groupExits',
    };

    /* ------------------------------------------------------------- settings UI -- */

    function ToggleSwitch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked,
        'aria-label': props.label,
        className: 'anip-switch',
        onClick: () => { props.onChange(!props.checked) },
      }, h('span', { className: 'anip-switch-thumb' }));
    }

    function makeSettingsSection(t) {
      return function SettingsSection() {
        const [state, setState] = React.useState(settingsStore.get());
        React.useEffect(() => settingsStore.subscribe(() => setState(settingsStore.get())), []);
        return h('div', { className: 'anip-settings' },
          h('div', { className: 'anip-heading' },
            h('div', { className: 'anip-heading-title' }, t('title')),
            h('div', { className: 'anip-heading-desc' }, t('intro'))),
          h('section', { className: 'anip-card' },
            h('div', { className: 'anip-row' },
              h('div', { className: 'anip-copy' },
                h('div', { className: 'anip-title' }, t('enabled')),
                h('div', { className: 'anip-hint' }, t('enabledHint'))),
              h(ToggleSwitch, {
                checked: state.enabled,
                label: t('enabled'),
                onChange: value => { settingsStore.set({ enabled: value }) },
              })),
            h('div', { className: 'anip-row' },
              h('div', { className: 'anip-copy' },
                h('div', { className: 'anip-title' }, t('intensity')),
                h('div', { className: 'anip-hint' }, t('intensityHint'))),
              h('div', { className: 'anip-segment', role: 'group', 'aria-label': t('intensity') },
                INTENSITIES.map(value => h('button', {
                  key: value,
                  type: 'button',
                  className: 'anip-segment-item',
                  'aria-pressed': state.intensity === value,
                  onClick: () => { settingsStore.set({ intensity: value }) },
                }, t(value))))),
          ),
          h('section', { className: 'anip-card' },
            h('div', { className: 'anip-copy' },
              h('div', { className: 'anip-title' }, t('groups')),
              h('div', { className: 'anip-hint' }, t('groupsHint'))),
            h('div', { className: 'anip-group-list' },
              GROUP_KEYS.map(key => h('div', { className: 'anip-row', key },
                h('span', { className: 'anip-group-label' }, t(GROUP_LABELS[key])),
                h(ToggleSwitch, {
                  checked: state.groups[key],
                  label: t(GROUP_LABELS[key]),
                  onChange: value => {
                    settingsStore.set({ groups: Object.assign({}, state.groups, { [key]: value }) });
                  },
                }))))),
          h('button', {
            type: 'button',
            className: 'anip-reset',
            onClick: () => { settingsStore.reset() },
          }, t('reset')));
      };
    }

    function AniPlusIcon(props) {
      const size = props !== null && typeof props === 'object' && typeof props.size === 'number' ? props.size : 16;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 36 36',
        fill: 'none',
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M6 25.5C10.5 25.5 10.5 10.5 15 10.5C19.5 10.5 19.5 25.5 24 25.5C27 25.5 28.5 21.5 30 18',
        stroke: 'currentColor',
        strokeWidth: 2.6,
        strokeLinecap: 'round',
      }),
      h('path', {
        d: 'M6 30H17',
        stroke: 'currentColor',
        strokeWidth: 2.2,
        strokeLinecap: 'round',
        opacity: 0.65,
      }),
      h('circle', { cx: 30, cy: 18, r: 2.2, fill: 'currentColor' }));
    }

    /* ------------------------------------------------------------------ apply -- */

    function apply(ctx) {
      ctx.effect(() => {
        const tag = installStyles();
        return () => {
          if (tag !== undefined) tag.remove();
        };
      }, PLUGIN_ID + ': motion stylesheet');

      ctx.effect(() => {
        const theme = themeService(ctx);
        if (theme === undefined) {
          console.warn(PLUGIN_ID + ': theme service unavailable; global easing override skipped');
          return;
        }
        return theme.overrideTokens(PLUGIN_ID, {
          '--ds-ease-in-out': {
            light: 'cubic-bezier(0.22, 1, 0.36, 1)',
            dark: 'cubic-bezier(0.22, 1, 0.36, 1)',
          },
        });
      }, PLUGIN_ID + ': global easing layer');

      ctx.effect(() => {
        const unsubscribe = settingsStore.subscribe(() => { applySettingsToDom(settingsStore.get()) });
        applySettingsToDom(settingsStore.get());
        return () => {
          unsubscribe();
          clearSettingsFromDom();
        };
      }, PLUGIN_ID + ': settings projection');

      ctx.effect(() => {
        const controller = createExitGhostController(settingsStore);
        return () => { controller.dispose(); };
      }, PLUGIN_ID + ': retract ghosts');

      ctx.effect(() => {
        let first = 0;
        let second = 0;
        first = window.requestAnimationFrame(() => {
          second = window.requestAnimationFrame(() => {
            document.documentElement.setAttribute('data-anip-ready', '');
          });
        });
        return () => {
          window.cancelAnimationFrame(first);
          window.cancelAnimationFrame(second);
          document.documentElement.removeAttribute('data-anip-ready');
        };
      }, PLUGIN_ID + ': entrance gate');

      ctx.inject(['slots', 'locale'], (child) => {
        const t = child.locale.bind(LOCALE_NS);
        child.effect(() => child.locale.register(LOCALE_NS, LOCALE_DICTS), PLUGIN_ID + ': settings dictionaries');
        child.effect(() => child.slots.inject('settings.section', () => child.slots.register({
          name: 'settings.section',
          id: 'aniplus',
          order: 260,
          label: () => t('nav'),
        }, makeSettingsSection(t))), PLUGIN_ID + ': settings section');
        child.effect(() => child.slots.inject('settings.section.icon', () => child.slots.register({
          name: 'settings.section.icon',
          id: 'aniplus',
          order: 260,
          label: () => t('nav'),
        }, AniPlusIcon)), PLUGIN_ID + ': settings navigation icon');
      });
    }

    exports.inject = ['theme'];
    exports.apply = apply;
    return module.exports;
  },
});
