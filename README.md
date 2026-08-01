# Perplexity Model Selector Redesign

Tampermonkey userscript for [Perplexity.ai](https://www.perplexity.ai) that replaces native model selector menus with a custom **Non-thinking / Thinking** picker.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open the raw script URL:

   https://raw.githubusercontent.com/Dazaike/perplexity-model-selector-redesign/main/perplexity-model-selector-redesign-v2.user.js

3. Confirm install, then reload Perplexity.

## Features

- **Custom two-column picker** — Non-thinking and Thinking models side by side.
- **Rewrite Session Menu Support** — Redesigns per-message Rewrite controls into a matching custom panel with model alignment and column-bound action dividers.
- **Thinking toggle** — driven through Perplexity’s real model menu.
- **Edit models** — hide models you don’t use from the picker (shared local storage).
- **Lexend font & flip positioning** — consistent typography; panel flips above when trigger is near the bottom.
- **Config watch** — one-shot check of `/rest/models/config` on load with snapshot notifications on updates.

## Scope

Runs on `https://www.perplexity.ai/*` and `https://perplexity.ai/*`. Main file: `perplexity-model-selector-redesign-v2.user.js`.
