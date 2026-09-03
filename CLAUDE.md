# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

PyNode is a Graph Theory visualizer: user-written Python drives an animated graph rendered in the browser. It ships in two forms that share the same Python API surface:

- **Online version** (repo root) — Python runs in the browser via Brython.
- **Offline version** (`offline_src/`) — CPython drives a C++/CEF desktop app over stdin/stdout.

## Build, run, test

There is no build step, package manager, test suite, or linter. The root of the repo *is* the deployed site.

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

**User code blocks for real.** `pause(ms)` genuinely sleeps the worker (`Atomics.wait`) while the main thread renders. Commands accumulate in the worker's outbox and are flushed as one batch immediately before each sleep, so everything between two `pause()` calls reaches the renderer together and is applied on one `requestAnimationFrame`. There is no replay timer on the main thread — pacing comes entirely from the worker's real sleeps.

Consequences worth remembering when changing the API:

- `pynode_core.pump(ms)` is the heart of it: sleep in ~16 ms slices, servicing due timers and queued clicks between slices. Slicing is what gives Pyodide bytecode boundaries at which the interrupt buffer is honoured, and what lets `delay()` callbacks and clicks run while user code sits inside a `pause()`.
- **`service()` only dispatches at `depth == 0`.** A `pause()` inside a callback sleeps and flushes renders but must not recursively dispatch further callbacks, or nested dispatch recurses without bound. Clicks arriving during a callback stay queued until it returns.
- After a run finishes the worker keeps servicing timers and clicks from a **JS `setInterval` tick**, never a Python loop — `tictactoe.py` registers a click listener and then ends, with the whole game driven by later `delay()` chains.
- `pynode_core.enable_events(False)` is used to batch: bulk operations mutate state with events suppressed, then emit a single `js_add_all`/`js_remove_all`.
- `add_event(..., source=node_or_edge)` drops the command if the source has since been removed from the graph.
- `Node.position()` reads a `Float64Array` position mirror the host writes every 100 ms, so it reflects the last rendered frame rather than the exact instant.
- End-of-run effects ("Done", the state flip to idle) are enqueued as synthetic `print` / `__state` commands rather than applied directly, so they stay ordered behind commands still waiting for a frame.

**Stop** sets a flag in the control block, writes SIGINT into Pyodide's interrupt buffer, and bumps the notify word. All three are needed: the notify wakes a sleeping worker, and the interrupt buffer is the only thing that can break a tight loop that never reaches `pump()`. That combination is what makes an endless loop survivable — it used to freeze the tab permanently.

### The Python ↔ JavaScript bridge

`pynode_core.py` is the only portability seam. `pynode_graphlib.py` is written against it and is byte-identical between online and offline apart from the import line (`import pynode_core` vs `from pynode.src import pynode_core`). **Keep it that way** — it is the contract, not an implementation detail.

- **Online**: real CPython (Pyodide) runs in [js/pynode_worker.js](js/pynode_worker.js), a **module worker** — Pyodide 0.28+ refuses to run in a classic worker. `pynode_core.py` stays pure Python (it never imports `js`); everything platform-specific arrives through `set_hooks(sink, sleep, poll, read_position)`, so the core can be exercised headlessly. [js/pynode_host.js](js/pynode_host.js) owns the worker and the shared control block, applies the command stream to whichever window holds the live `greuler_instance`, routes console output, and runs the run/stop/pause/restart button state machine. The SAB layout constants are duplicated at the top of both files and **must be kept in step**.
- **Offline**: the same command names are written to the CEF process's stdin as `pynode:js_foo:[args]` by `offline_src/pynode/src/communicate.py`; responses come back over stdout as `pynode:response:<uuid>:<json>`, matched by request id.

The `js_*` string constants at the bottom of both `pynode_core.py` files are the protocol; they must match the function names in `graph_api.js`.

**Two traps that cost real debugging time:**

- **Do not call `pynode_graphlib._exec_code()`.** It does `namespace = locals()` inside a function, which under CPython is just `{'src': ...}`, so user code cannot see `graph`, `Node`, `Edge`, `Color` or `pause`. Brython chains function-scope `locals()` to module globals, which is why it worked before. `pynode_core.run_code()` builds the namespace from a copy of `pynode_graphlib.__dict__` instead.
- **A blocked worker cannot receive `postMessage`.** While user code runs, the worker is parked in `Atomics.wait` and executes no JavaScript, so clicks and the stop/pause flags travel through the `SharedArrayBuffer` — never `postMessage`. This is also why the post-run idle loop is a JS tick rather than a Python `while True`.

### Rendering stack

`graph_api.js` mutates `greuler_instance` (a modified [Greuler](js/greuler/greuler.js), which sits on WebCola for layout and D3 for drawing). [js/resize.js](js/resize.js) owns layout: it injects invisible boundary nodes to constrain the layout to the viewport, and manages the two layout modes and node pinning. [js/d3_controls.js](js/d3_controls.js) handles pan/zoom.

### Page structure

[index.html](index.html) is a single ~900-line file containing the app *and* the full documentation site. It hosts the Monaco editor ([js/monaco_setup.js](js/monaco_setup.js)), the console, the output SVG, and the worker host.

`pynode_editor.html`, `pynode_console.html` and `pynode_output.html` are detached-window variants opened with `window.open`, tracked by the parent globals `pynode_editor` / `pynode_console` / `pynode_output`. Only **one** Python runtime exists, owned by the main page — `pynode_output.html` is now a pure render target with its own `greuler_instance`, and its buttons call `window.opener.PyNodeHost`. The two editors sync over `BroadcastChannel`, so the editor popup needs no `window.opener` at all.

`coi-serviceworker.js` must be the **first** script in every page's `<head>` and must live at the **repo root** — a service worker's scope is its own directory, and GitHub Pages cannot send the `Service-Worker-Allowed` header needed to widen it. It synthesizes the COOP/COEP headers that make `SharedArrayBuffer` available, and reloads the page once on first visit. Same-origin popups receive the same headers, so `window.opener` survives (verified).

Editor state persists in `localStorage` under the key `code`. `?project=<name>` loads from `pynode_projects/`; `?gist=<user>-<gistid>` fetches raw content from gist.githubusercontent.com.

## Conventions

- **Keep online and offline in sync — but know which files actually are.** `pynode_graphlib.py`, `js/graph_api.js` and `js/resize.js` are byte-identical to their `offline_src/pynode/src/` counterparts (graphlib bar its import line) and must stay so. `pynode_core.py` is *deliberately* divergent — it is the portability seam, and the two implementations differ by transport. `css/style.css` was already divergent before this work (the offline copy has no `#editor` rules).
- **Publishing the offline version** (per [offline_src/README.md](offline_src/README.md)): bump `offline_src/pynode/src/version.txt`, zip that `src/` folder to `offline_downloads/latest_src.zip`, and set `offline_downloads/latest_version.txt` to the same number — that is what the in-app auto-updater polls.
- **Cache busting**: first-party script and stylesheet tags carry `?version=0.9.x` query strings. Bump the version on a file's tag in *every* HTML page that references it, or returning users get stale assets. **Two exceptions, both mandatory:**
  - `js/monaco/vs` and `js/pyodide/` must have **no** query string. Monaco's AMD loader and `loadPyodide({indexURL})` construct their own child-module URLs from those base paths and will not propagate one. To bust a vendored library, rename its directory.
  - `coi-serviceworker.js` carries no version either, so the service worker URL stays stable across deploys.
- Contributions go to `master`; deployment to `gh-pages` is automatic from there.
