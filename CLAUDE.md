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

Real CPython (Pyodide) runs in [js/pynode_worker.js](js/pynode_worker.js), a **module worker** — Pyodide 0.28+ refuses to run in a classic worker. `pynode_core.py` stays pure Python (it never imports `js`); everything platform-specific arrives through `set_hooks(sink, sleep, poll, read_position)`, so the core can be exercised headlessly. [js/pynode_host.js](js/pynode_host.js) owns the worker and the shared control block, applies the command stream to the **one** output window that currently owns it, routes console output, and runs the run/stop/pause/restart button state machine. The SAB layout constants are duplicated at the top of both files and **must be kept in step**.

The `js_*` string constants at the bottom of `pynode_core.py` are the protocol; they must match the function names in `graph_api.js`.

**Two traps that cost real debugging time:**

- **Do not call `pynode_graphlib._exec_code()`.** It does `namespace = locals()` inside a function, which under CPython is just `{'src': ...}`, so user code cannot see `graph`, `Node`, `Edge`, `Color` or `pause`. Brython chains function-scope `locals()` to module globals, which is why it worked before. `pynode_core.run_code()` builds the namespace from a copy of `pynode_graphlib.__dict__` instead.
- **A blocked worker cannot receive `postMessage`.** While user code runs, the worker is parked in `Atomics.wait` and executes no JavaScript, so clicks and the stop/pause flags travel through the `SharedArrayBuffer` — never `postMessage`. This is also why the post-run idle loop is a JS tick rather than a Python `while True`.

### The debugger

[pynode_debug.py](pynode_debug.py) is pure Python like the core (no `js`); the worker hands it `debug_poll` / `debug_read` hooks via `install()`. User code is compiled under the filename `"<pynode>"` (`pynode_core.run_code`), which is how its frames are told from the library's and why line numbers map one-to-one onto the editor.

- **Engine: `sys.monitoring`, not `settrace`.** A LINE callback that returns `DISABLE` silences that location until `restart_events()`, so lines without a breakpoint cost nothing and animation timing is unaffected (a test guards this). Stepping, Record and every settings change call `restart_events()`.
- **A stop is the callback blocking**: flush, report a snapshot in-band as a synthetic `__debug` command, then wait on the control block for a command. It **never calls `service()`** - that is what freezes `delay()` callbacks and clicks while stopped.
- **Reaching code that isn't reporting lines** (a tight loop, a `pause()`): the host writes **SIGUSR1 (10)** into Pyodide's interrupt buffer, and `_on_signal` runs at the next bytecode boundary with the live frame. That is how Pause and breakpoints added mid-run work in a `while True`. SIGINT (2) remains Stop.
- **Control block**: `CTRL_DBG_CMD/ARG/VER/BREAK/LEN` follow the click ring (words 72-76, `CTRL_LEN` 77), plus a 32 KB `dbg` buffer of JSON `{breakpoints, watches, record}`. Same TextEncoder/SharedArrayBuffer trap as `input()`.
- **In-band, always**: `__debug {paused|running|ended}` and `__trace` ride the command stream. The end of a session is enqueued (not applied on the `done` message) because the last `running` report may still be waiting for a frame - applying `ended` directly let `running` land after it.
- **Host state `paused` means stopped in the debugger.** Pause flips it at once and the worker's report fills in the line. When a run ends, the stack/variables/watch values are cleared (nothing is live any more); the trace log is kept until the next Play.
- **Editor**: breakpoints are Monaco decorations (they move with edits), persisted in `localStorage` `breakpoints`, mirrored to the editor popup over `pynode-code`. `editor.setValue` keeps them (and suppresses change reports while Monaco briefly drops all decorations); `replaceValue` - a new file or example - clears them.
- **Stop surfaces anywhere**: the SIGINT can land in the worker's idle tick or a reset between runs. `isStop()` in the worker treats that as a stop, never an error; it used to print a bare "PythonError".

### Rendering stack

`graph_api.js` mutates `greuler_instance` (a modified [Greuler](js/greuler/greuler.js), which sits on WebCola for layout and D3 for drawing). [js/resize.js](js/resize.js) owns layout: it injects invisible boundary nodes to constrain the layout to the viewport, and manages the two layout modes and node pinning. [js/d3_controls.js](js/d3_controls.js) handles pan/zoom.

### Page structure

[index.html](index.html) is the app: a slim three-column header — logo and Examples menu on the left, the icon-only colour-coded run controls (`#run` / `#stop` / `#restart`, same ids the host binds) centred, and the editor's file icons, theme toggle and Docs on the right — over an app band that fills the viewport. The editor has no title bar. The centre group is meant to take debugger buttons later. `js/pynode_host.js` sets `data-run-state` on each window's `<body>` so CSS can dim Stop when idle. The page itself does not scroll (above a ~540px minimum height) — the editor and console flex to fill the window. The layout is tuned for ~1280×630 CSS px, i.e. 1080p at 150% scaling, the common laptop default.

The output box **scales** between 0.6× and 1.0× of 500×400 so that the console always fits under it (`--out-h` / `--out-w` in `style.css`, with the arithmetic in a comment there), but the graph's **coordinate space stays 500×400**: index.html sets `viewBox="0 0 500 400"` on the SVG, and `js/resize.js` takes the layout bounds from `layoutSize()` (greuler's options), never from `#outputBox.clientWidth`. Reading the box size there would squash every graph into the corner of the logical canvas. `node.set_position`, `node.position()` and clicks all work in logical coordinates; d3 maps the mouse through the viewBox. The output popup is different: its canvas really does resize, and `output_resize()` writes the new size into those same options.

It hosts the Monaco editor ([js/monaco_setup.js](js/monaco_setup.js)), the console, the output SVG, and the worker host.

The documentation and About text live **only** in [pynode_docs.html](pynode_docs.html). `toggleDocs()` in index.html fetches that page on first open and lifts its `.docsContent` into a slide-over drawer; `docsPopup()` opens the same page detached. Edit the docs there, and keep them self-contained inside `.docsContent`.

`pynode_editor.html`, `pynode_console.html` and `pynode_output.html` are detached-window variants opened with `window.open`, tracked by the parent globals `pynode_editor` / `pynode_console` / `pynode_output`. Only **one** Python runtime exists, owned by the main page — `pynode_output.html` is now a pure render target with its own `greuler_instance`, and its buttons call `window.opener.PyNodeHost`. The two editors sync over `BroadcastChannel`, so the editor popup needs no `window.opener` at all.

**Exactly one output window owns the render stream at a time, and popping out moves it.** While `pynode_output.html` is open (and adopted) it draws *every* run, whichever window's Play was pressed; the docked panel shows an "Output is in a separate window · Bring it back" placeholder (`body.output-popped`). `play(origin)` / `restart(origin)` still accept an origin because older cached popup pages pass one, but it is ignored. `PyNodeHost.popOut` / `popIn` carry the current graph across in both directions with `snapshotGraph` / `restoreGraph`, so neither window opens blank or keeps a stale picture. The snapshot has to be taken while the source window is alive, so the popup announces itself (`outputOpened` on load, `outputClosing` on `pagehide`) and `index.html` repeats both from its own handlers — `window.open` reuses the named window, so those can attach too late, and a stale popup page may not announce at all. Everything is idempotent; a closing window is flagged `__pynodeClosing` and excluded from `targets()` immediately. One trap: `edge.traverse(keep_path=True)` colours the edge only in the DOM, so `graph_api.js` records it as `keptStroke` (deliberately not `stroke`, which the next `update()` would paint before the animation got there) for the snapshot to read.

The console popup works the same way (`consoleOpened` / `consoleClosing`): it is seeded with the transcript so far, and a pending `input()` field moves into it and back.

**Do not render to both windows at once.** It was tried and reverted: each window owns an independent `greuler_instance` running its own WebCola layout at its own canvas size, so the same graph settles into visibly different node positions in each and the two pictures never agree. Only `print` / `__state` / `__input` are handled window-independently, by the host — they drive the single console, button state machine and pending `input()` field. Button state (`show`) still updates *both* windows, because there is one worker and one run: Play in the popup must show PAUSE on the main page too, since Stop there stops that run.

Clicks follow ownership. `registerClicks` installs the listener on the window that owns the stream and **disables** it on the others by calling `registerClickListener()` with no argument — it assigns its parameter to a window-local `clickListener` that `clickNode` guards with `!== undefined`. A live listener on the inactive window let a click on a stale graph feed a bogus node id to the running program.

`coi-serviceworker.js` must be the **first** script in every page's `<head>` and must live at the **repo root** — a service worker's scope is its own directory, and GitHub Pages cannot send the `Service-Worker-Allowed` header needed to widen it. It synthesizes the COOP/COEP headers that make `SharedArrayBuffer` available, and reloads the page once on first visit. Same-origin popups receive the same headers, so `window.opener` survives (verified).

Editor state persists in `localStorage` under the key `code`, and `?project=<name>` loads from `pynode_projects/`. The site makes no cross-origin requests at all — everything is vendored.

## Tests

`tests/` holds a Playwright suite run by Node's built-in test runner:

```
cd tests && npm ci && npm test          # ~150s, 76 tests
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

  **The detached pages are the gap this convention leaves.** `pynode_output.html`, `pynode_editor.html` and `pynode_console.html` hold behaviour in their *own* inline scripts, and a page has no script tag of its own to version — so a returning browser can serve a stale copy forever. `index.html` therefore opens them as `window.open("pynode_output.html?version=0.9.x", ...)`; bump that alongside the script versions whenever one of those inline scripts changes. This bit once already: the popup's Play button kept calling `play()` with no origin argument and silently ran the graph in the main window. Belt and braces, `PyNodeHost.bindButtons` rebinds each output window's run/stop/restart from `pynode_host.js` — which *is* versioned — so button routing never depends on a page's cached inline handlers.
- Contributions go to `master`; deployment to `gh-pages` is automatic from there.
