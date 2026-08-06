  // ==UserScript==
  // @name         Perplexity Model Selector Redesign v2
  // @namespace    https://perplexity.ai/
  // @version      2.6.2
  // @description  Non-thinking/Thinking model picker for Perplexity, plus one-shot /rest/models/config change watch on page load.
  // @author       you
  // @match        https://www.perplexity.ai/*
  // @match        https://perplexity.ai/*
  // @run-at       document-idle
  // @grant        GM_getValue
  // @grant        GM_setValue
  // @grant        GM_notification
  // ==/UserScript==
  
  (function () {
    "use strict";
  
    if (window.__pplxModelUIv2Installed) return;
    window.__pplxModelUIv2Installed = true;
  
    const LS_HIDDEN = "pmu_hidden_models";
    const LS_LAST_SEL = "pmu_last_selection";
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
      lastSelection: null, // { name, thinking } — trigger no longer encodes this on current PPLX
      busy: false, // selecting / driving native menu
      picking: false, // pointer is down on our panel — don't tear it down when Radix closes
      holdMenu: false, // keep native menu mounted through select→thinking
      pickTimer: null,
      editMode: false,
      ignoreSelectUntil: 0,
      suppressPanelUntil: 0,
      menuLock: null,
      panelMode: null, // "model" | "rewrite" — which flavor state.panel currently shows
      rewriteTrigger: null, // the Rewrite button that owns the currently-open rewrite menu
      rewriteMenu: null, // the live native Rewrite menu being custom-styled
      pendingRewriteTrigger: null, // Rewrite button just pressed, awaiting its menu to mount
      pendingRewriteAt: 0,
      pickHandled: false,
      chipFreeze: null, // { trigger, overlay }
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

    function loadLastSelection() {
      try {
        const v = JSON.parse(localStorage.getItem(LS_LAST_SEL) || "null");
        if (v && typeof v.name === "string" && v.name) {
          return { name: v.name, thinking: !!v.thinking };
        }
      } catch {
        /* ignore */
      }
      return null;
    }

    function saveLastSelection(name, thinking) {
      if (!name) return;
      const sel = { name, thinking: !!thinking };
      state.lastSelection = sel;
      try {
        localStorage.setItem(LS_LAST_SEL, JSON.stringify(sel));
      } catch {
        /* ignore */
      }
    }

    // Seed from prior session so the first panel open can highlight correctly.
    state.lastSelection = loadLastSelection();
  
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
        /* Hide native menus while our panel is up, or while we expect/drive one.
           During pmu-drive we still hide them visually but keep pointer-events so
           our synthetic activations can land on Radix items. */
        [data-pmu-hidden="1"],
        body.pmu-expect [role="menu"][data-state="open"],
        body.pmu-busy [role="menu"] {
          opacity: 0 !important;
          visibility: hidden !important;
        }
        body.pmu-busy:not(.pmu-drive) [role="menu"],
        body.pmu-expect:not(.pmu-drive) [role="menu"][data-state="open"],
        [data-pmu-hidden="1"] {
          pointer-events: none !important;
        }
        body.pmu-drive [role="menu"] {
          pointer-events: auto !important;
        }

        /* Cover the composer chip during drive. Overlay is the only visible
           label — never rewrite React text nodes (that caused doubled labels). */
        button.pmu-chip-frozen {
          position: relative !important;
        }
        button.pmu-chip-frozen > .pmu-chip-overlay {
          position: absolute !important;
          inset: 0 !important;
          display: flex !important;
          align-items: center !important;
          justify-content: flex-start !important;
          padding-left: 0.75rem !important;
          padding-right: 1.35rem !important;
          pointer-events: none !important;
          white-space: nowrap !important;
          overflow: hidden !important;
          text-overflow: ellipsis !important;
          font: inherit !important;
          color: inherit !important;
          background: inherit !important;
          border-radius: inherit !important;
          z-index: 2 !important;
        }
        button.pmu-chip-frozen > :not(.pmu-chip-overlay) {
          visibility: hidden !important;
          opacity: 0 !important;
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
          .pmu-row-divider-col1, .pmu-row-divider-col2 { background: rgba(39,37,30,0.14) !important; }
        }
  
        .pmu-cols {
          display: grid; grid-template-columns: 1fr 1fr; column-gap: .35rem; row-gap: .05rem;
          padding: .3rem; align-items: stretch;
        }
        .pmu-col-head {
          font-size: .64rem; letter-spacing: .09em; text-transform: uppercase; font-weight: 700;
          color: rgba(214,213,212,0.65); padding: 0 .35rem .3rem;
        }
        .pmu-row-divider-col1, .pmu-row-divider-col2 { height: 1px; background: rgba(214,213,212,0.14); margin: .35rem .15rem; align-self: center; }
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

        /* Rewrite uses the real Radix rows so a physical click remains trusted;
           these rules turn that live menu into our custom surface. */
        [role="menu"].pmu-rewrite-native {
          width: 360px !important; max-height: min(32rem, calc(100vh - 16px)) !important;
          display: flex !important; flex-direction: column !important; overflow-y: auto !important; padding: .5rem !important; border-radius: .85rem !important;
          background: #1e1d1c !important; border: 1px solid rgba(214,213,212,.14) !important;
          box-shadow: 0 20px 48px -12px rgba(0,0,0,.55), 0 4px 12px -2px rgba(0,0,0,.35) !important;
          color: #d6d5d4 !important; font-family: "Lexend", system-ui, sans-serif !important;
        }
        .pmu-rewrite-native-head {
          padding: .3rem .35rem .5rem; margin-bottom: .25rem; border-bottom: 1px solid rgba(214,213,212,.14);
          color: rgba(214,213,212,.85); font-size: .66rem; font-weight: 700; letter-spacing: .09em;
          text-transform: uppercase; pointer-events: none;
        }
        [role="menu"].pmu-rewrite-native [role^="menuitem"] {
          width: 100% !important; min-height: 2.55rem; margin: .05rem 0 !important; padding: .45rem .5rem !important;
          border-radius: .55rem !important; color: inherit !important;
        }
        [role="menu"].pmu-rewrite-native [role^="menuitem"]:hover,
        [role="menu"].pmu-rewrite-native [role^="menuitem"][aria-checked="true"] { background: rgba(214,213,212,.08) !important; }
        [role="menu"].pmu-rewrite-native .pmu-rewrite-native-best { display: none !important; }
        @media (prefers-color-scheme: light) {
          [role="menu"].pmu-rewrite-native { background: #fdfbfa !important; border-color: rgba(39,37,30,.14) !important; color: #27251e !important; box-shadow: 0 20px 48px -12px rgba(0,0,0,.16), 0 4px 12px -2px rgba(0,0,0,.07) !important; }
          .pmu-rewrite-native-head { color: rgba(39,37,30,.75); border-color: rgba(39,37,30,.14); }
          [role="menu"].pmu-rewrite-native [role^="menuitem"]:hover,
          [role="menu"].pmu-rewrite-native [role^="menuitem"][aria-checked="true"] { background: rgba(39,37,30,.07) !important; }
        }
      `;
      document.head.appendChild(style);
    }
  
    // —— tiny utils ——————————————————————————————————————————————————
  
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    /** Poll until pred() is truthy. Faster than fixed sleeps for DOM-driven work. */
    async function waitFor(pred, { timeout = 800, interval = 8 } = {}) {
      if (pred()) return pred();
      const start = performance.now();
      while (performance.now() - start < timeout) {
        await wait(interval);
        const v = pred();
        if (v) return v;
      }
      return pred() || null;
    }

    /** Parse a composer chip / aria-label into { name, thinking }. */
    function parseSelectionLabel(raw) {
      const text = (raw || "").replace(/\s+/g, " ").trim();
      if (!text || /^model$/i.test(text)) return null;
      const thinking = /\sThinking$/i.test(text);
      let name = text.replace(/\sThinking$/i, "").trim();
      // Collapse leftover "Name Name" from older label-lock fights with React.
      const dup = name.match(/^(.+?)\s+\1$/i);
      if (dup) name = dup[1].trim();
      if (!name || /^model$/i.test(name)) return null;
      return { name, thinking };
    }

    function desiredTriggerLabel(name, thinking) {
      return thinking ? `${name} Thinking` : name;
    }

    /**
     * Cover the composer chip with an overlay showing the final label.
     * Hides React's intermediate text. NEVER rewrite React text nodes —
     * that races the framework and produces "Name Name Thinking".
     */
    function freezeChip(name, thinking) {
      unfreezeChip();
      const trigger = getTrigger();
      if (!trigger || !name) return;
      const label = desiredTriggerLabel(name, thinking);
      const overlay = document.createElement("span");
      overlay.className = "pmu-chip-overlay";
      overlay.textContent = label;
      trigger.classList.add("pmu-chip-frozen");
      trigger.appendChild(overlay);
      state.chipFreeze = { trigger, overlay, label, name, thinking };
    }

    /**
     * Drop the overlay once the native chip has a non-doubled label.
     * Never rewrite React text to force a label — only collapse the exact
     * "Name Name" residue older builds left behind.
     */
    function unfreezeChip() {
      const fr = state.chipFreeze;
      if (!fr) return;
      const { trigger, overlay, name, thinking } = fr;

      const nativeText = () => {
        if (!trigger) return "";
        // Exclude our overlay so we only see React's real chip text.
        let out = "";
        const walk = (node) => {
          if (node === overlay) return;
          if (node.nodeType === 3) {
            out += node.nodeValue || "";
            return;
          }
          if (node.nodeType !== 1) return;
          if (node.classList && node.classList.contains("pmu-chip-overlay")) return;
          for (const child of node.childNodes) walk(child);
        };
        walk(trigger);
        return out.replace(/\s+/g, " ").trim();
      };

      const finish = () => {
        if (state.chipFreeze !== fr) return;
        state.chipFreeze = null;
        try {
          if (overlay && overlay.parentNode) overlay.remove();
        } catch {
          /* ignore */
        }
        if (trigger) {
          trigger.classList.remove("pmu-chip-frozen");
          repairDoubledChipLabel(trigger);
        }
        if (name) saveLastSelection(name, thinking);
      };

      // Hold the overlay through PPLX's chip crossfade so intermediate dual
      // labels never show. Only inspect native text (overlay excluded).
      const start = performance.now();
      const tick = () => {
        if (state.chipFreeze !== fr) return;
        if (trigger && document.contains(trigger)) {
          repairDoubledChipLabel(trigger);
          const live = parseSelectionLabel(nativeText());
          const aria = parseSelectionLabel(trigger.getAttribute("aria-label") || "");
          const ok =
            (live && live.name === name && !!live.thinking === !!thinking) ||
            (aria && aria.name === name && !!aria.thinking === !!thinking);
          if (performance.now() - start >= 360 && ok) {
            finish();
            return;
          }
        }
        if (performance.now() - start >= 550) {
          finish();
          return;
        }
        setTimeout(tick, 40);
      };
      setTimeout(tick, 160);
    }

    /** Collapse "Name Name" / "Name Name Thinking" left by older builds / crossfade. */
    function repairDoubledChipLabel(trigger) {
      const root = trigger || getTrigger();
      if (!root) return false;

      // Leaf text nodes under the chip (skip our overlay).
      const leaves = [];
      const collect = (node) => {
        if (!node) return;
        if (node.nodeType === 3) {
          if ((node.nodeValue || "").trim()) leaves.push(node);
          return;
        }
        if (node.nodeType !== 1) return;
        if (node.classList && node.classList.contains("pmu-chip-overlay")) return;
        for (const child of node.childNodes) collect(child);
      };
      collect(root);

      let fixed = false;

      // Per-node "Name Name" / "Name Name Thinking".
      for (const node of leaves) {
        const t = (node.nodeValue || "").replace(/\s+/g, " ").trim();
        const m = t.match(/^(.+?)\s+\1(\s+Thinking)?$/i);
        if (m) {
          node.nodeValue = m[1] + (m[2] || "");
          fixed = true;
        }
      }

      // Crossfade case: two sibling leaves "Name" + "Name Thinking" (or "Name" + "Name").
      if (leaves.length >= 2) {
        for (let i = 0; i < leaves.length - 1; i++) {
          const a = (leaves[i].nodeValue || "").replace(/\s+/g, " ").trim();
          const b = (leaves[i + 1].nodeValue || "").replace(/\s+/g, " ").trim();
          if (!a || !b) continue;
          if (b === a || b === a + " Thinking" || new RegExp("^" + a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+Thinking$", "i").test(b)) {
            // Keep the newer leaf (b), clear the fading one (a).
            leaves[i].nodeValue = "";
            fixed = true;
          } else if (a === b || a === b + " Thinking") {
            leaves[i + 1].nodeValue = "";
            fixed = true;
          }
        }
      }

      return fixed;
    }

    function setDrive(on) {
      document.body.classList.toggle("pmu-drive", on);
    }
  
    function hasLockIcon(el) {
      return [...el.querySelectorAll("use")].some(
        (u) => (u.getAttribute("href") || u.getAttribute("xlink:href")) === "#pplx-icon-lock"
      );
    }
  
    function isAppsButton(btn) {
      return /apps and more/i.test((btn && btn.getAttribute("aria-label")) || "");
    }
  
    // The per-message "Rewrite" control opens a menu with model rows similar
    // to the main composer picker. Must not be treated as our trigger or our
    // panel replaces the native rewrite-model menu and rewriting breaks.
    function isRewriteButton(btn) {
      if (!btn) return false;
      const label =
        (btn.getAttribute("aria-label") || "") +
        " " +
        (btn.getAttribute("title") || "") +
        " " +
        (btn.textContent || "");
      return /rewrite/i.test(label.trim());
    }

    function isLikelyModelTrigger(btn) {
      if (!btn || isAppsButton(btn) || isRewriteButton(btn)) return false;
      const label = (btn.getAttribute("aria-label") || "").trim();
      const text = (btn.textContent || "").replace(/\s+/g, " ").trim();
      // Current PPLX uses a generic "Model" chip; older builds put the model name
      // (and optional "Thinking") directly on aria-label.
      if (/^model$/i.test(label) || /^model$/i.test(text)) return true;
      if (
        /\bThinking$/i.test(label) ||
        /Best|Sonar|GPT|Gemini|Claude|Kimi|GLM|Grok|Nemotron|Terra/i.test(label)
      ) {
        return true;
      }
      return /\brounded-full\b/.test(btn.className) && /\bpx-3\b/.test(btn.className);
    }

    /** Header / promo rows that used to say "Selects the best available model". */
    function isAutoBestItem(el) {
      const t = (el && el.textContent) || "";
      return /Selects the best available model/i.test(t) || /Access the top AI models/i.test(t);
    }

    function menuModelNameCount(menu) {
      if (!menu) return 0;
      return menu.querySelectorAll('.col-start-2 span[translate="no"]').length;
    }

    function isModelMenu(menu) {
      if (!menu) return false;
      // Submenus (Thinking toggle / promo flyouts) sit on the side — never the root picker.
      const side = menu.getAttribute("data-side");
      if (side === "right" || side === "left") return false;
      const text = menu.textContent || "";
      // Prefer the known promo/header copy (old + new), then fall back to
      // "enough named model rows" so we still match if copy changes again.
      if (/Selects the best available model/i.test(text)) return true;
      if (/Access the top AI models/i.test(text)) return true;
      return menuModelNameCount(menu) >= 3;
    }

    function getOpenModelMenu() {
      return (
        [...document.querySelectorAll('[role="menu"][data-state="open"]')].find(isModelMenu) || null
      );
    }

    function triggerFromMenu(menu) {
      const id = menu && menu.getAttribute("aria-labelledby");
      if (!id) return null;
      const t = document.getElementById(id);
      return t && !isAppsButton(t) && !isRewriteButton(t) ? t : null;
    }

    function getTrigger() {
      if (
        state.trigger &&
        document.contains(state.trigger) &&
        !isAppsButton(state.trigger) &&
        !isRewriteButton(state.trigger)
      ) {
        return state.trigger;
      }
      const fromMenu = triggerFromMenu(getOpenModelMenu());
      if (fromMenu) {
        state.trigger = fromMenu;
        return fromMenu;
      }
      const found = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(
        isLikelyModelTrigger
      );
      if (found) state.trigger = found;
      return found || null;
    }

    /** Model rows have a dedicated name span; non-model rows (Search, Deep
     *  research, the auto "Best"/"Rewrite" entry, …) don't — fall back to their
     *  own text, stripped of promo headers. */
    function itemName(el) {
      const nameEl = el.querySelector('.col-start-2 span[translate="no"]');
      if (nameEl) return nameEl.textContent.trim();
      return (el.textContent || "")
        .replace(/Selects the best available model.*$/i, "")
        .replace(/Access the top AI models.*$/i, "")
        .trim();
    }

    function findModelItem(menu, name) {
      return [...menu.querySelectorAll('[role^="menuitem"]')].find((it) => itemName(it) === name);
    }

    function extractItem(el) {
      const name = itemName(el);
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
        isModelRow: !!el.querySelector('.col-start-2 span[translate="no"]'),
      };
    }

    /**
     * Selection from the live composer chip only (no remembered override).
     * Used to decide whether a native menu drive is still needed.
     */
    function readTriggerSelection() {
      const trigger = getTrigger();
      if (!trigger) return { name: "", thinking: false };
      const fromAria = parseSelectionLabel(trigger.getAttribute("aria-label") || "");
      if (fromAria) return fromAria;
      const fromText = parseSelectionLabel(trigger.textContent || "");
      if (fromText) return fromText;
      return { name: "", thinking: false };
    }

    /**
     * Current selection for UI. Prefer our last confirmed pick when the chip is
     * a generic "Model" label; otherwise trust the live chip.
     * Never rewrite the native chip DOM — that races React and doubles labels.
     */
    function readNativeSelection() {
      const fromTrigger = readTriggerSelection();
      if (fromTrigger.name) return fromTrigger;
      if (state.lastSelection && state.lastSelection.name) {
        return { name: state.lastSelection.name, thinking: !!state.lastSelection.thinking };
      }
      return { name: "", thinking: false };
    }

    function getSelection() {
      return readNativeSelection();
    }
  
    function setBusy(on) {
      state.busy = on;
      document.body.classList.toggle("pmu-busy", on);
      if (!on) setDrive(false);
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
          // Block controlled close while our panel is up, or while we hold the
          // menu open through a select→thinking drive (avoids slow reopen).
          if (typeof props.onOpenChange === "function") {
            const prev = props.onOpenChange;
            patches.push({ props, key: "onOpenChange", prev });
            props.onOpenChange = (open, ...rest) => {
              if (open === false && (state.panel || state.holdMenu)) {
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
      state.panelMode = null;
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("keydown", onEscape, true);
    }
  
    function hideMenu(menu) {
      if (menu) menu.setAttribute("data-pmu-hidden", "1");
    }
  
    function closeNative(triggerOverride) {
      const menu = getOpenModelMenu();
      const trigger = triggerOverride || getTrigger();
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
    function forceCloseMenu(triggerOverride) {
      const menu = getOpenModelMenu();
      const trigger = triggerOverride || getTrigger();
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
      const wasRewrite = state.panelMode === "rewrite";
      const rwTrigger = state.rewriteTrigger;
      destroyPanel();
      unlockMenuOpen();
      setExpect(false);
      state.menu = null;
      if (wasRewrite) {
        state.rewriteTrigger = null;
        state.pendingRewriteTrigger = null;
        if (getOpenModelMenu()) closeNative(rwTrigger);
      } else if (getOpenModelMenu()) {
        closeNative();
      }
    }
  
    function onOutside(e) {
      if (!state.panel || state.panel.contains(e.target)) return;
      const trigger = state.panelMode === "rewrite" ? state.rewriteTrigger : getTrigger();
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
     * Dispatch a genuine pointerdown/pointerup/click sequence, letting React's
     * real event delegation resolve whatever handler chain actually exists
     * (context, composed handlers, etc.) instead of us guessing prop names/depth.
     * Slower/heavier than the prop-walk below, but far more reliable when an
     * item's real handler isn't reachable by walking its own fiber props —
     * that's the case for Rewrite's combined mode+model menu.
     */
    function dispatchRealSelect(item) {
      const r = item.getBoundingClientRect();
      const x = r.left + Math.max(r.width / 2, 1);
      const y = r.top + Math.max(r.height / 2, 1);
      // No `view` here: userscript sandboxes wrap `window` in a proxy that
      // isn't a real Window per the spec, so PointerEvent's constructor throws
      // trying to coerce it — and `view` isn't required for dispatch to work.
      const base = { bubbles: true, cancelable: true, composed: true, button: 0 };
      const pointerOpts = (buttons) => ({
        ...base,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        buttons,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
      });
      item.dispatchEvent(new PointerEvent("pointerdown", pointerOpts(1)));
      item.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1, clientX: x, clientY: y }));
      item.dispatchEvent(new PointerEvent("pointerup", pointerOpts(0)));
      item.dispatchEvent(new MouseEvent("mouseup", { ...base, clientX: x, clientY: y }));
      item.dispatchEvent(new MouseEvent("click", { ...base, clientX: x, clientY: y }));
    }
  
    /**
     * Activate a Radix menu item once. Do NOT walk parent fibers — that re-fires
     * ancestor onClick/onSelect (model row) and flips Thinking incorrectly.
     */
    function activateMenuItem(item, opts = {}) {
      if (!item) return false;

      // Default to a real pointer/click sequence — fiber prop walks often miss
      // the app handler on current Perplexity builds, so the chip never updates.
      if (opts.real !== false && !opts.preferClick) {
        dispatchRealSelect(item);
        return true;
      }

      if (opts.real) {
        dispatchRealSelect(item);
        return true;
      }

      const ev = (name) =>
        fakePointer(item, name === "onSelect" ? "click" : name.slice(2).toLowerCase(), {
          buttons: name === "onPointerDown" || name === "onMouseDown" ? 1 : 0,
        });

      // Rewrite model rows are submenu triggers: their Radix onSelect merely
      // closes the menu, while their app-specific onClick performs the action.
      if (opts.preferClick && callReactHandlers(item, ["onClick"], ev, 1)) return true;

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

    /** Fast Thinking toggle. Menu stays held open; chip is frozen by caller. */
    async function setThinking(item, wantOn, opts = {}) {
      forceOpenSubmenu(item);
      try {
        item.focus({ preventScroll: true });
      } catch {
        /* ignore */
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

      let controls = thinkingControls(item);
      if (!controls) {
        controls = await waitFor(() => thinkingControls(item), { timeout: 280, interval: 6 });
      }
      if (!controls) {
        forceOpenSubmenu(item);
        controls = await waitFor(() => thinkingControls(item), { timeout: 180, interval: 8 });
      }
      if (!controls) return false;

      const el = controls.checkbox || controls.sw;
      const current = el.getAttribute("aria-checked") === "true";
      if (current === wantOn) return true;

      // Real click — fiber walks miss the handler on current builds.
      activateMenuItem(el, { real: true });
      const matched = await waitFor(() => {
        const again = thinkingControls(item);
        const el2 = again && (again.checkbox || again.sw);
        if (!el2) return null;
        return (el2.getAttribute("aria-checked") === "true") === wantOn ? true : null;
      }, { timeout: 200, interval: 6 });
      if (matched) return true;

      const again = thinkingControls(item);
      if (again && again.sw && again.sw !== el) {
        activateMenuItem(again.sw, { real: true });
        const ok = await waitFor(() => {
          const c = thinkingControls(item);
          const el2 = c && (c.checkbox || c.sw);
          if (!el2) return null;
          return (el2.getAttribute("aria-checked") === "true") === wantOn ? true : null;
        }, { timeout: 160, interval: 6 });
        return !!ok;
      }
      const final = thinkingControls(item);
      const elFinal = final && (final.checkbox || final.sw);
      return elFinal ? (elFinal.getAttribute("aria-checked") === "true") === wantOn : false;
    }

    /** Open a fresh model menu (close first if needed so the click always opens). */
    async function openMenuFresh(triggerOverride) {
      const trigger = triggerOverride || getTrigger();
      if (!trigger) return null;

      const wasBusy = state.busy;
      document.body.classList.add("pmu-expect");
      // Busy CSS sets pointer-events:none on menus — lift it while forcing open.
      document.body.classList.remove("pmu-busy");
      setDrive(true);

      try {
        // aria-expanded can stay "true" after a soft-dismiss even when no open menu
        // is found — a single click then closes instead of opening.
        if (trigger.getAttribute("aria-expanded") === "true" || getOpenModelMenu()) {
          trigger.click();
          await waitFor(
            () =>
              trigger.getAttribute("aria-expanded") !== "true" && !getOpenModelMenu() ? true : null,
            { timeout: 350, interval: 6 }
          );
        }

        for (let attempt = 0; attempt < 2; attempt++) {
          trigger.click();
          const menu = await waitFor(() => getOpenModelMenu(), { timeout: 500, interval: 6 });
          if (menu) {
            hideMenu(menu);
            state.menu = menu;
            const linked = triggerFromMenu(menu);
            if (linked) state.trigger = linked;
            lockMenuOpen(menu);
            return menu;
          }
          if (trigger.getAttribute("aria-expanded") === "true") {
            trigger.click();
            await waitFor(
              () =>
                trigger.getAttribute("aria-expanded") !== "true" && !getOpenModelMenu()
                  ? true
                  : null,
              { timeout: 200, interval: 6 }
            );
          }
        }
        return null;
      } finally {
        if (wasBusy) document.body.classList.add("pmu-busy");
        if (!wasBusy) {
          document.body.classList.remove("pmu-expect");
          if (!state.busy) setDrive(false);
        }
      }
    }

    /**
     * Select against the still-open native menu in ONE pass.
     * Order for optional-thinking models:
     *   1) freeze chip at final label (overlay — no double text)
     *   2) hold menu open (no reopen)
     *   3) set Thinking on the row's submenu FIRST
     *   4) then activate the row to commit the model
     * That avoids "lands on Thinking → flips to non-thinking" and the slow reopen.
     */
    async function selectModel(model, wantThinking) {
      if (Date.now() < state.ignoreSelectUntil) {
        state.picking = false;
        return;
      }
      const modelName = model.name;
      const needsToggle = model.canToggleThinking;
      const finalThinking = needsToggle ? !!wantThinking : !!model.forcedThinking;
      let item = model.el && document.contains(model.el) ? model.el : null;
      let menu = getOpenModelMenu();
      if (
        !menu &&
        state.menu &&
        document.contains(state.menu) &&
        state.menu.getAttribute("data-state") === "open"
      ) {
        menu = state.menu;
      }

      const before = readTriggerSelection();

      destroyPanel();
      setExpect(false);
      markPicking();
      setBusy(true);
      setDrive(true);
      // Overlay freezes the chip at the FINAL label for the whole drive.
      freezeChip(modelName, finalThinking);
      saveLastSelection(modelName, finalThinking);

      try {
        if (before.name === modelName && before.thinking === finalThinking) {
          return;
        }

        if (!menu || !document.contains(menu) || menu.getAttribute("data-state") !== "open") {
          unlockMenuOpen();
          menu = await openMenuFresh();
          item = null;
        }
        if (!menu) return;

        hideMenu(menu);
        lockMenuOpen(menu);

        if (!item || !document.contains(item)) item = findModelItem(menu, modelName);
        if (!item) return;

        // Same model, only Thinking differs — toggle only, no row re-select.
        if (needsToggle && before.name === modelName) {
          state.holdMenu = true;
          await setThinking(item, finalThinking);
          return;
        }

        if (needsToggle) {
          // Thinking FIRST while menu is held — chip already shows final label.
          state.holdMenu = true;
          await setThinking(item, finalThinking);
          if (!document.contains(item)) {
            item =
              findModelItem(menu, modelName) ||
              findModelItem(getOpenModelMenu() || menu, modelName);
            if (!item) return;
          }
        }

        // Commit the model row. Release hold so Radix can close + apply selection.
        state.holdMenu = false;
        unlockMenuOpen();
        hideMenu(menu);
        activateMenuItem(item, { real: true });
        await wait(50);

        if (!needsToggle) return;

        // Chip is frozen — don't trust its text. Verify via submenu controls.
        // Non-thinking is the usual failure mode (row-select often defaults ON).
        let liveMenu = getOpenModelMenu();
        if (liveMenu && document.contains(liveMenu)) {
          hideMenu(liveMenu);
          item = findModelItem(liveMenu, modelName);
          if (item) {
            forceOpenSubmenu(item);
            const c = await waitFor(() => thinkingControls(item), { timeout: 100, interval: 5 });
            if (c) {
              const el = c.checkbox || c.sw;
              if (el && (el.getAttribute("aria-checked") === "true") !== finalThinking) {
                state.holdMenu = true;
                lockMenuOpen(liveMenu);
                await setThinking(item, finalThinking);
              }
            } else if (!finalThinking) {
              state.holdMenu = true;
              lockMenuOpen(liveMenu);
              await setThinking(item, false);
            }
          }
        } else if (!finalThinking) {
          // Menu closed after select; force non-thinking under frozen chip.
          liveMenu = await openMenuFresh();
          if (!liveMenu) return;
          item = findModelItem(liveMenu, modelName);
          if (!item) return;
          state.holdMenu = true;
          lockMenuOpen(liveMenu);
          hideMenu(liveMenu);
          await setThinking(item, false);
        }
      } finally {
        state.holdMenu = false;
        saveLastSelection(modelName, finalThinking);
        unlockMenuOpen();
        state.suppressPanelUntil = Date.now() + 700;
        forceCloseMenu();
        await waitFor(() => (!getOpenModelMenu() ? true : null), { timeout: 120, interval: 6 });
        if (getOpenModelMenu()) forceCloseMenu();
        state.menu = null;
        state.picking = false;
        setDrive(false);
        setBusy(false);
        setExpect(false);
        // Overlay stays until native crossfade settles (async).
        unfreezeChip();
      }
    }

    /**
     * Same shape as selectModel(), but scoped to a Rewrite menu's own trigger —
     * never touches the main composer trigger. There's no persistent "current
     * selection" label to verify against (unlike the composer button), so this
     * skips the getSelection()-based shortcuts and just drives the real item.
     */
    async function selectRewriteModel(model, wantThinking) {
      if (Date.now() < state.ignoreSelectUntil) {
        state.picking = false;
        return;
      }

      const modelName = model.name;
      const needsToggle = model.canToggleThinking;
      const finalThinking = needsToggle ? !!wantThinking : !!model.forcedThinking;
      const rwTrigger = state.rewriteTrigger;
      let item = model.el && document.contains(model.el) ? model.el : null;
      let menu = getOpenModelMenu();
      if (
        !menu &&
        state.menu &&
        document.contains(state.menu) &&
        state.menu.getAttribute("data-state") === "open"
      ) {
        menu = state.menu;
      }

      destroyPanel();
      setExpect(false);
      markPicking();
      setBusy(true);

      const confirmRewrite = async () => {
        const root = menu && document.contains(menu) ? menu : document;
        const confirm = [...root.querySelectorAll("button")].find(
          (button) => (button.textContent || "").trim() === "Rewrite"
        );
        if (!confirm) return false;
        const activated = activateMenuItem(confirm, { preferClick: true });
        await wait(40);
        return activated;
      };

      try {
        if (!menu || !document.contains(menu) || menu.getAttribute("data-state") !== "open") {
          unlockMenuOpen();
          menu = await openMenuFresh(rwTrigger);
          item = null;
        }
        if (!menu) return;

        hideMenu(menu);
        if (!item || !document.contains(item)) item = findModelItem(menu, modelName);
        if (!item) return;

        activateMenuItem(item);

        if (!needsToggle) {
          await wait(60);
          await confirmRewrite();
          return;
        }

        // Brief settle so submenu/state can attach, then set Thinking.
        await wait(50);
        if (document.contains(item) && getOpenModelMenu()) {
          await setThinking(item, finalThinking);
          await wait(40);
          await confirmRewrite();
          return;
        }

        unlockMenuOpen();
        menu = await openMenuFresh(rwTrigger);
        if (!menu) return;
        item = findModelItem(menu, modelName);
        if (!item) return;

        activateMenuItem(item);
        await wait(50);
        await setThinking(item, finalThinking);
        await wait(40);
        await confirmRewrite();
      } finally {
        unlockMenuOpen();
        state.suppressPanelUntil = Date.now() + 900;
        // Rewrite selection appears to pass through the same Radix close path
        // as a normal menu selection. Give Perplexity's deferred rewrite work
        // time to consume that selection before we force its menu closed.
        await wait(500);
        forceCloseMenu(rwTrigger);
        await waitFor(() => (!getOpenModelMenu() ? true : null), { timeout: 200, interval: 8 });
        if (getOpenModelMenu()) forceCloseMenu(rwTrigger);
        state.menu = null;
        state.rewriteTrigger = null;
        state.pendingRewriteTrigger = null;
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
    function alignRewriteRows(standard, thinking) {
      const thinkByName = new Map(thinking.map((m) => [m.name, m]));
      const used = new Set();
      const stdPairs = [];
      const stdModels = [];
      const stdActions = [];

      for (const m of standard) {
        if (thinkByName.has(m.name)) {
          stdPairs.push(m);
          used.add(m.name);
        } else if (m.isModelRow) {
          stdModels.push(m);
        } else {
          stdActions.push(m);
        }
      }

      const thinkPairs = stdPairs.map((m) => thinkByName.get(m.name));
      const thinkOnly = thinking.filter((m) => !used.has(m.name));

      const col1 = [
        ...stdPairs.map((m) => ({ type: "item", item: m })),
        ...stdModels.map((m) => ({ type: "item", item: m })),
        ...(stdActions.length ? [{ type: "divider" }] : []),
        ...stdActions.map((m) => ({ type: "item", item: m })),
      ];

      const col2 = [
        ...thinkPairs.map((m) => ({ type: "item", item: m })),
        ...(thinkOnly.length ? [{ type: "divider" }] : []),
        ...thinkOnly.map((m) => ({ type: "item", item: m })),
      ];

      const maxLen = Math.max(col1.length, col2.length);
      const rows = [];
      for (let i = 0; i < maxLen; i++) {
        rows.push({
          std: col1[i] || null,
          think: col2[i] || null,
        });
      }
      return rows;
    }

  
    function showPanel(menu, keepPos) {
      const items = [...menu.querySelectorAll('[role^="menuitem"]')];
      const best = items.find(
        (it) =>
          !it.getAttribute("aria-haspopup") &&
          isAutoBestItem(it)
      );
      const models = items
        .filter(
          (it) =>
            it !== best &&
            it.getAttribute("role") !== "menuitemcheckbox" &&
            it.querySelector('.col-start-2 span[translate="no"]') // excludes non-model rows (Search, Deep research, …)
        )
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
      state.panelMode = "model";
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
  
    /**
     * Rewrite's menu shares the exact same markup/text as the main model menu
     * (same "Selects the best available model" list), so this reuses the same
     * extraction/layout as showPanel() — but selection must land on the real
     * item inside THIS menu (via selectRewriteModel), never on the composer's
     * trigger/menu. Unlike the main panel, this keeps every row (the auto
     * "Rewrite"/"Best" entry, Search, Deep research, Learn step by step, …) —
     * users want those choices here. No Edit-models footer: hiding models is
     * a composer concept and still applies via loadHidden(), but there's no
     * reopening path tied to editing a Rewrite menu.
     */
    function showRewritePanel(menu, triggerBtn) {
      const items = [...menu.querySelectorAll('[role^="menuitem"]')];
      const models = items
        .filter((it) => it.getAttribute("role") !== "menuitemcheckbox")
        // Drop auto "Best"/promo entry and standalone "Search" option
        .filter((it) => !isAutoBestItem(it))
        .map(extractItem)
        .filter((m) => !/^search$/i.test((m.name || "").trim()));
  
      const hidden = loadHidden();
      const unlocked = models.filter((m) => !m.locked && !hidden.has(m.name));
      const locked = models.filter((m) => m.locked && !hidden.has(m.name));
      const standard = unlocked
        .filter((m) => m.showInStandard)
        // Real models first (in original order), non-model rows (Search, Deep
        // research, …) after — keeps e.g. Sonar 2 grouped with the models
        // instead of interleaved by raw menu order.
        .sort((a, b) => (a.isModelRow === b.isModelRow ? 0 : a.isModelRow ? -1 : 1));
      const thinking = unlocked.filter((m) => m.showInThinking);
      const rows = alignRewriteRows(standard, thinking);
  
      destroyPanel();
      hideMenu(menu);
      state.menu = menu;
      state.panelMode = "rewrite";
      state.lastModels = unlocked;
      state.lastAllModels = models;
      state.editMode = false;
  
      const panel = document.createElement("div");
      panel.className = "pmu-panel";
  
      // No per-cell "selected" highlight here: a model that can toggle thinking
      // renders the SAME underlying item in both columns (one row, one submenu
      // toggle), so aria-checked on it can't tell which column is "current"
      // without lighting up both — unlike the main panel, which disambiguates
      // via the composer trigger's own label (getSelection()).
      const cell = (m, mode) => {
        return `<button type="button" class="pmu-cell" data-name="${m.name}" data-mode="${mode}">
          <span class="pmu-mini-icon">${m.svgHTML}</span>
          <span class="pmu-cell-name">${m.name}</span>
        </button>`;
      };
  
      const renderCell = (entry, mode) => {
        if (!entry) return `<div class="pmu-cell-spacer"></div>`;
        if (entry.type === "divider") return `<div class="pmu-row-divider-${mode === "standard" ? "col1" : "col2"}"></div>`;
        return cell(entry.item, mode);
      };

      let html = "";
      if (rows.length) {
        html += `<div class="pmu-cols">
          <div class="pmu-col-head">Non-thinking</div>
          <div class="pmu-col-head">Thinking</div>
          ${rows.map((r) => renderCell(r.std, "standard") + renderCell(r.think, "thinking")).join("")}
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
  
      panel.innerHTML = html;
  
      const rect = triggerBtn.getBoundingClientRect();
      panel.style.right = Math.max(8, window.innerWidth - rect.right) + "px";
  
      state.ignoreSelectUntil = Date.now() + 50;
      document.body.appendChild(panel);
      state.panel = panel;
      setExpect(false);
      lockMenuOpen(menu);
      positionPanel(panel, rect);
  
      document.addEventListener("mousedown", onOutside, true);
      document.addEventListener("keydown", onEscape, true);
    }

    /** Restyle the live Rewrite menu without replacing its trusted click targets. */
    function styleRewriteMenu(menu) {
      menu.removeAttribute("data-pmu-hidden");
      menu.classList.add("pmu-rewrite-native");

      if (!menu.querySelector(":scope > .pmu-rewrite-native-head")) {
        const head = document.createElement("div");
        head.className = "pmu-rewrite-native-head";
        head.textContent = "Rewrite with a model";
        menu.prepend(head);
      }

      for (const item of menu.querySelectorAll('[role^="menuitem"]')) {
        const isAutoBest = isAutoBestItem(item);
        item.classList.toggle("pmu-rewrite-native-best", isAutoBest);
        // Keep model choices together, ahead of Search/Research/Learn actions.
        item.style.order = item.querySelector('.col-start-2 span[translate="no"]') ? "1" : "2";
      }
    }
  
    // —— sync with Radix (the whole open/close strategy) ——————————————
  
    function sync() {
      if (state.busy || state.picking || state.editMode) return;
      if (Date.now() < state.suppressPanelUntil) return;
  
      const menu = getOpenModelMenu();
      if (menu) {
        const labelledBy = menu.getAttribute("aria-labelledby");
        const menuTrigger = labelledBy && document.getElementById(labelledBy);
        const isRewriteMenu = isRewriteButton(menuTrigger);
        const rewritePending =
          state.pendingRewriteTrigger &&
          document.contains(state.pendingRewriteTrigger) &&
          Date.now() - state.pendingRewriteAt < 2000;

        if (rewritePending || isRewriteMenu || state.rewriteMenu === menu) {
          state.rewriteMenu = menu;
          state.rewriteTrigger = state.pendingRewriteTrigger || menuTrigger || state.rewriteTrigger;
          if (!state.panel || state.panelMode !== "rewrite") {
            showRewritePanel(menu, state.rewriteTrigger);
          } else {
            hideMenu(menu);
            state.menu = menu;
          }
          state.pendingRewriteTrigger = null;
          setExpect(false);
          return;
        }
  
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
      state.rewriteMenu = null;
      if (state.panel) {
        destroyPanel();
        state.menu = null;
        setExpect(false);
        state.pendingRewriteTrigger = null;
        state.rewriteTrigger = null;
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
        markPicking();
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
          const isRewrite = state.panelMode === "rewrite";
          const rwTrigger = state.rewriteTrigger;
          destroyPanel();
          state.picking = false;
          setBusy(true);
          (async () => {
            try {
              const menu = await openMenuFresh(isRewrite ? rwTrigger : undefined);
              const item = menu && findModelItem(menu, name);
              if (item) activateMenuItem(item);
              await wait(120);
            } finally {
              forceCloseMenu(isRewrite ? rwTrigger : undefined);
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
        if (state.panelMode === "rewrite") selectRewriteModel(model, wantThinking);
        else selectModel(model, wantThinking);
      },
      true
    );
  
    // Anticipate open: hide native menu before first paint when user presses the trigger.
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (state.busy) return;
        const btn = e.target.closest('button[aria-haspopup="menu"]');
        if (!btn) return;
        const isRw = isRewriteButton(btn);
        const isMain = isLikelyModelTrigger(btn);
        if (isRw) {
          // Its menu shares our model-menu markup — route it to showRewritePanel
          // (via sync()) instead of the main composer flow.
          state.pendingRewriteTrigger = btn;
          state.pendingRewriteAt = Date.now();
          state.suppressPanelUntil = 0;
          if (!state.panel) setExpect(true);
          return;
        }
        if (!isMain) return;
        state.pendingRewriteTrigger = null;
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
          if (!state.panel && !state.busy) {
            setExpect(false);
            state.pendingRewriteTrigger = null;
          }
        }, 400);
      },
      true
    );
  
    let syncRaf = 0;
    const mo = new MutationObserver(() => {
      // Coalesce high-frequency Radix mutations into one sync per frame.
      if (syncRaf) return;
      syncRaf = requestAnimationFrame(() => {
        syncRaf = 0;
        sync();
      });
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
      if (!state.busy) {
        sync();
        if (!state.chipFreeze) repairDoubledChipLabel();
      }
    }, 500);

    setTimeout(() => {
      repairDoubledChipLabel();
      checkModelsConfigOnce();
    }, 1500);
  })();
