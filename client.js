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

    const GROUP_KEYS = ['menus', 'dialogs', 'toasts', 'sidebar', 'rightbar', 'lists', 'chat', 'micro', 'pages', 'exits', 'dock', 'press'];
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
        dock: true,
        press: true,
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
      '[style*="position-anchor: --dsh-context-"]',
      '[style*="position-anchor:--dsh-context-"]',
      '[style*="position-anchor: --dsh-stat-"]',
      '[style*="position-anchor:--dsh-stat-"]',
    ].join(',');
    const EXIT_HINT = '[data-menu-material], [role="dialog"], [role="tooltip"], [data-quote-popover], [data-document-viewer-menu], [role="presentation"]';
    const EXIT_KINDS = [
      ['[data-menu-material="translucent"]', 'menu'],
      ['[role="tooltip"]', 'tooltip'],
      ['[data-quote-popover]', 'menu'],
      ['[data-document-viewer-menu]', 'menu'],
      ['[style*="position-anchor: --dsh-context-"]', 'menu'],
      ['[style*="position-anchor:--dsh-context-"]', 'menu'],
      ['[style*="position-anchor: --dsh-stat-"]', 'menu'],
      ['[style*="position-anchor:--dsh-stat-"]', 'menu'],
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
          const styleAttr = target.getAttribute('style') || '';
          const dockPanel = styleAttr.includes('position-anchor: --dsh-context-') || styleAttr.includes('position-anchor:--dsh-context-') || styleAttr.includes('position-anchor: --dsh-stat-') || styleAttr.includes('position-anchor:--dsh-stat-');
          const side = modelMenu || composerOverlay || dockPanel ? 'top' : (target.getAttribute('data-anchor-side') || 'bottom');
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

    /* ------------------------------------------------------- press feedback -- */

    const TILT_SELECTOR = '[data-menu-material="translucent"]';
    const PRESS_SELECTOR = 'button';

    /**
     * Miuix SinkFeedback port plus a press-follow tilt: every button gets the
     * press sink (WAAPI keeps host transitions untouched), while tilt engages
     * only on small menu panels, follows the pointer through a damped rAF loop
     * (no CSS transition on transform) and rebounds smoothly on release. One
     * pressed button and one tilted panel at a time.
     */
    function installPressFeedback(settings) {
      if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
      // tilt-refactor: damping knobs. tau = exponential time constant of the
      // follow (larger = softer/slower), eps = settle threshold, size guard
      // keeps the effect on small menu panels only. All tunable.
      const TILT_TAU_MS = 70;
      const TILT_SETTLE_EPS = 0.05;
      const TILT_MAX_WIDTH = 420;
      const TILT_MAX_HEIGHT = 480;
      let tracked = null; // { el, maxDeg }
      let pressed = null;
      let raf = 0;
      let last = 0;
      let rx = 0;
      let ry = 0;
      let trx = 0;
      let tryTarget = 0;

      function allowed() {
        const current = settings.get();
        return current.enabled && current.groups.press && !reduced.matches;
      }

      const pressAnimations = new WeakMap();

      /**
       * Read the Miuix SinkFeedback tokens from the button itself. The values
       * stay in CSS so intensity profiles and theme overrides keep working.
       */
      function pressTokensOf(el) {
        const style = window.getComputedStyle(el);
        const scale = Number.parseFloat(style.getPropertyValue('--anip-sink-scale'));
        const duration = Number.parseFloat(style.getPropertyValue('--anip-press-sink-duration'));
        const easing = style.getPropertyValue('--anip-ease-miuix-sink').trim();
        if (!Number.isFinite(scale) || !Number.isFinite(duration) || easing === '') return null;
        return { scale, duration, easing };
      }

      function animatePress(el, target) {
        if (typeof el.animate !== 'function' || !window.CSS || !window.CSS.supports('scale', '1')) return;
        const tokens = pressTokensOf(el);
        if (tokens === null) return;
        const current = Number.parseFloat(window.getComputedStyle(el).scale);
        const previous = pressAnimations.get(el);
        if (previous !== undefined) previous.cancel();
        let animation;
        try {
          animation = el.animate(
            [{ scale: String(Number.isFinite(current) ? current : 1) }, { scale: String(target === 'sink' ? tokens.scale : 1) }],
            { duration: tokens.duration, easing: tokens.easing, fill: 'forwards' }
          );
        } catch {
          /* A browser without linear() support keeps the static button; motion is optional. */
          return;
        }
        pressAnimations.set(el, animation);
        animation.onfinish = () => {
          if (pressAnimations.get(el) !== animation) return;
          pressAnimations.delete(el);
          if (target !== 'sink') animation.cancel();
        };
      }

      function releasePress() {
        if (pressed === null) return;
        const el = pressed;
        pressed = null;
        if (el.isConnected && allowed()) {
          animatePress(el, 'rest');
          return;
        }
        const animation = pressAnimations.get(el);
        if (animation !== undefined) {
          animation.cancel();
          pressAnimations.delete(el);
        }
      }
      function clearTilt(el) {
        if (el === null) return;
        el.style.removeProperty('--anip-tilt-rx');
        el.style.removeProperty('--anip-tilt-ry');
      }

      function stopLoop() {
        if (raf !== 0) {
          window.cancelAnimationFrame(raf);
          raf = 0;
        }
      }

      // tilt-refactor: one damped-lerp loop owns the whole tilt lifecycle:
      // follow while the pointer is pressed, rebound to rest on release,
      // and self-stop once settled (vars removed so CSS falls back to 0deg).
      function frame(now) {
        raf = 0;
        if (tracked === null || !tracked.el.isConnected) {
          clearTilt(tracked === null ? null : tracked.el);
          tracked = null;
          return;
        }
        if (!allowed()) {
          trx = 0;
          tryTarget = 0;
        }
        const dt = Math.min(64, now - last);
        last = now;
        const k = 1 - Math.exp(-dt / TILT_TAU_MS);
        rx += (trx - rx) * k;
        ry += (tryTarget - ry) * k;
        tracked.el.style.setProperty('--anip-tilt-rx', rx.toFixed(2) + 'deg');
        tracked.el.style.setProperty('--anip-tilt-ry', ry.toFixed(2) + 'deg');
        if (trx === 0 && tryTarget === 0 && Math.abs(rx) < TILT_SETTLE_EPS && Math.abs(ry) < TILT_SETTLE_EPS) {
          clearTilt(tracked.el);
          tracked = null;
          return;
        }
        raf = window.requestAnimationFrame(frame);
      }

      function beginTracking(el) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1 || rect.width > TILT_MAX_WIDTH || rect.height > TILT_MAX_HEIGHT) return false;
        const maxDeg = Math.abs(parseFloat(window.getComputedStyle(el).getPropertyValue('--anip-tilt-amount')) || 0) || 4;
        if (tracked !== null && tracked.el !== el) clearTilt(tracked.el);
        tracked = { el, maxDeg };
        rx = 0;
        ry = 0;
        trx = 0;
        tryTarget = 0;
        last = window.performance.now();
        if (raf === 0) raf = window.requestAnimationFrame(frame);
        return true;
      }

      function aimTiltAt(el, event) {
        const rect = el.getBoundingClientRect();
        const nx = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
        const ny = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1));
        // Signs keep the Miuix convention: the panel leans into the pointer,
        // as if the pressed point were pushed down.
        trx = -ny * tracked.maxDeg;
        tryTarget = nx * tracked.maxDeg;
      }

      function onPointerMove(event) {
        if (tracked === null || raf === 0) return;
        // tilt-follow only while a button is held: a missed pointerup (e.g. released
        // outside the window) must not leave the panel leaning and following hovers.
        if (event.buttons === 0) { onPointerUp(); return; }
        const target = event.target;
        if (!(target instanceof Element) || !tracked.el.contains(target)) return;
        aimTiltAt(tracked.el, event);
      }

      function onPointerDown(event) {
        if (!allowed()) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest(PRESS_SELECTOR);
        if (button !== null && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
          if (pressed !== null && pressed !== button) releasePress();
          pressed = button;
          animatePress(button, 'sink');
        }
        const panel = target.closest(TILT_SELECTOR);
        if (panel !== null && beginTracking(panel)) aimTiltAt(panel, event);
      }

      function onPointerUp() {
        releasePress();
        if (tracked !== null) {
          trx = 0;
          tryTarget = 0;
        }
      }

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerdown', onPointerDown, true);
      window.addEventListener('pointerup', onPointerUp, { passive: true });
      window.addEventListener('pointercancel', onPointerUp, { passive: true });
      const unsubscribe = settings.subscribe(() => {
        if (!allowed()) {
          trx = 0;
          tryTarget = 0;
          releasePress();
        }
      });

      return () => {
        stopLoop();
        clearTilt(tracked === null ? null : tracked.el);
        tracked = null;
        releasePress();
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerdown', onPointerDown, true);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
        unsubscribe();
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
  /* Miuix-derived curves: springs precomputed from the exact ODE
     (damping/stiffness taken from Miuix source, see README Credits). */
  --anip-ease-miuix-popup: linear(0, 2.5% 0.0163, 5% 0.0588, 7.5% 0.1191, 10% 0.1906, 12.5% 0.268, 15% 0.3474, 17.5% 0.4258, 20% 0.5009, 22.5% 0.5714, 25% 0.6363, 27.5% 0.6951, 30% 0.7476, 32.5% 0.7938, 35% 0.8341, 37.5% 0.8687, 40% 0.8981, 42.5% 0.9227, 45% 0.9432, 47.5% 0.9599, 50% 0.9734, 52.5% 0.9841, 55% 0.9924, 57.5% 0.9988, 60% 1.0034, 62.5% 1.0067, 65% 1.0089, 67.5% 1.0103, 70% 1.0109, 72.5% 1.0111, 75% 1.0109, 77.5% 1.0103, 80% 1.0096, 82.5% 1.0088, 85% 1.008, 87.5% 1.0071, 90% 1.0062, 92.5% 1.0054, 95% 1.0046, 97.5% 1.0039, 100% 1.0033);
  --anip-ease-miuix-sink: linear(0, 2.5% 0.0173, 5% 0.0622, 7.5% 0.1259, 10% 0.2011, 12.5% 0.2823, 15% 0.3653, 17.5% 0.4468, 20% 0.5245, 22.5% 0.5969, 25% 0.6631, 27.5% 0.7226, 30% 0.7751, 32.5% 0.8209, 35% 0.8603, 37.5% 0.8936, 40% 0.9215, 42.5% 0.9445, 45% 0.9631, 47.5% 0.9779, 50% 0.9894, 52.5% 0.9982, 55% 1.0047, 57.5% 1.0093, 60% 1.0123, 62.5% 1.0141, 65% 1.015, 67.5% 1.0151, 70% 1.0147, 72.5% 1.014, 75% 1.0129, 77.5% 1.0118, 80% 1.0105, 82.5% 1.0093, 85% 1.0081, 87.5% 1.0069, 90% 1.0058, 92.5% 1.0048, 95% 1.004, 97.5% 1.0032, 100% 1.0025);
  --anip-ease-miuix-alpha: cubic-bezier(0.4, 0, 0.2, 1);
  --anip-dock-duration: 400ms;
  --anip-dock-distance: 6px;
  --anip-dock-scale: 0.97;
  --anip-tilt-amount: 4deg;
  --anip-tilt-perspective: 900px;
  --anip-tilt-tau: 70ms;
  --anip-sink-scale: 0.94;
  --anip-press-sink-duration: 320ms;
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
  --anip-dock-duration: 340ms;
  --anip-dock-distance: 3px;
  --anip-dock-scale: 0.99;
  --anip-tilt-amount: 3deg;
  --anip-sink-scale: 0.96;
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
  --anip-dock-duration: 460ms;
  --anip-dock-distance: 10px;
  --anip-dock-scale: 0.96;
  --anip-tilt-amount: 5deg;
  --anip-sink-scale: 0.93;
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

/* 09a — dock panels: composer bottom info indicator pop-ups
   (ContextMeter and StatsPills dialogs; entrance is pure CSS via
   @starting-style because the host mounts them fresh on open). */
@media (prefers-reduced-motion: no-preference) {
  html[data-anip="on"][data-anip-ready]:not(.anip-off-dock) [style*="position-anchor: --dsh-context-"],
  html[data-anip="on"][data-anip-ready]:not(.anip-off-dock) [style*="position-anchor:--dsh-context-"],
  html[data-anip="on"][data-anip-ready]:not(.anip-off-dock) [style*="position-anchor: --dsh-stat-"],
  html[data-anip="on"][data-anip-ready]:not(.anip-off-dock) [style*="position-anchor:--dsh-stat-"] {
    transform-origin: bottom center;
    transition:
      opacity 200ms var(--anip-ease-miuix-alpha),
      translate var(--anip-dock-duration) var(--anip-ease-miuix-popup),
      scale var(--anip-dock-duration) var(--anip-ease-miuix-popup),
      filter 200ms var(--anip-ease-miuix-alpha);
    @starting-style {
      opacity: 0;
      translate: 0 var(--anip-dock-distance);
      scale: var(--anip-dock-scale);
      filter: blur(var(--anip-dialog-blur));
    }
  }
}

/* 09b — press feedback (tilt-refactor: press-follow tilt on small menu
   panels, active only while the pointer is pressed; the damped rAF loop in
   installPressFeedback owns the motion. Every button gets a WAAPI press sink,
   so no CSS transition is used for it either). */
@media (prefers-reduced-motion: no-preference) {
  html[data-anip="on"][data-anip-ready]:not(.anip-off-press) [data-menu-material="translucent"] {
    transform: perspective(var(--anip-tilt-perspective)) rotateX(var(--anip-tilt-rx, 0deg)) rotateY(var(--anip-tilt-ry, 0deg));
    transform-origin: center;
  }
}

html[data-anip="on"] button:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
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
.anip-switch:focus-visible,
.anip-segment-item:focus-visible,
.anip-reset:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
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
      groupDock: 'Dock panels',
      groupPress: 'Press & tilt feedback',
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
      groupDock: '底部信息面板',
      groupPress: '按压与倾斜反馈',
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
      dock: 'groupDock',
      press: 'groupPress',
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
        const dispose = installPressFeedback(settingsStore);
        return () => { dispose(); };
      }, PLUGIN_ID + ': press feedback');

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
