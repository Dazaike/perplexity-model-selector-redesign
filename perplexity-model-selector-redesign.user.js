// ==UserScript==
// @name         Perplexity Model Selector Redesign
// @namespace    https://perplexity.ai/
// @version      2.2.18
// @description  Non-thinking/Thinking model picker for Perplexity, plus one-shot /rest/models/config change watch on page load.
// @author       Dazaike
// @match        https://www.perplexity.ai/*
// @match        https://perplexity.ai/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @homepageURL  https://github.com/Dazaike/perplexity-model-selector-redesign
// @supportURL   https://github.com/Dazaike/perplexity-model-selector-redesign/issues
// @downloadURL  https://raw.githubusercontent.com/Dazaike/perplexity-model-selector-redesign/main/perplexity-model-selector-redesign.user.js
// @updateURL    https://raw.githubusercontent.com/Dazaike/perplexity-model-selector-redesign/main/perplexity-model-selector-redesign.user.js
// ==/UserScript==

(function () {
  "use strict";

  if (window.__pplxModelUIv2Installed) return;
  window.__pplxModelUIv2Installed = true;

  const LS_HIDDEN = "pmu_hidden_models";
  const TM_CONFIG_HASH = "pmu_models_config_hash";
  const TM_CONFIG_JSON = "pmu_models_config_last";
  const TM_CONFIG_PREV = "pmu_models_config_prev";
  const TM_CONFIG_UPDATED = "pmu_models_config_updated_at";
  const STYLE_ID = "pmu-style-v2";

  const state = {
    trigger: null,
    panel: null,
    menu: null,
    lastModels: null, // unlocked models from last showPanel (for early pointerdown pick)
    lastAllModels: null, // full model list for Edit view
    busy: false, // selecting / driving native menu
    picking: false, // pointer is down on our panel — don't tear it down when Radix closes
    pickTimer: null,
    editMode: false,
    ignoreSelectUntil: 0,
    suppressPanelUntil: 0,
    menuLock: null,
  };

  // —— persistence ————————————————————————————————————————————————

  function loadHidden() {
    try {
      return new Set(JSON.parse(localStorage.getItem(LS_HIDDEN) || "[]"));
    } catch {
      return new Set();
    }
  }
  function saveHidden(set) {
    localStorage.setItem(LS_HIDDEN, JSON.stringify([...set]));
  }

  // —— model classification ————————————————————————————————————————

  function isForcedThinking(name) {
    return /gemini/i.test(name) || /\bglm\b/i.test(name) || /nemotron/i.test(name) || /\bkimi\b/i.test(name);
  }
  function isStandardOnly(name) {
    return /sonar/i.test(name);
  }
  function isOptionalThinking(name) {
    return !isForcedThinking(name) && !isStandardOnly(name) && /claude|gpt|grok|terra/i.test(name);
  }

  // —— styles ——————————————————————————————————————————————————————

  if (!document.getElementById("pmu-font-lexend")) {
    const pre1 = document.createElement("link");
    pre1.rel = "preconnect";
    pre1.href = "https://fonts.googleapis.com";
    const pre2 = document.createElement("link");
    pre2.rel = "preconnect";
    pre2.href = "https://fonts.gstatic.com";
    pre2.crossOrigin = "anonymous";
    const font = document.createElement("link");
    font.id = "pmu-font-lexend";
    font.rel = "stylesheet";
    font.href =
      "https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600;700&display=swap";
    document.documentElement.appendChild(pre1);
    document.documentElement.appendChild(pre2);
    document.documentElement.appendChild(font);
  }

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* Hide native menus while our panel is up, or while we expect/drive one. */
      [data-pmu-hidden="1"],
      body.pmu-expect [role="menu"][data-state="open"],
      body.pmu-busy [role="menu"] {
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      .pmu-panel {
        position: fixed; z-index: 2147483647; width: 360px; max-height: 32rem;
        overflow-y: auto; scrollbar-width: none; -ms-overflow-style: none;
        background: #1e1d1c; border: 1px solid rgba(214,213,212,0.14);
        border-radius: 0.85rem;
        box-shadow: 0 20px 48px -12px rgba(0,0,0,0.55), 0 4px 12px -2px rgba(0,0,0,0.35);
        padding: 0.5rem;
        font-family: "Lexend", system-ui, sans-serif;
        color: #d6d5d4; font-size: 14px;
        transform-origin: top right;
        animation: pmu-in .15s ease-out;
      }
      .pmu-panel.pmu-above {
        transform-origin: bottom right;
        animation-name: pmu-in-up;
      }
      .pmu-panel button { font-family: "Lexend", system-ui, sans-serif; }
      .pmu-panel::-webkit-scrollbar { display: none; }
      @keyframes pmu-in {
        from { opacity: 0; transform: translateY(-6px) scale(.98); }
        to   { opacity: 1; transform: none; }
      }
      @keyframes pmu-in-up {
        from { opacity: 0; transform: translateY(6px) scale(.98); }
        to   { opacity: 1; transform: none; }
      }

      @media (prefers-color-scheme: light) {
        .pmu-panel {
          background: #fdfbfa; border-color: rgba(39,37,30,0.14); color: #27251e;
          box-shadow: 0 20px 48px -12px rgba(0,0,0,0.16), 0 4px 12px -2px rgba(0,0,0,0.07);
        }
        .pmu-col-head, .pmu-group-title, .pmu-edit-title { color: #27251e !important; }
        .pmu-group-hint { color: rgba(39,37,30,0.55) !important; }
        .pmu-cell:hover, .pmu-cell.pmu-selected, .pmu-option:hover { background: rgba(39,37,30,0.07) !important; }
        .pmu-cell.pmu-selected .pmu-cell-name { color: #27251e !important; }
        .pmu-cell.pmu-selected .pmu-mini-icon svg, .pmu-mini-icon svg { fill: #27251e !important; }
        .pmu-footer-row:hover { background: rgba(39,37,30,0.05) !important; }
      }

      .pmu-cols {
        display: grid; grid-template-columns: 1fr 1fr; column-gap: .35rem; row-gap: .05rem;
        padding: .3rem; align-items: stretch;
      }
      .pmu-col-head {
        font-size: .64rem; letter-spacing: .09em; text-transform: uppercase; font-weight: 700;
        color: rgba(214,213,212,0.65); padding: 0 .35rem .3rem;
      }
      .pmu-cell-spacer { min-height: 1px; pointer-events: none; }
      .pmu-cell {
        display: flex; align-items: center; gap: .4rem; width: 100%; border: none; background: transparent;
        padding: .4rem .35rem; border-radius: .5rem; cursor: pointer; text-align: left; color: inherit; font: inherit;
        min-width: 0; transition: background .1s, transform .1s;
      }
      .pmu-cell:hover { background: rgba(214,213,212,0.06); }
      .pmu-cell:active { background: rgba(214,213,212,0.14); transform: scale(.98); }
      .pmu-cell.pmu-selected { background: rgba(214,213,212,0.12); }
      .pmu-cell-name { font-size: .78rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
      .pmu-cell.pmu-selected .pmu-cell-name { color: #fff; font-weight: 600; }
      .pmu-mini-icon {
        width: 1.3rem; height: 1.3rem; border-radius: .35rem; display: flex; align-items: center;
        justify-content: center; flex-shrink: 0;
      }
      .pmu-mini-icon svg { width: 14px; height: 14px; fill: rgba(214,213,212,0.85); }
      .pmu-cell.pmu-selected .pmu-mini-icon svg { fill: #fff; }

      .pmu-option {
        display: flex; align-items: center; gap: .6rem; width: 100%; border: none; background: transparent;
        padding: .5rem; border-radius: .55rem; cursor: pointer; text-align: left; color: inherit; font: inherit;
      }
      .pmu-option:hover { background: rgba(214,213,212,0.06); }
      .pmu-icon {
        width: 1.7rem; height: 1.7rem; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      }
      .pmu-icon svg { width: 16px; height: 16px; fill: rgba(214,213,212,0.85); }
      .pmu-name { font-size: .87rem; font-weight: 600; }
      .pmu-lockicon { width: 14px; height: 14px; flex-shrink: 0; fill: rgba(214,213,212,0.65); margin-left: auto; }

      .pmu-group { padding: .4rem .3rem .5rem; border-top: 1px solid rgba(214,213,212,0.14); }
      .pmu-group-head { display: flex; align-items: baseline; justify-content: space-between; padding: .25rem .5rem .35rem; }
      .pmu-group-title { font-size: .66rem; letter-spacing: .09em; text-transform: uppercase; font-weight: 700; color: rgba(214,213,212,0.85); }
      .pmu-group-hint { font-size: .66rem; color: rgba(214,213,212,0.65); }

      .pmu-footer { border-top: 1px solid rgba(214,213,212,0.14); margin-top: .35rem; padding-top: .3rem; }
      .pmu-footer-row {
        display: flex; align-items: center; justify-content: space-between; width: 100%; border: none;
        background: transparent; padding: .5rem .6rem; border-radius: .55rem; cursor: pointer;
        text-align: left; color: inherit; font: inherit; font-size: .82rem;
      }
      .pmu-footer-row:hover { background: rgba(214,213,212,0.035); }

      .pmu-edit-header { display: flex; align-items: center; justify-content: space-between; padding: .4rem .5rem .6rem; }
      .pmu-edit-title { font-size: .8rem; font-weight: 700; }
      .pmu-edit-done {
        border: none; background: rgba(78,153,163,0.15); color: #4e99a3; font-size: .76rem; font-weight: 600;
        padding: .3rem .7rem; border-radius: .4rem; cursor: pointer;
      }
      .pmu-edit-row { display: flex; align-items: center; gap: .6rem; padding: .45rem .5rem; border-radius: .5rem; }
      .pmu-edit-row:hover { background: rgba(214,213,212,0.035); }
      .pmu-edit-name { flex: 1; min-width: 0; font-size: .82rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pmu-eye-btn {
        border: none; background: transparent; cursor: pointer; padding: .25rem; border-radius: .35rem;
        display: flex; color: rgba(214,213,212,0.65);
      }
      .pmu-eye-btn:hover { background: rgba(214,213,212,0.07); }
      .pmu-eye-btn svg { width: 16px; height: 16px; fill: currentColor; }
      .pmu-hidden-row { opacity: .45; }
      .pmu-badge-max { font-size: .68rem; color: rgba(214,213,212,0.65); margin-left: 4px; }
    `;
    document.head.appendChild(style);
  }

  // —— tiny utils ——————————————————————————————————————————————————

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));


  function hasLockIcon(el) {
    return [...el.querySelectorAll("use")].some(
      (u) => (u.getAttribute("href") || u.getAttribute("xlink:href")) === "#pplx-icon-lock"
    );
  }

  function isAppsButton(btn) {
    return /apps and more/i.test((btn && btn.getAttribute("aria-label")) || "");
  }

  function isLikelyModelTrigger(btn) {
    if (!btn || isAppsButton(btn)) return false;
    const label = btn.getAttribute("aria-label") || "";
    if (/\bThinking$/i.test(label) || /Best|Sonar|GPT|Gemini|Claude|Kimi|GLM|Grok|Nemotron/i.test(label)) {
      return true;
    }
    return /\brounded-full\b/.test(btn.className) && /\bpx-3\b/.test(btn.className);
  }

  function isModelMenu(menu) {
    return /Selects the best available model/.test(menu.textContent || "");
  }

  function getOpenModelMenu() {
    return [...document.querySelectorAll('[role="menu"][data-state="open"]')].find(isModelMenu) || null;
  }

  function triggerFromMenu(menu) {
    const id = menu && menu.getAttribute("aria-labelledby");
    if (!id) return null;
    const t = document.getElementById(id);
    return t && !isAppsButton(t) ? t : null;
  }

  function getTrigger() {
    if (state.trigger && document.contains(state.trigger) && !isAppsButton(state.trigger)) {
      return state.trigger;
    }
    const fromMenu = triggerFromMenu(getOpenModelMenu());
    if (fromMenu) {
      state.trigger = fromMenu;
      return fromMenu;
    }
    const found = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(isLikelyModelTrigger);
    if (found) state.trigger = found;
    return found || null;
  }

  function findModelItem(menu, name) {
    return [...menu.querySelectorAll('[role^="menuitem"]')].find((it) => {
      const el = it.querySelector('.col-start-2 span[translate="no"]');
      return el && el.textContent.trim() === name;
    });
  }

  function extractItem(el) {
    const nameEl = el.querySelector('.col-start-2 span[translate="no"]');
    const name = nameEl ? nameEl.textContent.trim() : el.textContent.trim();
    const svg = el.querySelector("svg");
    const locked = hasLockIcon(el);
    const forcedThinking = isForcedThinking(name);
    const canToggleThinking = isOptionalThinking(name);
    return {
      el,
      name,
      svgHTML: svg ? svg.outerHTML : "",
      locked,
      canToggleThinking,
      forcedThinking,
      showInStandard: !forcedThinking,
      showInThinking: canToggleThinking || forcedThinking,
    };
  }

  function getSelection() {
    const trigger = getTrigger();
    const label = (trigger && trigger.getAttribute("aria-label")) || "";
    const thinking = /\sThinking$/i.test(label);
    return { name: label.replace(/\sThinking$/i, "").trim(), thinking };
  }

  function setBusy(on) {
    state.busy = on;
    document.body.classList.toggle("pmu-busy", on);
  }

  function setExpect(on) {
    document.body.classList.toggle("pmu-expect", on);
  }

  function markPicking() {
    state.picking = true;
    clearTimeout(state.pickTimer);
    state.pickTimer = setTimeout(() => {
      if (!state.busy) state.picking = false;
    }, 1500);
  }

  /**
   * Keep the native Radix menu mounted while our panel is open.
   * Otherwise a click on our panel is an "outside" click → menu unmounts →
   * we can't select, and reopen while busy often fails.
   */
  function lockMenuOpen(menu) {
    unlockMenuOpen();
    if (!menu) return;

    const prevent = (e) => {
      if (e && typeof e.preventDefault === "function") e.preventDefault();
    };

    const types = [
      "dismissableLayer.pointerDownOutside",
      "dismissableLayer.interactOutside",
      "dismissableLayer.focusOutside",
    ];
    for (const t of types) menu.addEventListener(t, prevent, true);

    const patches = [];
    let fiber = getFiber(menu);
    for (let i = 0; i < 50 && fiber; i++) {
      const props = fiber.memoizedProps;
      if (props) {
        for (const key of ["onPointerDownOutside", "onInteractOutside", "onFocusOutside"]) {
          if (key in props || typeof props[key] === "function") {
            patches.push({ props, key, prev: props[key] });
            props[key] = (e) => {
              prevent(e);
            };
          }
        }
        // Block controlled close while our panel is up (outside click / focus steal).
        if (typeof props.onOpenChange === "function") {
          const prev = props.onOpenChange;
          patches.push({ props, key: "onOpenChange", prev });
          props.onOpenChange = (open, ...rest) => {
            if (open === false && state.panel && !state.busy) {
              return;
            }
            return prev(open, ...rest);
          };
        }
      }
      fiber = fiber.return;
    }

    state.menuLock = { menu, prevent, types, patches };
  }

  function unlockMenuOpen() {
    const lock = state.menuLock;
    if (!lock) return;
    const { menu, prevent, types, patches } = lock;
    if (menu) {
      for (const t of types) menu.removeEventListener(t, prevent, true);
    }
    if (patches) {
      for (const { props, key, prev } of patches) {
        try {
          props[key] = prev;
        } catch {
          /* ignore */
        }
      }
    }
    state.menuLock = null;
  }

  // —— panel lifecycle —————————————————————————————————————————————

  function destroyPanel() {
    if (!state.panel) return;
    state.panel.remove();
    state.panel = null;
    state.editMode = false;
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onEscape, true);
  }

  function hideMenu(menu) {
    if (menu) menu.setAttribute("data-pmu-hidden", "1");
  }

  function closeNative() {
    const menu = getOpenModelMenu();
    const trigger = getTrigger();
    if (!menu || !trigger) return;
    const was = state.busy;
    setBusy(true);
    try {
      trigger.click();
    } finally {
      setBusy(was);
    }
  }

  /** Close via React onOpenChange — avoids toggle-click when aria-expanded is stale. */
  function forceCloseMenu() {
    const menu = getOpenModelMenu();
    const trigger = getTrigger();
    const roots = [menu, trigger].filter(Boolean);
    for (const node of roots) {
      let fiber = getFiber(node);
      for (let i = 0; i < 50 && fiber; i++) {
        const props = fiber.memoizedProps || {};
        if (typeof props.onOpenChange === "function") {
          try {
            props.onOpenChange(false);
          } catch {
            /* ignore */
          }
        }
        fiber = fiber.return;
      }
    }
    // Only click-toggle if a menu is actually open (stale aria-expanded alone → reopen).
    if (getOpenModelMenu() && trigger) trigger.click();
  }

  function dismiss() {
    destroyPanel();
    unlockMenuOpen();
    setExpect(false);
    state.menu = null;
    if (getOpenModelMenu()) closeNative();
  }

  function onOutside(e) {
    if (!state.panel || state.panel.contains(e.target)) return;
    const trigger = getTrigger();
    if (trigger && (e.target === trigger || trigger.contains(e.target))) return; // Radix toggles
    dismiss();
  }

  function onEscape(e) {
    if (e.key === "Escape" && state.panel) dismiss();
  }

  // —— React fiber helpers (Thinking submenu) ——————————————————————

  function getFiber(node) {
    if (!node) return null;
    for (const key of Object.keys(node)) {
      if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) return node[key];
    }
    return null;
  }

  function fakePointer(item, type, extra = {}) {
    const r = item.getBoundingClientRect();
    const clientX = r.left + Math.max(r.width / 2, 1);
    const clientY = r.top + Math.max(r.height / 2, 1);
    return {
      type,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      target: item,
      currentTarget: item,
      clientX,
      clientY,
      pageX: clientX,
      pageY: clientY,
      screenX: clientX,
      screenY: clientY,
      pointerType: "mouse",
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: extra.buttons != null ? extra.buttons : 0,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      isDefaultPrevented() {
        return !!this.defaultPrevented;
      },
      isPropagationStopped() {
        return false;
      },
      persist() {},
      nativeEvent: {
        isTrusted: true,
        target: item,
        button: 0,
        clientX,
        clientY,
        pointerType: "mouse",
      },
      ...extra,
    };
  }

  /** Call React/Radix handlers on this node only (optional shallow fiber). */
  function callReactHandlers(node, names, eventFactory, maxDepth = 1) {
    if (!node) return false;
    let handled = false;

    const tryProps = (props) => {
      if (!props) return;
      for (const name of names) {
        if (typeof props[name] !== "function") continue;
        try {
          props[name](eventFactory(name));
          handled = true;
          return; // one handler name is enough
        } catch {
          /* ignore */
        }
      }
    };

    for (const key of Object.keys(node)) {
      if (key.startsWith("__reactProps$")) {
        tryProps(node[key]);
        if (handled) return true;
      }
    }

    let fiber = getFiber(node);
    for (let i = 0; i < maxDepth && fiber; i++) {
      tryProps(fiber.memoizedProps);
      if (handled) return true;
      fiber = fiber.return;
    }
    return handled;
  }

  function forceOpenSubmenu(item) {
    let fiber = getFiber(item);
    for (let i = 0; i < 60 && fiber; i++) {
      const props = fiber.memoizedProps || {};
      if (typeof props.onOpenChange === "function") {
        try {
          props.onOpenChange(true);
        } catch {
          /* ignore */
        }
      }
      fiber = fiber.return;
    }
    callReactHandlers(item, ["onPointerMove", "onPointerEnter", "onFocus"], (name) =>
      fakePointer(item, name.slice(2).toLowerCase(), { buttons: 0 })
    );
    return item.getAttribute("aria-expanded") === "true";
  }

  /**
   * Activate a Radix menu item once. Do NOT walk parent fibers — that re-fires
   * ancestor onClick/onSelect (model row) and flips Thinking incorrectly.
   */
  function activateMenuItem(item) {
    if (!item) return false;

    const ev = (name) =>
      fakePointer(item, name === "onSelect" ? "click" : name.slice(2).toLowerCase(), {
        buttons: name === "onPointerDown" || name === "onMouseDown" ? 1 : 0,
      });

    // Prefer onSelect (Radix), then onClick — own props only.
    if (callReactHandlers(item, ["onSelect", "onClick"], ev, 1)) return true;

    // Pointer sequence on own props only.
    if (
      callReactHandlers(item, ["onPointerDown"], ev, 1) ||
      callReactHandlers(item, ["onPointerUp", "onClick"], ev, 1)
    ) {
      return true;
    }

    item.click();
    return true;
  }

  function thinkingControls(item) {
    const id = item.getAttribute("aria-controls");
    const byId = id ? document.getElementById(id) : null;
    const sub =
      (byId && byId.getAttribute("data-state") === "open" && byId) ||
      document.querySelector('[role="menu"][data-side="right"][data-state="open"]') ||
      document.querySelector('[role="menu"][data-side="left"][data-state="open"]');
    if (!sub) return null;
    const checkbox = [...sub.querySelectorAll('[role="menuitemcheckbox"]')].find((el) =>
      /\bThinking\b/i.test(el.textContent || "")
    );
    const sw = sub.querySelector('[role="switch"]');
    if (!checkbox && !sw) return null;
    return { checkbox, sw, sub };
  }

  async function setThinking(item, wantOn) {
    forceOpenSubmenu(item);
    try {
      item.focus({ preventScroll: true });
    } catch {
      item.focus();
    }
    item.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        code: "ArrowRight",
        keyCode: 39,
        which: 39,
        bubbles: true,
        cancelable: true,
      })
    );

    let controls = null;
    for (let i = 0; i < 30; i++) {
      controls = thinkingControls(item);
      if (controls) break;
      if (i % 4 === 0) forceOpenSubmenu(item);
      await wait(25);
    }
    if (!controls) {
      return false;
    }

    const el = controls.checkbox || controls.sw;
    const current = el.getAttribute("aria-checked") === "true";
    if (current === wantOn) return true;

    // One activation only — clicking both checkbox + switch toggles twice (no-op).
    activateMenuItem(el);
    await wait(160);

    const again = thinkingControls(item);
    const el2 = again && (again.checkbox || again.sw);
    const after = el2 ? el2.getAttribute("aria-checked") === "true" : getSelection().thinking;
    if (after === wantOn) return true;

    // Fallback: try the switch alone if we hit the checkbox first.
    if (again && again.sw && again.sw !== el) {
      activateMenuItem(again.sw);
      await wait(140);
    }
    return getSelection().thinking === wantOn;
  }

  /** Open a fresh model menu (close first if needed so the click always opens). */
  async function openMenuFresh() {
    const trigger = getTrigger();
    if (!trigger) {
      return null;
    }

    const wasBusy = state.busy;
    document.body.classList.add("pmu-expect");
    // Busy CSS sets pointer-events:none on menus — lift it while forcing open.
    document.body.classList.remove("pmu-busy");

    const waitUntil = async (pred, ticks = 40) => {
      for (let i = 0; i < ticks; i++) {
        if (pred()) return true;
        await wait(25);
      }
      return pred();
    };

    try {
      // aria-expanded can stay "true" after a soft-dismiss even when no open menu
      // is found — a single click then closes instead of opening.
      if (trigger.getAttribute("aria-expanded") === "true" || getOpenModelMenu()) {
        trigger.click();
        await waitUntil(
          () => trigger.getAttribute("aria-expanded") !== "true" && !getOpenModelMenu(),
          40
        );
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        trigger.click();
        const ok = await waitUntil(() => !!getOpenModelMenu(), 60);
        if (ok) {
          const menu = getOpenModelMenu();
          hideMenu(menu);
          state.menu = menu;
          const linked = triggerFromMenu(menu);
          if (linked) state.trigger = linked;
          lockMenuOpen(menu);
          return menu;
        }
        if (trigger.getAttribute("aria-expanded") === "true") {
          trigger.click();
          await wait(100);
        }
      }
      return null;
    } finally {
      if (wasBusy) document.body.classList.add("pmu-busy");
      if (!wasBusy) document.body.classList.remove("pmu-expect");
    }
  }

  /**
   * Select against the real menu. Prefer activating while it is still open
   * (early pointerdown pick). Fall back to reopen if Radix already dismissed.
   */
  async function selectModel(model, wantThinking) {
    if (Date.now() < state.ignoreSelectUntil) {
      state.picking = false;
      return;
    }

    const modelName = model.name;
    const needsToggle = model.canToggleThinking;
    let item = model.el && document.contains(model.el) ? model.el : null;
    let menu = getOpenModelMenu();
    if (!menu && state.menu && document.contains(state.menu) && state.menu.getAttribute("data-state") === "open") {
      menu = state.menu;
    }


    destroyPanel();
    setExpect(false);
    markPicking();
    setBusy(true);

    try {
      if (!menu || !document.contains(menu) || menu.getAttribute("data-state") !== "open") {
        unlockMenuOpen();
        menu = await openMenuFresh();
        item = null;
      }
      if (!menu) {
        return;
      }

      hideMenu(menu);
      if (!item || !document.contains(item)) item = findModelItem(menu, modelName);
      if (!item) {
        return;
      }

      activateMenuItem(item);
      await wait(180);
      let sel = getSelection();

      if (!needsToggle) return;

      if (sel.name === modelName && sel.thinking === wantThinking) {
        return;
      }

      // Prefer toggling on the still-open menu before a full reopen.
      if (document.contains(item) && getOpenModelMenu()) {
        await setThinking(item, wantThinking);
        await wait(100);
        sel = getSelection();
        if (sel.name === modelName && sel.thinking === wantThinking) {
          return;
        }
      }

      unlockMenuOpen();
      menu = await openMenuFresh();
      if (!menu) return;
      item = findModelItem(menu, modelName);
      if (!item) return;

      await setThinking(item, wantThinking);
      await wait(120);
    } finally {
      unlockMenuOpen();
      // Keep suppress past the 500ms sync interval so a leftover open menu
      // can't immediately bring the panel back.
      state.suppressPanelUntil = Date.now() + 1500;
      forceCloseMenu();
      await wait(40);
      if (getOpenModelMenu()) forceCloseMenu();
      state.menu = null;
      state.picking = false;
      setBusy(false);
      setExpect(false);
    }
  }

  // —— UI ——————————————————————————————————————————————————————————

  const EYE_OPEN = `<svg viewBox="0 0 16 16"><path d="M1 8s2.7-5 7-5 7 5 7 5-2.7 5-7 5-7-5-7-5z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
  const EYE_CLOSED = `<svg viewBox="0 0 16 16"><path d="M1 8s2.7-5 7-5 7 5 7 5-2.7 5-7 5-7-5-7-5z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 2l12 12" stroke="currentColor" stroke-width="1.4"/></svg>`;

  async function finishEdit() {
    markPicking();
    setBusy(true);
    try {
      let menu =
        state.menu &&
        document.contains(state.menu) &&
        state.menu.getAttribute("data-state") === "open"
          ? state.menu
          : null;
      if (!menu) menu = await openMenuFresh();
      // Clear editMode only once we have a replacement UI (avoids sync tearing down).
      if (menu) {
        state.editMode = false;
        showPanel(menu, true);
      } else {
        state.editMode = false;
        destroyPanel();
      }
    } finally {
      setBusy(false);
      state.picking = false;
    }
  }

  function toggleEye(allModels, index) {
    const m = allModels[index];
    if (!m) return;
    const set = loadHidden();
    if (set.has(m.name)) set.delete(m.name);
    else set.add(m.name);
    saveHidden(set);
    showEditView(allModels);
  }

  function showEditView(allModels) {
    const panel = state.panel;
    if (!panel) return;
    state.editMode = true;
    state.lastAllModels = allModels;
    const hidden = loadHidden();
    panel.innerHTML =
      `<div class="pmu-edit-header"><span class="pmu-edit-title">Edit models</span>` +
      `<button type="button" class="pmu-edit-done" data-act="done">Done</button></div>` +
      allModels
        .map((m, i) => {
          const hid = hidden.has(m.name);
          return `<div class="pmu-edit-row ${hid ? "pmu-hidden-row" : ""}">
            <span class="pmu-mini-icon">${m.svgHTML}</span>
            <span class="pmu-edit-name">${m.name}${m.locked ? ' <span class="pmu-badge-max">Max</span>' : ""}</span>
            <button type="button" class="pmu-eye-btn" data-eye="${i}" title="${hid ? "Reveal" : "Hide"}">${hid ? EYE_CLOSED : EYE_OPEN}</button>
          </div>`;
        })
        .join("");
  }

  /**
   * Pair matching models on one row (top-aligned). Standard-only (e.g. Sonar)
   * sits right under the last pair (under Grok), then Thinking-only rows follow.
   */
  function alignModelRows(standard, thinking) {
    const thinkByName = new Map(thinking.map((m) => [m.name, m]));
    const used = new Set();
    const pairs = [];
    const stdOnly = [];
    const thinkOnly = [];

    for (const m of standard) {
      if (thinkByName.has(m.name)) {
        pairs.push({ std: m, think: thinkByName.get(m.name) });
        used.add(m.name);
      } else {
        stdOnly.push(m);
      }
    }
    for (const m of thinking) {
      if (!used.has(m.name)) thinkOnly.push(m);
    }

    return [
      ...pairs,
      ...stdOnly.map((m) => ({ std: m, think: null })),
      ...thinkOnly.map((m) => ({ std: null, think: m })),
    ];
  }

  function showPanel(menu, keepPos) {
    const items = [...menu.querySelectorAll('[role^="menuitem"]')];
    const best = items.find(
      (it) =>
        it.getAttribute("role") === "menuitemradio" &&
        !it.getAttribute("aria-haspopup") &&
        /Selects the best/.test(it.textContent || "")
    );
    const models = items
      .filter((it) => it !== best && it.getAttribute("role") !== "menuitemcheckbox")
      .map(extractItem);

    const hidden = loadHidden();
    const unlocked = models.filter((m) => !m.locked && !hidden.has(m.name));
    const locked = models.filter((m) => m.locked && !hidden.has(m.name));
    const standard = unlocked.filter((m) => m.showInStandard);
    const thinking = unlocked.filter((m) => m.showInThinking);
    const rows = alignModelRows(standard, thinking);
    const { name: selName, thinking: selThinking } = getSelection();

    const prevTop = keepPos && state.panel ? state.panel.style.top : null;
    const prevRight = keepPos && state.panel ? state.panel.style.right : null;

    destroyPanel();
    hideMenu(menu);
    state.menu = menu;
    state.lastModels = unlocked;
    state.lastAllModels = models;
    state.editMode = false;

    const linked = triggerFromMenu(menu);
    if (linked) state.trigger = linked;
    const trigger = getTrigger();
    if (!trigger) return;

    const panel = document.createElement("div");
    panel.className = "pmu-panel";

    const cell = (m, mode) => {
      const selected = m.name === selName && (mode === "thinking") === selThinking;
      return `<button type="button" class="pmu-cell ${selected ? "pmu-selected" : ""}" data-name="${m.name}" data-mode="${mode}">
        <span class="pmu-mini-icon">${m.svgHTML}</span>
        <span class="pmu-cell-name">${m.name}</span>
      </button>`;
    };

    let html = "";
    if (rows.length) {
      html += `<div class="pmu-cols">
        <div class="pmu-col-head">Non-thinking</div>
        <div class="pmu-col-head">Thinking</div>
        ${rows
          .map(
            (r) =>
              (r.std ? cell(r.std, "standard") : `<div class="pmu-cell-spacer"></div>`) +
              (r.think ? cell(r.think, "thinking") : `<div class="pmu-cell-spacer"></div>`)
          )
          .join("")}
      </div>`;
    }
    if (locked.length) {
      html += `<div class="pmu-group"><div class="pmu-group-head"><span class="pmu-group-title">Max</span><span class="pmu-group-hint">upgrade required</span></div>`;
      locked.forEach((m) => {
        html += `<button type="button" class="pmu-option" data-locked="${m.name}">
          <span class="pmu-icon">${m.svgHTML}</span>
          <span class="pmu-name">${m.name}</span>
          <svg class="pmu-lockicon" viewBox="0 0 16 16"><use xlink:href="#pplx-icon-lock"></use></svg>
        </button>`;
      });
      html += `</div>`;
    }
    html += `<div class="pmu-footer">
      <button type="button" class="pmu-footer-row" data-act="edit"><span>Edit models&hellip;</span><span style="opacity:.5">&rsaquo;</span></button>
    </div>`;

    panel.innerHTML = html;

    panel.querySelectorAll(".pmu-cell").forEach((btn) => {
      // Fallback if early document pointerdown didn't run (shouldn't happen).
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.busy || state.pickHandled) {
          state.pickHandled = false;
          return;
        }
        if (Date.now() < state.ignoreSelectUntil) {
          state.picking = false;
          return;
        }
        const model = unlocked.find((m) => m.name === btn.getAttribute("data-name"));
        if (!model) {
          state.picking = false;
          return;
        }
        markPicking();
        selectModel(model, btn.getAttribute("data-mode") === "thinking");
      });
    });
    panel.querySelectorAll("[data-locked]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (Date.now() < state.ignoreSelectUntil) {
          state.picking = false;
          return;
        }
        const model = locked.find((m) => m.name === btn.getAttribute("data-locked"));
        if (!model) {
          state.picking = false;
          return;
        }
        const name = model.name;
        destroyPanel();
        state.picking = false;
        setBusy(true);
        (async () => {
          try {
            const menu = await openMenuFresh();
            const item = menu && findModelItem(menu, name);
            if (item) activateMenuItem(item);
            await wait(120);
          } finally {
            forceCloseMenu();
            state.menu = null;
            setBusy(false);
          }
        })();
      });
    });

    const rect = trigger.getBoundingClientRect();
    panel.style.right = prevRight || Math.max(8, window.innerWidth - rect.right) + "px";

    // Only block the same-tick open clickthrough — not real user picks.
    state.ignoreSelectUntil = Date.now() + 50;
    document.body.appendChild(panel);
    state.panel = panel;
    setExpect(false);
    lockMenuOpen(menu);

    // Place below when there's room; otherwise flip above (follow-up input at bottom).
    if (prevTop) {
      panel.style.top = prevTop;
    } else {
      positionPanel(panel, rect);
    }

    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onEscape, true);
  }

  function positionPanel(panel, triggerRect) {
    const gap = 8;
    const margin = 8;
    const vh = window.innerHeight;
    const spaceBelow = vh - triggerRect.bottom - gap - margin;
    const spaceAbove = triggerRect.top - gap - margin;

    // Measure natural height (capped by CSS max-height).
    panel.style.maxHeight = "";
    const need = Math.min(panel.scrollHeight, 32 * 16); // ~32rem

    const openAbove = spaceBelow < need && spaceAbove > spaceBelow;
    if (openAbove) {
      panel.classList.add("pmu-above");
      const maxH = Math.max(160, spaceAbove);
      panel.style.maxHeight = maxH + "px";
      const h = Math.min(panel.scrollHeight, maxH);
      panel.style.top = Math.max(margin, triggerRect.top - gap - h) + "px";
    } else {
      panel.classList.remove("pmu-above");
      panel.style.maxHeight = Math.max(160, spaceBelow) + "px";
      panel.style.top = triggerRect.bottom + gap + "px";
    }
  }

  // —— sync with Radix (the whole open/close strategy) ——————————————

  function sync() {
    if (state.busy || state.picking || state.editMode) return;
    if (Date.now() < state.suppressPanelUntil) return;

    const menu = getOpenModelMenu();
    if (menu) {
      if (!state.panel) {
        showPanel(menu);
      } else {
        hideMenu(menu);
        state.menu = menu;
      }
      return;
    }

    // Native menu closed → drop our panel (e.g. user toggled the trigger).
    // Skipped while picking / editing — Radix closes on panel pointerdown before click.
    if (state.panel) {
      destroyPanel();
      state.menu = null;
      setExpect(false);
    }
  }

  /**
   * Panel interactions on pointerdown BEFORE Radix's document capture dismiss.
   * Cells select; Edit / other chrome keep the panel alive.
   */
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!state.panel || state.busy) return;
      if (!state.panel.contains(e.target)) return;
      if (Date.now() < state.ignoreSelectUntil) return;

      // Edit view — handle Done / eye here (onclick was losing the race).
      if (state.editMode) {
        const done = e.target.closest('[data-act="done"]');
        if (done) {
          e.preventDefault();
          e.stopImmediatePropagation();
          markPicking();
          finishEdit();
          return;
        }
        const eye = e.target.closest("[data-eye]");
        if (eye) {
          e.preventDefault();
          e.stopImmediatePropagation();
          markPicking();
          toggleEye(state.lastAllModels || [], +eye.getAttribute("data-eye"));
          return;
        }
        markPicking();
        return;
      }

      // Beat Radix dismiss for any in-panel press.
      e.preventDefault();
      e.stopImmediatePropagation();
      markPicking();

      const edit = e.target.closest('[data-act="edit"]');
      if (edit) {
        state.editMode = true;
        showEditView(state.lastAllModels || []);
        return;
      }

      const lockedBtn = e.target.closest("[data-locked]");
      if (lockedBtn) {
        const name = lockedBtn.getAttribute("data-locked");
        destroyPanel();
        state.picking = false;
        setBusy(true);
        (async () => {
          try {
            const menu = await openMenuFresh();
            const item = menu && findModelItem(menu, name);
            if (item) activateMenuItem(item);
            await wait(120);
          } finally {
            forceCloseMenu();
            state.menu = null;
            setBusy(false);
          }
        })();
        return;
      }

      const cell = e.target.closest("button.pmu-cell");
      if (!cell) return;

      const name = cell.getAttribute("data-name");
      const wantThinking = cell.getAttribute("data-mode") === "thinking";
      const model = (state.lastModels || []).find((m) => m.name === name);
      if (!model) return;

      state.pickHandled = true;
      selectModel(model, wantThinking);
    },
    true
  );

  // Anticipate open: hide native menu before first paint when user presses the trigger.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (state.busy) return;
      const btn = e.target.closest('button[aria-haspopup="menu"]');
      if (!btn || !isLikelyModelTrigger(btn)) return;
      state.trigger = btn;
      state.suppressPanelUntil = 0; // user is intentionally opening
      if (!state.panel) setExpect(true);
    },
    true
  );

  // Clear expect if it wasn't a model menu (e.g. wrong guess).
  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest('button[aria-haspopup="menu"]');
      if (!btn) return;
      // Give Radix a moment, then clear expect if nothing attached.
      setTimeout(() => {
        if (!state.panel && !state.busy) setExpect(false);
      }, 400);
    },
    true
  );

  const mo = new MutationObserver(() => {
    sync();
  });
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state", "data-side"],
  });

  // —— models config watch (once per page load) ————————————————

  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Canonical JSON for hashing — sorts keys recursively. Do NOT pass key arrays to JSON.stringify (that's a replacer whitelist and strips nested fields). */
  function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
    const keys = Object.keys(value).sort();
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") +
      "}"
    );
  }

  function prettyConfig(data) {
    return JSON.stringify(data, null, 2);
  }

  /** Reject the empty-object shape caused by the old stringify replacer bug. */
  function looksLikeFullConfig(data) {
    if (!data || typeof data !== "object") return false;
    const entry = Array.isArray(data.config) ? data.config.find((c) => c && typeof c === "object") : null;
    if (entry && Object.keys(entry).length > 0) return true;
    if (data.models && typeof data.models === "object" && Object.keys(data.models).length > 0) return true;
    return false;
  }

  function storedConfigIsHollow(text) {
    if (!text) return true;
    try {
      return !looksLikeFullConfig(JSON.parse(text));
    } catch {
      return true;
    }
  }

  function notifyConfig(title, body) {
    try {
      if (typeof GM_notification === "function") {
        GM_notification({ title, text: body, timeout: 8000 });
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      if (typeof Notification === "undefined") {
        /* notification unavailable */
        return;
      }
      if (Notification.permission === "granted") {
        new Notification(title, { body });
      } else if (Notification.permission !== "denied") {
        Notification.requestPermission().then((p) => {
          if (p === "granted") new Notification(title, { body });
        });
      } else {
        /* notification unavailable */
      }
    } catch {
      /* notification unavailable */
    }
  }

  function saveConfigToTampermonkey(text, hash, { isChange }) {
    if (isChange) {
      const cur = GM_getValue(TM_CONFIG_JSON, "");
      if (cur) GM_setValue(TM_CONFIG_PREV, cur);
    }
    GM_setValue(TM_CONFIG_HASH, hash);
    GM_setValue(TM_CONFIG_JSON, text);
    GM_setValue(TM_CONFIG_UPDATED, new Date().toISOString());
  }

  async function checkModelsConfigOnce() {
    try {
      const res = await fetch("/rest/models/config", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();

      // Same shape as a working console fetch — full nested objects, not {}.
      if (!looksLikeFullConfig(data)) {
        return;
      }

      const text = prettyConfig(data); // JSON.stringify(data, null, 2)
      const hash = await sha256(stableStringify(data));

      let prev = GM_getValue(TM_CONFIG_HASH, "");
      const prevJson = GM_getValue(TM_CONFIG_JSON, "");

      // Drop hollow snapshots from the old stringify bug so we re-seed.
      if (prev && storedConfigIsHollow(prevJson)) {
        prev = "";
        GM_setValue(TM_CONFIG_HASH, "");
        GM_setValue(TM_CONFIG_JSON, "");
      }

      if (!prev) {
        const legacyHash = localStorage.getItem("pmu_models_config_hash") || "";
        const legacyJson = localStorage.getItem("pmu_models_config_last") || "";
        if (legacyHash && legacyJson && !storedConfigIsHollow(legacyJson)) {
          GM_setValue(TM_CONFIG_HASH, legacyHash);
          GM_setValue(TM_CONFIG_JSON, legacyJson);
          prev = legacyHash;
          localStorage.removeItem("pmu_models_config_hash");
          localStorage.removeItem("pmu_models_config_last");
        } else if (legacyHash || legacyJson) {
          localStorage.removeItem("pmu_models_config_hash");
          localStorage.removeItem("pmu_models_config_last");
        }
      }

      if (!prev) {
        saveConfigToTampermonkey(text, hash, { isChange: false });
        notifyConfig("Models config", "Saved initial snapshot to Tampermonkey storage");
        return;
      }

      if (hash === prev) {
        return;
      }

      saveConfigToTampermonkey(text, hash, { isChange: true });
      notifyConfig(
        "Perplexity models config updated",
        "New config saved in Tampermonkey storage (previous kept as backup)."
      );
    } catch {
      /* ignore fetch/parse errors */
    }
  }

  // Cheap periodic backup in case a mutation is missed.
  setInterval(() => {
    if (!state.busy) sync();
  }, 500);

  setTimeout(() => checkModelsConfigOnce(), 4000);
})();
