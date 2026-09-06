// PyNode host - main-thread side of the Pyodide worker.
//
// Owns the single worker, applies its command stream to the renderer, routes console
// output, and drives the run/stop/pause/restart button state machine. That state machine
// used to live in pynode_core.py and manipulate the DOM through Brython; Pyodide runs in
// a worker with no DOM, so it has to live on this side.
//
// Pacing is no longer done here. The worker blocks for real on pause() and flushes a
// batch of commands just before each sleep, so batches are applied as they arrive.

var PyNodeHost = (function () {
    "use strict";

    var VERSION = "0.9.11";

    // --- SAB layout. Must match js/pynode_worker.js exactly. ---
    var CTRL_NOTIFY = 0, CTRL_STOP = 1, CTRL_PAUSE = 2, CTRL_CLICK_W = 3, CTRL_CLICK_R = 4;
    var CTRL_IO_STATE = 5, CTRL_IO_LEN = 6;   // 0 idle | 1 pending | 2 ready | 3 cancelled
    var CTRL_IO_SEQ = 7;                      // request id, guards against stale answers
    var CLICK_BASE = 8, CLICK_CAP = 64, CTRL_LEN = CLICK_BASE + CLICK_CAP;
    var POS_W = 0, POS_H = 1, POS_BASE = 4, POS_MAX = 1024, POS_LEN = POS_BASE + POS_MAX * 3;
    var IO_LEN = 8192;                        // UTF-8 answer from input()

    var worker = null;
    var ready = false;
    var isolated = (typeof SharedArrayBuffer === "function") && (self.crossOriginIsolated === true);
    var state = "boot";              // boot | idle | playing | paused
    var ctrl = null, pos = null, interrupt = null, io = null;
    var inputEl = null;              // the live <input> while input() is pending
    var pendingSeq = -1;             // which input() request that field belongs to
    var pending = [];                // command batches awaiting a frame
    var frameQueued = false;
    var positionsTimer = null;

    // --- render target ------------------------------------------------------
    // The detached output popup owns its own greuler_instance. Every function in
    // graph_api.js closes over its own window's global, so calling it on the popup
    // mutates the popup's graph. No changes to graph_api.js required.
    function target() {
        try {
            if (typeof pynode_output !== "undefined" && pynode_output && !pynode_output.closed) {
                return pynode_output;
            }
        } catch (e) {}
        return window;
    }

    function applyOne(t, name, args) {
        try {
            if (name === "print") { writeOutput(args[0], true); return; }
            // Synthetic commands, so end-of-run effects stay ordered behind the commands
            // still waiting for a frame - otherwise "Done" prints before the last output.
            if (name === "__state") { setState(args[0]); return; }
            if (name === "__input") { askInput(args[0]); return; }
            if (typeof t[name] === "function") t[name].apply(t, args);
        } catch (e) {
            console.error("PyNode: failed to apply", name, e);
        }
    }

    function applyFrame() {
        frameQueued = false;
        var t = target();
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
            if (typeof pynode_console !== "undefined" && pynode_console && !pynode_console.closed) {
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
        if (!pos) return;
        var t = target();
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
        ["runPlay", "runPlayLoad", "runPause", "runResume"].forEach(function (k) {
            var el = document.getElementById(k);
            if (el) el.style.display = (k === id) ? "inherit" : "none";
        });
        var t = target();
        if (t !== window) {
            try {
                ["runPlay", "runPlayLoad", "runPause", "runResume"].forEach(function (k) {
                    var el = t.document.getElementById(k);
                    if (el) el.style.display = (k === id) ? "inherit" : "none";
                });
            } catch (e) {}
        }
    }

    function setState(s) {
        state = s;
        show(s === "idle" ? "runPlay" : s === "playing" ? "runPause"
           : s === "paused" ? "runResume" : "runPlayLoad");
    }

    function onRunClick() {
        if (!ready) return;
        if (state === "idle") play();
        else if (state === "playing") pause();
        else if (state === "paused") resume();
    }

    function play() {
        if (!ready) return;
        try { saveCode(); } catch (e) {}
        removeInput();
        pending = [];
        writeOutput("", false);
        setState("playing");
        pushPositions();
        worker.postMessage({ t: "run", src: getCode() });
    }

    function pause() {
        if (!ctrl) return;
        Atomics.store(ctrl, CTRL_PAUSE, 1);
        setState("paused");
    }

    function resume() {
        if (!ctrl) return;
        Atomics.store(ctrl, CTRL_PAUSE, 0);
        setState("playing");
        wake();
    }

    function stop() {
        removeInput();
        signalStop();
        if (!isolated) {
            // Without shared memory the worker cannot see the stop flag, so the only way
            // to interrupt it is to kill it and boot a fresh one.
            respawn();
            return;
        }
        worker.postMessage({ t: "reset" });
        setState("idle");
    }

    function restart() { stop(); setTimeout(play, isolated ? 80 : 1200); }

    function registerClicks() {
        var t = target();
        try {
            if (typeof t.registerClickListener === "function") {
                t.registerClickListener(function (nodeId) { pushClick(nodeId); });
            }
        } catch (e) {}
    }

    // --- boot ---------------------------------------------------------------
    function allocate() {
        var Buf = isolated ? SharedArrayBuffer : ArrayBuffer;
        var ctrlBuf = new Buf(CTRL_LEN * 4);
        var posBuf = new Buf(POS_LEN * 8);
        var intBuf = new Buf(1);
        var ioBuf = new Buf(IO_LEN);
        ctrl = new Int32Array(ctrlBuf);
        pos = new Float64Array(posBuf);
        interrupt = new Uint8Array(intBuf);
        io = new Uint8Array(ioBuf);
        return { ctrl: ctrlBuf, pos: posBuf, interrupt: intBuf, io: ioBuf };
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
                registerClicks();
                if (positionsTimer === null) positionsTimer = setInterval(pushPositions, 100);
            } else if (m.t === "events") {
                enqueue(m.events);
            } else if (m.t === "done") {
                var tail = [];
                if (m.result === "ok") {
                    tail.push(["print", ["<p style='display:inline;color:var(--c-ok);'>Done<br></p>"]]);
                } else if (m.result === "stopped") {
                    tail.push(["print", ["<p style='display:inline;color:var(--c-warn);'>Stopped<br></p>"]]);
                }
                tail.push(["__state", ["idle"]]);
                enqueue(tail);
            } else if (m.t === "stopped") {
                setState("idle");
            } else if (m.t === "error") {
                enqueue([
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

        ["run", "stop", "restart"].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            el.onclick = (id === "run") ? onRunClick : (id === "stop" ? stop : restart);
        });
    }

    return {
        init: init, play: play, stop: stop, restart: restart,
        pause: pause, resume: resume,
        isReady: function () { return ready; },
        state: function () { return state; },
        isIsolated: function () { return isolated; },
        onRenderTargetChanged: function () { registerClicks(); }
    };
})();
