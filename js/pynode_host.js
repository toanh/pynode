// PyNode host - main-thread side of the Pyodide worker.
//
// Owns the single worker, applies its command stream to the one output window that owns
// the render stream, routes console output, and drives the run/stop/pause/restart button
// state machine. That state machine used to live in pynode_core.py and manipulate the DOM
// through Brython; Pyodide runs in a worker with no DOM, so it has to live on this side.
//
// Pacing is no longer done here. The worker blocks for real on pause() and flushes a
// batch of commands just before each sleep, so batches are applied as they arrive.

var PyNodeHost = (function () {
    "use strict";

    var VERSION = "0.9.26";

    // --- SAB layout. Must match js/pynode_worker.js exactly. ---
    var CTRL_NOTIFY = 0, CTRL_STOP = 1, CTRL_PAUSE = 2, CTRL_CLICK_W = 3, CTRL_CLICK_R = 4;
    var CTRL_IO_STATE = 5, CTRL_IO_LEN = 6;   // 0 idle | 1 pending | 2 ready | 3 cancelled
    var CTRL_IO_SEQ = 7;                      // request id, guards against stale answers
    var CLICK_BASE = 8, CLICK_CAP = 64;
    // Debugger words, after the click ring. See pynode_debug.py.
    var CTRL_DBG_CMD = 72, CTRL_DBG_ARG = 73, CTRL_DBG_VER = 74, CTRL_DBG_BREAK = 75, CTRL_DBG_LEN = 76;
    var CTRL_LEN = 77;
    var DBG_LEN = 32768;                      // UTF-8 JSON: {breakpoints, watches, record}
    var DBG_CONTINUE = 1, DBG_INTO = 2, DBG_OVER = 3, DBG_OUT = 4, DBG_INSPECT = 5;
    var SIGUSR1 = 10;                         // wakes pynode_debug's signal handler
    var POS_W = 0, POS_H = 1, POS_BASE = 4, POS_MAX = 1024, POS_LEN = POS_BASE + POS_MAX * 3;
    var IO_LEN = 8192;                        // UTF-8 answer from input()

    var worker = null;
    var ready = false;
    var isolated = (typeof SharedArrayBuffer === "function") && (self.crossOriginIsolated === true);
    var state = "boot";              // boot | idle | playing | paused (= stopped in the debugger)
    var ctrl = null, pos = null, interrupt = null, io = null, dbg = null;
    var inputEl = null;              // the live <input> while input() is pending
    var pendingSeq = -1;             // which input() request that field belongs to
    var pending = [];                // command batches awaiting a frame
    var frameQueued = false;
    var positionsTimer = null;

    // --- render target ------------------------------------------------------
    // The detached output popup owns its own greuler_instance. Every function in
    // graph_api.js closes over its own window's global, so calling it on the popup
    // mutates the popup's graph. No changes to graph_api.js required.
    //
    // EXACTLY ONE window owns the stream at a time. Rendering to both was tried and
    // reverted: each window runs an independent WebCola layout at its own canvas size, so
    // the same graph settles into visibly different positions in each, and the two
    // pictures never agree.
    //
    // Popping out MOVES the output: while the popup is open it owns the stream, whichever
    // window's Play was pressed, and the docked panel shows a placeholder. popOut() and
    // popIn() carry the current graph across with snapshotGraph()/restoreGraph(), so
    // neither window ever opens blank or is left showing a stale picture.
    //
    // A popup that is unloading is flagged __pynodeClosing: it is still reachable (and
    // `closed` is still false) during its pagehide, but must no longer be drawn to.

    function outputPopupWin() {
        try {
            if (typeof pynode_output !== "undefined" && pynode_output &&
                !pynode_output.closed && pynode_output !== window && !pynode_output.__pynodeClosing) {
                return pynode_output;
            }
        } catch (e) {}
        return null;
    }

    function targets() {
        var list = [window];
        var p = outputPopupWin();
        if (p) list.push(p);
        return list;
    }

    function activeTarget() {
        var p = outputPopupWin();
        return (p && p.__pynodeAdopted) ? p : window;
    }

    // Everything needed to rebuild the picture: the same keys pynode_graphlib's
    // Node._data() / Edge._data() send, plus the current layout positions. A traversed
    // edge's colour lives only in the DOM, so graph_api.js records it as keptStroke.
    var NODE_KEYS = ["id", "label", "labelStyle", "topRightLabel", "topLeftLabel",
        "topRightLabelStyle", "topLeftLabelStyle", "r", "color", "fixed", "static",
        "ax", "ay", "rx", "ry", "relativePosition", "x", "y"];
    var EDGE_KEYS = ["id", "weight", "directed", "lineWidth", "weightStyle", "stroke"];

    function pick(obj, keys) {
        var out = {};
        keys.forEach(function (k) { if (obj[k] !== undefined) out[k] = obj[k]; });
        return out;
    }

    function endId(v) { return (v !== null && typeof v === "object") ? v.id : v; }

    function snapshotGraph(src) {
        var snap = { size: [500, 400], nodes: [], edges: [] };
        try {
            var g = src.greuler_instance;
            if (!g || !g.graph) return snap;
            snap.size = src.layoutSize();
            snap.nodes = src.getGraphNodes().map(function (n) { return pick(n, NODE_KEYS); });
            snap.edges = g.graph.edges.map(function (e) {
                var d = pick(e, EDGE_KEYS);
                d.source = endId(e.source);
                d.target = endId(e.target);
                if (e.keptStroke) { d.stroke = e.keptStroke; d.keptStroke = e.keptStroke; }
                return d;
            });
        } catch (e) { console.error("PyNode: could not snapshot the graph", e); }
        return snap;
    }

    function restoreGraph(dst, snap) {
        try {
            dst.js_clear();
            if (!snap.nodes.length) return;
            var items = snap.nodes.map(function (n) { return [0, n]; })
                .concat(snap.edges.map(function (e) { return [1, e]; }));
            dst.js_add_all(items);
            // js_add_node spirals new nodes out from the centre; put them back where they
            // were instead, scaled to this canvas, and let the layout settle from there.
            var size = dst.layoutSize();
            var sx = size[0] / (snap.size[0] || 500), sy = size[1] / (snap.size[1] || 400);
            snap.nodes.forEach(function (n) {
                if (n.static || typeof n.x !== "number") return;
                var live = dst.greuler_instance.graph.getNode({ id: n.id });
                if (live) { live.x = n.x * sx; live.y = n.y * sy; }
            });
            dst.updateLayout();
            // Positions set here do not survive: the layout keeps moving the nodes and
            // nothing pulls the graph back to the middle, so a popped-out graph settled
            // in a corner. Re-centre once the layout has settled, and again in case it
            // was still drifting (a run may be adding nodes at the same time).
            [150, 600, 1500].forEach(function (ms) {
                setTimeout(function () { recentreGraph(dst); }, ms);
            });
        } catch (e) { console.error("PyNode: could not restore the graph", e); }
    }

    // Move the free (non-static) nodes so the graph's bounding box sits in the middle of
    // the canvas, shrinking it to fit if it is too big. Static nodes stay put: their
    // position is the program's. Same mechanism as fixLayout() in js/resize.js - write
    // x/y, then update() - which the layout honours.
    function recentreGraph(w) {
        try {
            if (!w || w.closed || w.__pynodeClosing) return;
            var nodes = w.getGraphNodes().filter(function (n) {
                return !n.static && typeof n.x === "number" && typeof n.y === "number";
            });
            if (!nodes.length) return;
            var size = w.layoutSize(), W = size[0], H = size[1], MARGIN = 20;
            var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            nodes.forEach(function (n) {
                var r = n.r || 12;
                minX = Math.min(minX, n.x - r); maxX = Math.max(maxX, n.x + r);
                minY = Math.min(minY, n.y - r); maxY = Math.max(maxY, n.y + r);
            });
            var k = Math.min(1, (W - 2 * MARGIN) / Math.max(maxX - minX, 1),
                                (H - 2 * MARGIN) / Math.max(maxY - minY, 1));
            var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
            if (k === 1 && Math.abs(cx - W / 2) < 2 && Math.abs(cy - H / 2) < 2) return;
            nodes.forEach(function (n) {
                n.x = W / 2 + (n.x - cx) * k;
                n.y = H / 2 + (n.y - cy) * k;
                n.px = n.x; n.py = n.y;
            });
            w.greuler_instance.update();
        } catch (e) {}
    }

    function setPopped(on) {
        try { document.body.classList.toggle("output-popped", on); } catch (e) {}
    }

    function popOut(win) {
        try {
            if (!win || win.closed || win.__pynodeAdopted || win.__pynodeClosing) return;
            if (typeof win.js_clear !== "function") return;   // still loading
            win.__pynodeAdopted = true;
        } catch (e) { return; }
        restoreGraph(win, snapshotGraph(window));
        try { window.js_clear(); } catch (e) {}
        setPopped(true);
        bindAllButtons();
        registerClicks();
        setState(state);   // show() only runs on a change; a mid-run popup would read PLAY
    }

    function popIn(win) {
        try {
            if (!win || win.__pynodeClosing) return;
            win.__pynodeClosing = true;
            if (!win.__pynodeAdopted) return;
        } catch (e) { return; }
        restoreGraph(window, snapshotGraph(win));
        setPopped(false);
        registerClicks();
    }

    // The popup vanished without its pagehide reaching us (a crashed or force-closed
    // window). Its graph is gone with it; at least stop showing the placeholder.
    function checkPopupAlive() {
        if (document.body.classList.contains("output-popped") && !outputPopupWin()) {
            setPopped(false);
            registerClicks();
        }
    }

    // Bind one output window's run/stop/restart buttons, capturing that window as the
    // origin. Done from here rather than trusting each page's own inline handlers: HTML
    // pages carry no ?version=, so a returning browser can keep a stale pynode_output.html
    // indefinitely - and a stale copy calls play() with no origin, which silently routes
    // the run to the main page. This file IS versioned, so binding from here always wins.
    function bindButtons(t) {
        try {
            var handlers = {
                run: function () { onRunClick(t); },
                stop: function () { stop(); },
                restart: function () { restart(t); },
                stepOver: function () { stepCommand(DBG_OVER); },
                stepInto: function () { stepCommand(DBG_INTO); },
                stepOut: function () { stepCommand(DBG_OUT); },
                debugWindowButton: function () { if (typeof window.debugPopup === "function") window.debugPopup(900, 640); }
            };
            Object.keys(handlers).forEach(function (id) {
                var el = t.document.getElementById(id);
                if (el) el.onclick = handlers[id];
            });
        } catch (e) {}
    }

    function controlWindows() {
        var list = targets();
        var d = debugWindow();
        if (d) list.push(d);
        return list;
    }

    function bindAllButtons() { controlWindows().forEach(bindButtons); }

    function applyOne(t, name, args) {
        try {
            if (name === "print") { writeOutput(args[0], true); return; }
            // Synthetic commands, so end-of-run effects stay ordered behind the commands
            // still waiting for a frame - otherwise "Done" prints before the last output.
            // Handled by the host, not the render target: there is one console, one button
            // state machine and one pending input() field whichever window is drawing.
            if (name === "__state") { setState(args[0]); return; }
            if (name === "__input") { askInput(args[0]); return; }
            if (name === "__debug") { onDebug(args[0]); return; }
            if (name === "__trace") { onTrace(args[0]); return; }
            if (typeof t[name] === "function") t[name].apply(t, args);
        } catch (e) {
            console.error("PyNode: failed to apply", name, e);
        }
    }

    function applyFrame() {
        frameQueued = false;
        var t = activeTarget();
        var batches = pending;
        pending = [];
        for (var b = 0; b < batches.length; b++) {
            var evts = batches[b];
            for (var i = 0; i < evts.length; i++) applyOne(t, evts[i][0], evts[i][1]);
        }
    }

    function enqueue(events) {
        pending.push(events);
        if (!frameQueued) {
            frameQueued = true;
            requestAnimationFrame(applyFrame);
        }
    }

    // --- blocking input() ---------------------------------------------------
    // The worker is parked in Atomics.wait inside its stdin hook while this runs, so the
    // answer has to travel back through shared memory, not postMessage.

    // Mirrors pynode_core.format_string_HTML so the echoed answer lines up with the
    // prompt, which came through Python's stdout and had its spaces turned into &nbsp;.
    function escapeConsole(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                        .replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/ /g, "&nbsp;");
    }

    // Put the field where the user is actually looking.
    function consoleWindow() {
        try {
            if (typeof pynode_console !== "undefined" && pynode_console && !pynode_console.closed &&
                !pynode_console.__pynodeClosing) {
                return pynode_console;
            }
        } catch (e) {}
        return window;
    }

    function removeInput() {
        try {
            if (inputEl && inputEl.parentNode) inputEl.parentNode.removeChild(inputEl);
        } catch (e) {}
        inputEl = null;
    }

    function submitInput(value) {
        removeInput();
        // Only answer the request this field was created for. Without the sequence check a
        // stray Enter after a run ended could pre-load an answer that the NEXT run's first
        // input() would silently swallow.
        if (Atomics.load(ctrl, CTRL_IO_STATE) !== 1 || Atomics.load(ctrl, CTRL_IO_SEQ) !== pendingSeq) {
            return;
        }
        // Echo through writeOutput so BOTH transcripts end up reading "Enter a num: 42".
        writeOutput("<p style='display:inline;'>" + escapeConsole(value) + "<br></p>", true);
        // Both TextEncoder and TextDecoder refuse SharedArrayBuffer-backed views, so
        // marshal through a normal array and copy across. encodeInto is still worth using:
        // it never emits a partial UTF-8 sequence, unlike encode()-then-truncate.
        var tmp = new Uint8Array(IO_LEN);
        var written = new TextEncoder().encodeInto(String(value), tmp).written;
        io.set(tmp.subarray(0, written));
        Atomics.store(ctrl, CTRL_IO_LEN, written);
        Atomics.store(ctrl, CTRL_IO_STATE, 2);
        wake();
    }

    function askInput(seq) {
        removeInput();
        pendingSeq = seq;
        var w = consoleWindow();
        var el = null;
        try { el = w.document.getElementById("console"); } catch (e) {}
        if (!el) {
            // No console to ask in: EOF, rather than silently feeding an empty line.
            Atomics.store(ctrl, CTRL_IO_STATE, 3);
            wake();
            return;
        }

        var field = w.document.createElement("input");
        field.type = "text";
        field.className = "consoleInput";
        field.setAttribute("autocomplete", "off");
        field.setAttribute("spellcheck", "false");
        field.addEventListener("keydown", function (ev) {
            if (ev.key === "Enter") { ev.preventDefault(); submitInput(field.value); }
            else if (ev.key === "Escape") { ev.preventDefault(); removeInput(); stop(); }
        });

        el.appendChild(field);
        el.scrollTop = el.scrollHeight;
        inputEl = field;
        try { w.focus(); } catch (e) {}
        field.focus();
    }

    // A popped-out console starts with the transcript so far, and a pending input()
    // field moves with it - otherwise the prompt is left waiting in the docked console,
    // where the user is no longer looking. Both are idempotent.
    function consoleOpened(win) {
        try {
            if (!win || win.closed || win.__pynodeConsoleSeeded || win.__pynodeClosing) return;
            var dst = win.document.getElementById("console");
            var src = document.getElementById("console");
            if (!dst || !src) return;
            win.__pynodeConsoleSeeded = true;
            var copy = src.cloneNode(true);
            Array.prototype.forEach.call(copy.querySelectorAll(".consoleInput"), function (el) {
                el.parentNode.removeChild(el);
            });
            dst.innerHTML = copy.innerHTML;
            dst.scrollTop = dst.scrollHeight;
        } catch (e) { return; }
        reaskInput();
    }

    function consoleClosing(win) {
        try {
            if (!win || win.__pynodeClosing) return;
            win.__pynodeClosing = true;
            if (inputEl && inputEl.ownerDocument === win.document) reaskInput();
        } catch (e) {}
    }

    // Recreate a pending input() field in whichever console is now current, keeping
    // what the user had already typed.
    function reaskInput() {
        if (!inputEl) return;
        var typed = inputEl.value;
        askInput(pendingSeq);
        if (inputEl) inputEl.value = typed;
    }

    // --- control block ------------------------------------------------------
    function wake() {
        if (!ctrl) return;
        Atomics.add(ctrl, CTRL_NOTIFY, 1);
        Atomics.notify(ctrl, CTRL_NOTIFY);
    }

    function signalStop() {
        if (ctrl) { Atomics.store(ctrl, CTRL_STOP, 1); Atomics.store(ctrl, CTRL_PAUSE, 0); }
        if (interrupt) interrupt[0] = 2;     // SIGINT - breaks a loop that never pauses
        wake();
    }

    function pushClick(nodeId) {
        if (!ctrl) return;
        var w = Atomics.load(ctrl, CTRL_CLICK_W);
        Atomics.store(ctrl, CLICK_BASE + (w % CLICK_CAP), nodeId | 0);
        Atomics.store(ctrl, CTRL_CLICK_W, (w + 1) | 0);
        wake();
    }

    function pushPositions() {
        checkPopupAlive();
        if (!pos) return;
        var t = activeTarget();
        try {
            var g = t.greuler_instance;
            if (!g || !g.graph || !g.graph.nodes) return;
            pos[POS_W] = g.options.width || 500;
            pos[POS_H] = g.options.height || 400;
            var nodes = g.graph.nodes;
            for (var i = 0; i < nodes.length; i++) {
                var id = nodes[i].id;
                if (id < 0 || id >= POS_MAX) continue;
                var b = POS_BASE + id * 3;
                pos[b] = 1;
                pos[b + 1] = Math.round(nodes[i].x || 0);
                pos[b + 2] = Math.round(nodes[i].y || 0);
            }
        } catch (e) {}
    }

    // --- button state machine ----------------------------------------------
    function show(id) {
        controlWindows().forEach(function (t) {
            try {
                ["runPlay", "runPlayLoad", "runPause", "runResume"].forEach(function (k) {
                    var el = t.document.getElementById(k);
                    if (el) el.style.display = (k === id) ? "inherit" : "none";
                });
            } catch (e) {}
        });
    }

    function setState(s) {
        state = s;
        show(s === "idle" ? "runPlay" : s === "playing" ? "runPause"
           : s === "paused" ? "runResume" : "runPlayLoad");
        // For CSS only: the header's Stop is coloured red, and should not look live
        // when there is nothing to stop.
        controlWindows().forEach(function (t) {
            try { t.document.body.setAttribute("data-run-state", s); } catch (e) {}
        });
    }

    function onRunClick(origin) {
        if (!ready) return;
        if (state === "idle") play(origin);
        else if (state === "playing") pause();
        else if (state === "paused") resume();
    }

    // `origin` is accepted and ignored: while the output is popped out the popup draws
    // every run, wherever Play was pressed. Older popup pages still pass it.
    // `opts.stepInto` starts the run already stopped on its first line.
    function play(origin, opts) {
        if (!ready) return;
        try { saveCode(); } catch (e) {}
        removeInput();
        pending = [];
        trace = [];          // the trace log is per run, like the console
        var dw = debugWindow();
        if (dw) { try { dw.resetTrace([]); } catch (e) {} }
        writeOutput("", false);
        registerClicks();
        setState("playing");
        pushPositions();
        writeDebugSettings();
        worker.postMessage({ t: "run", src: getCode(), stepInto: !!(opts && opts.stepInto) });
    }

    // Pause is a debugger break: the program stops on the line it is running, with its
    // variables on show. The state flips now so the button responds at once; the worker's
    // "__debug" report then fills in where it stopped. SIGUSR1 reaches code that is not
    // reporting lines - a tight loop, or a pause() - see pynode_debug._on_signal.
    function pause() {
        if (!ctrl || !debuggable()) return;
        if (state !== "paused") stateBeforeBreak = state;
        Atomics.store(ctrl, CTRL_DBG_BREAK, 1);
        nudgeWorker();
        setState("paused");
    }

    function resume() { debugCommand(DBG_CONTINUE); }

    // --- debugger --------------------------------------------------------------
    var stateBeforeBreak = "playing";
    var snapshot = null;             // last "paused" report from pynode_debug, or null
    var trace = [];                  // execution trace entries since the run began
    var TRACE_MAX = 2000;
    var debugSettings = { breakpoints: [], watches: [], record: false };

    // Needs real shared memory: the worker blocks waiting for a step command.
    function debuggable() { return isolated && !!ctrl; }

    // Break a running loop out to check the debugger settings, without stopping it.
    function nudgeWorker() {
        if (interrupt && interrupt[0] === 0) interrupt[0] = SIGUSR1;
        wake();
    }

    function writeDebugSettings() {
        if (!debuggable() || !dbg) return;
        var tmp = new Uint8Array(DBG_LEN);
        var n = new TextEncoder().encodeInto(JSON.stringify(debugSettings), tmp).written;
        // TextEncoder refuses SharedArrayBuffer views; marshal through a plain array.
        dbg.set(tmp.subarray(0, n));
        Atomics.store(ctrl, CTRL_DBG_LEN, n);
        Atomics.add(ctrl, CTRL_DBG_VER, 1);
        if (state === "playing") nudgeWorker(); else wake();
    }

    function setBreakpoints(lines) {
        debugSettings.breakpoints = (lines || []).map(Number).filter(function (n) { return n > 0; });
        writeDebugSettings();
    }

    function setWatches(list) {
        debugSettings.watches = (list || []).map(String);
        writeDebugSettings();
        notifyDebugWindow();
    }

    function setRecord(on) {
        debugSettings.record = !!on;
        writeDebugSettings();
        notifyDebugWindow();
    }

    function debugCommand(cmd, arg) {
        if (!debuggable()) return;
        if (cmd === DBG_CONTINUE) Atomics.store(ctrl, CTRL_DBG_BREAK, 0);   // cancel a pending Pause
        Atomics.store(ctrl, CTRL_DBG_ARG, arg | 0);
        Atomics.store(ctrl, CTRL_DBG_CMD, cmd);
        wake();
    }

    function stepCommand(cmd) {
        if (!ready) return;
        // Step into from idle starts a run already stopped on its first line.
        if (state === "idle" && cmd === DBG_INTO) { play(window, { stepInto: true }); return; }
        if (state === "paused" && snapshot) debugCommand(cmd);
    }

    // A "paused" report replaces the snapshot, keeping the previous one (one level only)
    // so the variables view can highlight what changed. "running" and the end of the run
    // keep the last variables on show, greyed by the debug window.
    function onDebug(info) {
        if (!info) return;
        if (info.state === "paused") {
            var previous = snapshot;
            if (previous) delete previous.previous;
            info.previous = previous;
            snapshot = info;
            if (state !== "paused") stateBeforeBreak = state;
            setState("paused");
            var f = info.frames && info.frames[info.selected || 0];
            showDebugLine(f ? f.line : info.line);
        } else if (info.state === "running") {
            if (snapshot) snapshot.state = "running";
            showDebugLine(null);
            setState(stateBeforeBreak === "paused" ? "playing" : stateBeforeBreak);
        } else if (info.state === "ended") {
            endDebugSession(info.reason);
            return;
        }
        notifyDebugWindow();
    }

    // Nothing is live once a run is over - Python has discarded the frames and their
    // variables - so the stack, variables and watch values are cleared rather than left
    // on show. The trace log is kept until the next Play: it records what already ran.
    // `reason`: "stopped" when the user pressed Stop, otherwise the run finished.
    function endDebugSession(reason) {
        if (snapshot || reason) {
            snapshot = { state: "ended", reason: reason || "finished", frames: [], locals: [], globals: [], watches: [] };
        }
        showDebugLine(null);
        notifyDebugWindow();
    }

    function onTrace(entry) {
        if (!entry) return;
        trace.push(entry);
        if (trace.length > TRACE_MAX) trace.splice(0, trace.length - TRACE_MAX);
        var w = debugWindow();
        if (w) { try { w.appendTrace(entry); } catch (e) {} }
    }

    // The editor's current-line marker. Both editors share it over BroadcastChannel.
    function showDebugLine(line) {
        try { if (window.editor && window.editor.setDebugLine) window.editor.setDebugLine(line); } catch (e) {}
    }

    // --- debug window --------------------------------------------------------
    function debugWindow() {
        try {
            if (typeof pynode_debug !== "undefined" && pynode_debug && !pynode_debug.closed &&
                !pynode_debug.__pynodeClosing && typeof pynode_debug.renderDebug === "function") {
                return pynode_debug;
            }
        } catch (e) {}
        return null;
    }

    function debugView() {
        return {
            state: state,
            snapshot: snapshot,
            watches: debugSettings.watches.slice(),
            record: debugSettings.record,
            debuggable: debuggable()
        };
    }

    function notifyDebugWindow() {
        var w = debugWindow();
        if (w) { try { w.renderDebug(debugView()); } catch (e) {} }
    }

    function debugOpened(win) {
        try {
            if (!win || win.closed) return;
            bindButtons(win);
            win.renderDebug(debugView());
            win.resetTrace(trace.slice());
            setState(state);    // stamps data-run-state into the new window
        } catch (e) {}
    }

    function debugClosing(win) {
        try { if (win) win.__pynodeClosing = true; } catch (e) {}
    }

    function stop() {
        removeInput();
        signalStop();
        endDebugSession("stopped");
        if (!isolated) {
            // Without shared memory the worker cannot see the stop flag, so the only way
            // to interrupt it is to kill it and boot a fresh one.
            respawn();
            return;
        }
        worker.postMessage({ t: "reset" });
        setState("idle");
    }

    // The origin has to travel in a closure: setTimeout(play, ...) passes no arguments.
    function restart(origin) {
        stop();
        setTimeout(function () { play(origin); }, isolated ? 80 : 1200);
    }

    // Clicks follow ownership. registerClickListener assigns its parameter to a
    // window-local clickListener and clickNode guards with `!== undefined`, so a bare call
    // DISABLES the listener - which is what the inactive window needs. Leaving it live
    // there let a click on a stale graph feed a bogus node id to the running program.
    function registerClicks() {
        var active = activeTarget();
        targets().forEach(function (t) {
            try {
                if (typeof t.registerClickListener !== "function") return;
                if (t === active) t.registerClickListener(function (nodeId) { pushClick(nodeId); });
                else t.registerClickListener();
            } catch (e) {}
        });
    }

    // --- boot ---------------------------------------------------------------
    function allocate() {
        var Buf = isolated ? SharedArrayBuffer : ArrayBuffer;
        var ctrlBuf = new Buf(CTRL_LEN * 4);
        var posBuf = new Buf(POS_LEN * 8);
        var intBuf = new Buf(1);
        var ioBuf = new Buf(IO_LEN);
        var dbgBuf = new Buf(DBG_LEN);
        ctrl = new Int32Array(ctrlBuf);
        pos = new Float64Array(posBuf);
        interrupt = new Uint8Array(intBuf);
        io = new Uint8Array(ioBuf);
        dbg = new Uint8Array(dbgBuf);
        return { ctrl: ctrlBuf, pos: posBuf, interrupt: intBuf, io: ioBuf, dbg: dbgBuf };
    }

    function spawn() {
        worker = new Worker("js/pynode_worker.js?version=" + VERSION, { type: "module" });
        worker.onmessage = function (ev) {
            var m = ev.data || {};
            if (m.t === "boot-needed") {
                worker.postMessage({ t: "boot", buffers: allocate() });
            } else if (m.t === "ready") {
                ready = true;
                setState("idle");
                writeOutput("<p style='color:var(--c-ok);'>Ready (Python " + m.python + ")</p>", false);
                if (!isolated) {
                    writeOutput("<p style='color:var(--c-warn);'>Reduced-performance mode: " +
                        "cross-origin isolation unavailable.</p>", true);
                }
                writeDebugSettings();   // breakpoints restored from the editor before boot
                bindAllButtons();   // covers a popup opened before the worker finished booting
                registerClicks();
                if (positionsTimer === null) positionsTimer = setInterval(pushPositions, 100);
            } else if (m.t === "events") {
                enqueue(m.events);
            } else if (m.t === "done") {
                // In-band, like __state: the worker's last "__debug running" report may
                // still be waiting for a frame, and must not land after "ended".
                var tail = [["__debug", [{ state: "ended", reason: m.result === "stopped" ? "stopped" : "finished" }]]];
                if (m.result === "ok") {
                    tail.push(["print", ["<p style='display:inline;color:var(--c-ok);'>Done<br></p>"]]);
                } else if (m.result === "stopped") {
                    tail.push(["print", ["<p style='display:inline;color:var(--c-warn);'>Stopped<br></p>"]]);
                }
                tail.push(["__state", ["idle"]]);
                enqueue(tail);
            } else if (m.t === "stopped") {
                enqueue([["__debug", [{ state: "ended", reason: "stopped" }]]]);
                setState("idle");
            } else if (m.t === "error") {
                enqueue([
                    ["__debug", [{ state: "ended" }]],
                    ["print", ["<p style='display:inline;color:var(--c-err);'>" + m.message + "<br></p>"]],
                    ["__state", ["idle"]]
                ]);
            }
        };
        worker.onerror = function (e) {
            writeOutput("<p style='color:var(--c-err);'>Worker failed: " + (e.message || "(no message)") + "</p>", true);
            setState("idle");
        };
    }

    function respawn() {
        ready = false;
        setState("boot");
        try { worker.terminate(); } catch (e) {}
        pending = [];
        spawn();
    }

    function init() {
        setState("boot");
        writeOutput("<p>Loading Python...</p>", false);
        spawn();

        bindAllButtons();
    }

    return {
        init: init, play: play, stop: stop, restart: restart,
        pause: pause, resume: resume,
        isReady: function () { return ready; },
        state: function () { return state; },
        isIsolated: function () { return isolated; },
        // An output window appeared or went away. Older popup pages only ever call this,
        // so it also adopts an open popup that has not been popped out to yet.
        onRenderTargetChanged: function () {
            var p = outputPopupWin();
            if (p) popOut(p);
            bindAllButtons();
            registerClicks();
        },
        outputOpened: function (win) { popOut(win); },
        outputClosing: function (win) { popIn(win); },
        consoleOpened: consoleOpened,
        consoleClosing: consoleClosing,
        // Debugger
        stepInto: function () { stepCommand(DBG_INTO); },
        stepOver: function () { stepCommand(DBG_OVER); },
        stepOut: function () { stepCommand(DBG_OUT); },
        continueRun: function () { if (state === "paused") resume(); },
        inspectFrame: function (i) { if (state === "paused") debugCommand(DBG_INSPECT, i); },
        setBreakpoints: setBreakpoints,
        setWatches: setWatches,
        setRecord: setRecord,
        debugView: debugView,
        traceLog: function () { return trace.slice(); },
        clearTrace: function () { trace = []; var w = debugWindow(); if (w) { try { w.resetTrace([]); } catch (e) {} } },
        debugOpened: debugOpened,
        debugClosing: debugClosing
    };
})();
