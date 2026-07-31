# Perplexity Model Selector Redesign

Tampermonkey userscript for [Perplexity.ai](https://www.perplexity.ai) that replaces the default model menu with a clearer **Non-thinking / Thinking** picker.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open the raw script URL (Tampermonkey should prompt to install):

   https://raw.githubusercontent.com/Dazaike/perplexity-model-selector-redesign/main/perplexity-model-selector-redesign.user.js

3. Confirm install, then reload Perplexity.

## Features

- **Custom two-column picker** — Non-thinking and Thinking models side by side
- **Thinking toggle** — driven through Perplexity’s real model menu (not a fake UI-only switch)
- **Edit models** — hide models you don’t use from the picker
- **Lexend font** — consistent typography in the custom panel
- **Flip above** — panel opens above the trigger when the input is at the bottom of the page
- **Config watch** — one-shot check of `/rest/models/config` on load; snapshot saved in Tampermonkey storage with a notification when it changes

## Scope

Runs on `https://www.perplexity.ai` (and `https://perplexity.ai`). Main file: `perplexity-model-selector-redesign.user.js`.
