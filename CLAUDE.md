# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

PyNode is a Graph Theory visualizer: user-written Python drives an animated graph rendered in the browser. It is a static site — the root of the repo *is* the deployed site — and user code runs as real CPython (Pyodide) in a web worker.

A second form used to exist: a CPython + C++/CEF desktop app under `offline_src/`, distributed as ~171 MB of zips in `offline_downloads/`. **Both are gone.** Anything you find referring to an "offline version", a sync requirement between two copies of a file, or a `latest_src.zip` auto-updater is stale — say so rather than trying to honour it.

## Build, run, test

There is no build step, package manager, or linter for the site itself. The root of the repo *is* the deployed site.

There **is** a browser test suite in `tests/` — see the Tests section below.

- Run locally: serve the repo root over HTTP and open `index.html`. `file://` will not work — the `.py` files and `pynode_projects/*.py` are fetched over HTTP. **Plain `python -m http.server` is not sufficient**: it serves `.mjs` as `text/plain`, which browsers reject for module scripts, and Pyodide's worker then fails with an *empty* error message. Use:
  ```
  python -c "import http.server,mimetypes; mimetypes.add_type('text/javascript','.mjs'); mimetypes.add_type('application/wasm','.wasm'); http.server.test(HandlerClass=http.server.SimpleHTTPRequestHandler,port=8000,bind='127.0.0.1')"
  ```
  GitHub Pages serves these types correctly, so this is a local-dev-only concern.
- Deploy: pushing to `master` triggers [.github/workflows/build.yaml](.github/workflows/build.yaml), which publishes the whole repo root to the `gh-pages` branch. Nothing else is automated.
- Verification is manual: load the page, run an example from `pynode_projects/`, watch the output window and console.

## Architecture

### The command-stream model (the core idea)

User code never touches the renderer directly. Every API call in [pynode_graphlib.py](pynode_graphlib.py) mutates in-memory graph state *and* emits a `[name, args]` command naming a JavaScript function in [js/graph_api.js](js/graph_api.js) plus JSON-serializable args. `pause(ms)` emits a `["pause", [ms]]` marker.

**User code blocks for real.** `pause(ms)` genuinely sleeps the worker (`Atomics.wait`) while the main thread renders. Commands accumulate in the worker's outbox and are flushed immediately before each sleep, on a ~50 ms time budget, and at a 512-command cap; the host applies each arriving batch on a `requestAnimationFrame`. There is no replay timer on the main thread — pacing comes entirely from the worker's real sleeps.

The time budget is what makes output stream during a CPU-bound loop that never sleeps. Its cost is that a run of commands between two `pause()` calls is no longer guaranteed to land in a single frame. If you need a set of changes to appear atomically, use the mechanism that already exists for it: `enable_events(False)` around the mutations, then a single `js_add_all` / `js_remove_all`.

**`time.sleep` is monkeypatched onto `pump()`** in `pynode_core.py`. Pyodide's own `time.sleep` blocks the worker without letting it flush, so `print(i); sleep(1)` in a loop showed nothing for the whole run and then dumped everything. Routed through `pump`, `sleep()` flushes first, services `delay()` callbacks and clicks while it waits, and is interruptible by Stop — i.e. it behaves exactly like `pause()`. That convergence is deliberate.

Consequences worth remembering when changing the API:

- `pynode_core.pump(ms)` is the heart of it: sleep in ~16 ms slices, servicing due timers and queued clicks between slices. Slicing is what gives Pyodide bytecode boundaries at which the interrupt buffer is honoured, and what lets `delay()` callbacks and clicks run while user code sits inside a `pause()`.
- **`service()` only dispatches at `depth == 0`.** A `pause()` inside a callback sleeps and flushes renders but must not recursively dispatch further callbacks, or nested dispatch recurses without bound. Clicks arriving during a callback stay queued until it returns.
- After a run finishes the worker keeps servicing timers and clicks from a **JS `setInterval` tick**, never a Python loop — `tictactoe.py` registers a click listener and then ends, with the whole game driven by later `delay()` chains.
- `pynode_core.enable_events(False)` is used to batch: bulk operations mutate state with events suppressed, then emit a single `js_add_all`/`js_remove_all`.
- `add_event(..., source=node_or_edge)` drops the command if the source has since been removed from the graph.
- `Node.position()` reads a `Float64Array` position mirror the host writes every 100 ms, so it reflects the last rendered frame rather than the exact instant.
- End-of-run effects ("Done", the state flip to idle) are enqueued as synthetic `print` / `__state` commands rather than applied directly, so they stay ordered behind commands still waiting for a frame.

**`input()` blocks through the same machinery.** Pyodide's default stdin calls `window.prompt`, which does not exist in a worker, so it installed an erroring handler — the `OSError: [Errno 29]` users hit. `pyodide.setStdin` now supplies a hook that flushes (so the prompt paints), emits a synthetic `__input` command, and parks on `Atomics.wait`; the host appends a real `<input>` to the console and writes the answer back through a shared `io` buffer. `builtins.input` is wrapped in `pynode_core.py` so that Stop during a pending prompt ends the run as a clean "Stopped" rather than an `EOFError` traceback.

Three traps to remember here:
- **`TextEncoder` and `TextDecoder` both refuse SharedArrayBuffer-backed views** (`The provided ArrayBufferView value must not be shared`). Marshal through a normal `Uint8Array` and copy across. Pyodide swallows the resulting throw and reports it as `OSError`, which is thoroughly misleading.
- The input field is appended by the `__input` command riding the ordinary command stream, **not** by a `postMessage` raced against it. The same reason `__state` exists: anything ordered against console output has to travel in-band.
- `CTRL_IO_SEQ` guards against a stale answer from a finished run being consumed by the next one's first `input()`.

**Stop** sets a flag in the control block, writes SIGINT into Pyodide's interrupt buffer, and bumps the notify word. All three are needed: the notify wakes a sleeping worker, and the interrupt buffer is the only thing that can break a tight loop that never reaches `pump()`. That combination is what makes an endless loop survivable — it used to freeze the tab permanently.

### The Python ↔ JavaScript bridge

`pynode_core.py` is the seam: `pynode_graphlib.py` is written entirely against it and knows nothing about the browser. Keep that separation — it is what made swapping Brython for Pyodide a rewrite of one file rather than the whole API.

Real CPython (Pyodide) runs in [js/pynode_worker.js](js/pynode_worker.js), a **module worker** — Pyodide 0.28+ refuses to run in a classic worker. `pynode_core.py` stays pure Python (it never imports `js`); everything platform-specific arrives through `set_hooks(sink, sleep, poll, read_position)`, so the core can be exercised headlessly. [js/pynode_host.js](js/pynode_host.js) owns the worker and the shared control block, applies the command stream to whichever window holds the live `greuler_instance`, routes console output, and runs the run/stop/pause/restart button state machine. The SAB layout constants are duplicated at the top of both files and **must be kept in step**.

The `js_*` string constants at the bottom of `pynode_core.py` are the protocol; they must match the function names in `graph_api.js`.

**Two traps that cost real debugging time:**

- **Do not call `pynode_graphlib._exec_code()`.** It does `namespace = locals()` inside a function, which under CPython is just `{'src': ...}`, so user code cannot see `graph`, `Node`, `Edge`, `Color` or `pause`. Brython chains function-scope `locals()` to module globals, which is why it worked before. `pynode_core.run_code()` builds the namespace from a copy of `pynode_graphlib.__dict__` instead.
- **A blocked worker cannot receive `postMessage`.** While user code runs, the worker is parked in `Atomics.wait` and executes no JavaScript, so clicks and the stop/pause flags travel through the `SharedArrayBuffer` — never `postMessage`. This is also why the post-run idle loop is a JS tick rather than a Python `while True`.

### Rendering stack

`graph_api.js` mutates `greuler_instance` (a modified [Greuler](js/greuler/greuler.js), which sits on WebCola for layout and D3 for drawing). [js/resize.js](js/resize.js) owns layout: it injects invisible boundary nodes to constrain the layout to the viewport, and manages the two layout modes and node pinning. [js/d3_controls.js](js/d3_controls.js) handles pan/zoom.

### Page structure

[index.html](index.html) is a single ~900-line file containing the app *and* the full documentation site. It hosts the Monaco editor ([js/monaco_setup.js](js/monaco_setup.js)), the console, the output SVG, and the worker host.

`pynode_editor.html`, `pynode_console.html` and `pynode_output.html` are detached-window variants opened with `window.open`, tracked by the parent globals `pynode_editor` / `pynode_console` / `pynode_output`. Only **one** Python runtime exists, owned by the main page — `pynode_output.html` is now a pure render target with its own `greuler_instance`, and its buttons call `window.opener.PyNodeHost`. The two editors sync over `BroadcastChannel`, so the editor popup needs no `window.opener` at all.

`coi-serviceworker.js` must be the **first** script in every page's `<head>` and must live at the **repo root** — a service worker's scope is its own directory, and GitHub Pages cannot send the `Service-Worker-Allowed` header needed to widen it. It synthesizes the COOP/COEP headers that make `SharedArrayBuffer` available, and reloads the page once on first visit. Same-origin popups receive the same headers, so `window.opener` survives (verified).

Editor state persists in `localStorage` under the key `code`, and `?project=<name>` loads from `pynode_projects/`. The site makes no cross-origin requests at all — everything is vendored.

## Tests

`tests/` holds a Playwright suite run by Node's built-in test runner:

```
cd tests && npm ci && npm test          # ~100s, 36 tests
npm test -- --test-name-pattern=theme   # filter
npm test -- ./io.test.mjs               # one file
```

It starts its own static server, so **no Python and no manually started server**. That server sends COOP/COEP itself, which makes pages isolated on first paint and skips the `coi-serviceworker` reload — a large speed and determinism win. The consequence is that the default path does *not* exercise the service worker, so `isolation.test.mjs` runs against a headerless server to cover the real GitHub Pages path. **Do not skip that file.**

Each test opens a fresh `BrowserContext`: `localStorage` carries the editor contents and the theme between tests, and clean-by-construction beats remembering to clear the right keys.

Set `CHROME_PATH` if Chrome/Edge is not in a standard location.

## Conventions

- **`pynode_graphlib.py` and `js/graph_api.js` are no longer frozen.** They used to be byte-identical to copies under `offline_src/`, so nothing could touch them. That tree is gone and the constraint is lifted. Several awkward workarounds exist purely because of it — most visibly `pynode_core.run_code`, which reimplements `_exec_code` because the frozen version relies on Brython's `locals()` semantics. Those are now fixable at the source if you want.
- **Theming**: `css/style.css` defines every colour as a custom property. **Dark is the unconditional default** — the dark palette sits on bare `:root`, and light applies only under `:root[data-theme="light"]`. `prefers-color-scheme` is deliberately not consulted, so a first visit is dark whatever the visitor's OS says. Every dark-only rule therefore reads `:root:not([data-theme="light"])`: one guard direction throughout, no duplicated declaration blocks. `js/pynode_theme.js` persists the choice, syncs the four documents over `BroadcastChannel("pynode-theme")`, and drives Monaco (which cannot read custom properties). `:root` also sets `color-scheme`, which is what themes native widgets and scrollbars.
  To go back to following the OS: put the light values on bare `:root`, wrap the dark values in `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`, and repeat them under `:root[data-theme="dark"]` — the guard is what lets an explicit light choice beat a dark desktop.
  Two rules: **never set a colour from JavaScript** — an inline style beats the stylesheet and silently defeats the whole system (this is exactly what the old `#6E6E6E` run-button assignments did) — and **`--bg-canvas` stays light in both themes**, because node and edge defaults come from `Color.DARK_GREY` / `Color.LIGHT_GREY` in the frozen `pynode_graphlib.py`.
- **Cache busting**: first-party script and stylesheet tags carry `?version=0.9.x` query strings. Bump the version on a file's tag in *every* HTML page that references it, or returning users get stale assets. **Two exceptions, both mandatory:**
  - `js/monaco/vs` and `js/pyodide/` must have **no** query string. Monaco's AMD loader and `loadPyodide({indexURL})` construct their own child-module URLs from those base paths and will not propagate one. To bust a vendored library, rename its directory.
  - `coi-serviceworker.js` carries no version either, so the service worker URL stays stable across deploys.
- Contributions go to `master`; deployment to `gh-pages` is automatic from there.
