# PyNode tests

Browser tests driven by Playwright, run by Node's built-in test runner.

```
cd tests
npm ci
npm test
```

Roughly 100 seconds, 36 tests. Nothing touches the network, needs Python, or downloads a
browser: the suite starts its own static server and drives the Chrome (or Edge) you
already have.

```
npm test -- --test-name-pattern=theme    # filter by name
npm test -- ./io.test.mjs                # one file
npm run screenshots                      # writes tests/screenshots/*.png
```

## Requirements

- Node 22+ (uses `node:test`). Developed on 24.
- Any Chromium-based browser. Set `CHROME_PATH` if it is not in a standard location:
  ```
  CHROME_PATH="/path/to/chrome" npm test
  ```

| env var | effect |
|---|---|
| `CHROME_PATH` | browser executable to use |

## What each file covers

| file | covers |
|---|---|
| `isolation.test.mjs` | cross-origin isolation via the **real service-worker path**; `window.opener` and SharedArrayBuffer surviving COOP across all three popups |
| `editor.test.mjs` | Monaco loading and tokenising Python, the `window.editor` facade, `?project=`, cross-window code sync |
| `runtime.test.mjs` | worker boot, `pause()` really blocking, Stop on an infinite loop, pause/resume, `node.position()`, click + `delay()` chains, all six shipped examples |
| `io.test.mjs` | `input()` flows, Stop/Escape while a prompt is pending, `time.sleep()` and CPU-bound output streaming |
| `theme.test.mjs` | dark-by-default regardless of OS, toggle and persistence, the canvas staying light, themeable run buttons, Monaco and popups following |
| `popups.test.mjs` | detached console and output windows, and the popup Play button driving the opener's worker |

## Why there is a custom server

`python -m http.server` serves `.mjs` as `text/plain`. Browsers reject that for module
scripts, and Pyodide's module worker then fails with an **empty** error message — no text,
no filename. That is close to undebuggable if you do not already know the cause, and it
cost real time once. `server.mjs` gets the MIME types right by construction.

It also sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless` itself. That makes pages cross-origin
isolated on their **first paint**, so `coi-serviceworker.js` takes its early return and
never registers — which removes the once-per-context reload that would otherwise slow and
destabilise every test.

The catch: that path is *not* what GitHub Pages does. So **`isolation.test.mjs` runs
against a headerless server**, exercising the real service-worker registration and
reload. Do not skip or `.only` past that file; it is the only coverage of how the deployed
site actually becomes isolated.

## Things that will bite you

**Console text needs normalising.** `pynode_core.format_string_HTML` turns every space
into `&nbsp;`, which `innerText` returns as `U+00A0`. A naive
`innerText.includes("hello world")` silently fails. Use `consoleText()` from
`helpers.mjs`, which normalises whitespace. This already produced one false failure.

**Assert lower bounds on time, never upper bounds.** A slow machine cannot make
`sleep(1)` finish early, but it can absolutely make a fixed-interval snapshot land
somewhere you did not expect. The streaming tests assert "this output appeared *while the
run was still going*", not "this appeared within N ms".

**CSS transitions lie to `getComputedStyle`.** `style.css` transitions
`background-color` over 0.2 s, and a computed read mid-transition returns the interpolated
value — i.e. the *old* colour. Wait ~400 ms after a theme change before asserting, or a
passing feature looks broken.

**Monaco's light background is `#FFFFFE`,** not pure white. Do not assert
`rgb(255, 255, 255)`.

**Fresh context per test.** `localStorage` carries the editor contents (`code`) and the
theme (`pynode-theme`) between tests. `openApp()` gives each test its own
`BrowserContext`, which is clean by construction rather than by remembering to clear the
right two keys. Pyodide's wasm is served from the browser's shared HTTP cache, so a repeat
boot is a few seconds rather than a fresh 13 MB download.

**`waitForWorker: false`** skips the Pyodide wait entirely. Use it for anything that only
touches the editor, theme or chrome — it turns a ~5 s test into a ~0.5 s one.

## A note on deployment

`.github/workflows/build.yaml` publishes the whole repo root to `gh-pages`, so this
directory ships with the site — about 60 KB of `.mjs`. Harmless, and not worth
complicating the deploy to avoid. `node_modules/` is gitignored and never reaches the
checkout the workflow deploys from; keep it that way.
