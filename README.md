# Perplexity Model Selector Redesign

Tampermonkey userscript for [Perplexity.ai](https://www.perplexity.ai) that replaces native model selector menus with a custom **Non-thinking / Thinking** picker.

**Current version:** `2.6.2`

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open the raw script URL:

   https://raw.githubusercontent.com/Dazaike/perplexity-model-selector-redesign/main/perplexity-model-selector-redesign-v2.user.js

3. Confirm install, then reload Perplexity.

To update later: Tampermonkey → script → check for updates, or re-open the raw URL after a new release.

## Features

- **Custom two-column picker** — Non-thinking and Thinking models side by side.
- **Rewrite Session Menu Support** — Redesigns per-message Rewrite controls into a matching custom panel with model alignment and column-bound action dividers.
- **Faster selection drive** — holds the native menu through Thinking toggle + model commit (no slow reopen loop).
- **Stable chip label** — overlays the composer chip during selection so intermediate Thinking flashes and doubled labels don’t show.
- **Current Perplexity UI support** — detects the generic “Model” chip and “Access the top AI models” menu copy (plus older variants).
- **Edit models** — hide models you don’t use from the picker (shared local storage).
- **Lexend font & flip positioning** — consistent typography; panel flips above when trigger is near the bottom.
- **Config watch** — one-shot check of `/rest/models/config` on load with snapshot notifications on updates.

## Scope

Runs on `https://www.perplexity.ai/*` and `https://perplexity.ai/*`.

Main file: `perplexity-model-selector-redesign-v2.user.js`.

## Changelog

### 2.6.2

- Selection path rewritten for speed: Thinking-first while the menu is held, then model commit.
- Chip overlay freezes the final label through Perplexity’s crossfade (no doubled “Name Name Thinking”).
- Never rewrites React chip text nodes; only repairs doubled-label residue from older builds.
- Menu detection updated for current PPLX promo copy and the generic “Model” trigger.
- `pmu-drive` keeps pointer-events on hidden menus so synthetic clicks land.
- Remembers last selection for panel highlight when the chip is only “Model”.

### 2.4.18

- Rewrite panel layout, model alignment, column dividers, README.
