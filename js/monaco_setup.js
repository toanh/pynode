// Monaco bootstrap shared by index.html and pynode_editor.html.
// Replaces the Ace blocks that were previously duplicated verbatim in both pages.
//
// Exposes the same globals the rest of PyNode already depends on, so nothing else
// has to change:
//   editor         - facade with getValue/setValue/on, because pynode_editor.html and
//                    pynode_output.html reach across windows via window.opener.editor
//   editor_exists  - readiness flag; the ?project= head script and the beforeunload
//                    save check it, since both can run before Monaco exists
//   enable_editor  - reentrancy guard for cross-window sync
//   getCode / setCode / saveCode / loadCode / openCode

var PyNodeEditor = (function () {
    "use strict";

    var VS_PATH = "js/monaco/vs";
    var CHANNEL = "pynode-code";

    var mon = null;              // the real monaco.editor instance
    var channel = null;
    var applyingRemote = false;  // guard: don't echo an edit we just received
    var BP_KEY = "breakpoints";  // localStorage
    var bpDecos = null;          // breakpoint glyphs; Monaco moves them as lines are edited
    var lineDecos = null;        // the debugger's current-line marker
    var lastBps = "[]";
    var holdBps = false;         // during setValue: decorations vanish and come back

    function create(opts) {
        opts = opts || {};
        var containerId = opts.container || "editor";
        var onReady = opts.onReady || function () {};

        require.config({ paths: { vs: VS_PATH } });

        require(["vs/editor/editor.main"], function () {
            mon = monaco.editor.create(document.getElementById(containerId), {
                value: opts.value || "",
                language: "python",
                // Monaco cannot read CSS custom properties, so it is told the theme
                // explicitly here and again by PyNodeTheme whenever it changes.
                theme: (window.PyNodeTheme && PyNodeTheme.resolved() === "dark") ? "vs-dark" : "vs",
                fontSize: 15,             // Ace used 11pt
                automaticLayout: true,    // replaces the resize.js width hack + editor_resize() stub
                minimap: { enabled: false },
                glyphMargin: true,        // breakpoints: click the margin, or F9
                scrollBeyondLastLine: false,
                tabSize: 4,
                insertSpaces: true
            });

            // Backwards-compatible facade. Keeps window.opener.editor.getValue() working
            // from pynode_editor.html and pynode_output.html.
            window.editor = {
                getValue: function () { return mon.getValue(); },
                // Breakpoints survive: a full setValue would otherwise drop them, and this is
                // also how the saved code is restored at startup.
                setValue: function (src) {
                    var keep = breakpoints();
                    // setValue drops every decoration, and the content-change listener
                    // would report "no breakpoints" to the host before they are put back.
                    holdBps = true;
                    try { mon.setValue(src == null ? "" : String(src)); }
                    finally { holdBps = false; }
                    mon.setPosition({ lineNumber: 1, column: 1 });
                    setBreakpoints(keep);
                },
                // Like setValue, but as ONE undoable edit: setValue throws the undo stack
                // away, so opening a file or an example could not be undone. The undo stops
                // either side keep it from merging with typing before or after.
                // A different program: its breakpoints go with the old code.
                replaceValue: function (src) {
                    setBreakpoints([]);
                    var model = mon.getModel();
                    mon.pushUndoStop();
                    mon.executeEdits("pynode-replace", [{
                        range: model.getFullModelRange(),
                        text: src == null ? "" : String(src),
                        forceMoveMarkers: true
                    }]);
                    mon.pushUndoStop();
                    mon.setPosition({ lineNumber: 1, column: 1 });
                    mon.revealLine(1);
                },
                on: function (evt, fn) {
                    if (evt === "change") return mon.onDidChangeModelContent(fn);
                },
                focus: function () { mon.focus(); },
                getBreakpoints: function () { return breakpoints(); },
                setBreakpoints: function (lines) { setBreakpoints(lines); },
                toggleBreakpoint: toggleBreakpoint,
                setDebugLine: function (line) { setDebugLine(line, true); },
                monaco: mon
            };

            initDebugging();

            if (typeof registerPynodeCompletions === "function") {
                try { registerPynodeCompletions(monaco); } catch (e) { console.error(e); }
            }

            initSync();

            window.editor_exists = true;
            var box = document.getElementById("editorBox");
            if (box) box.style.visibility = "visible";

            onReady(window.editor);
            restoreBreakpoints();
        });
    }

    // --- debugging ---------------------------------------------------------------
    // Breakpoints are decorations, so Monaco moves them as lines are inserted or deleted
    // above them. Whenever their line numbers change they are saved, sent to the other
    // editor over the sync channel, and handed to PyNodeHost (this window's, or the
    // opener's for the editor popup), which passes them to the worker.

    function host() {
        if (window.PyNodeHost) return window.PyNodeHost;
        try { if (window.opener && window.opener.PyNodeHost) return window.opener.PyNodeHost; } catch (e) {}
        return null;
    }

    function breakpoints() {
        if (!bpDecos) return [];
        var seen = {};
        bpDecos.getRanges().forEach(function (r) { seen[r.startLineNumber] = true; });
        return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
    }

    // `remote`: the change came from the other editor, which already saved it and told
    // the host - just mirror it.
    function setBreakpoints(lines, remote) {
        if (!bpDecos) return;
        var max = mon.getModel().getLineCount();
        bpDecos.set((lines || []).filter(function (n) { return n >= 1 && n <= max; }).map(function (n) {
            return {
                range: new monaco.Range(n, 1, n, 1),
                options: {
                    isWholeLine: true,
                    glyphMarginClassName: "pynodeBreakpoint",
                    glyphMarginHoverMessage: { value: "Breakpoint - click or press F9 to remove" },
                    stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
                }
            };
        }));
        breakpointsChanged(remote);
    }

    function toggleBreakpoint(line) {
        var lines = breakpoints();
        var i = lines.indexOf(line);
        if (i >= 0) lines.splice(i, 1); else lines.push(line);
        setBreakpoints(lines);
    }

    function breakpointsChanged(remote) {
        if (holdBps) return;
        var lines = breakpoints();
        var key = JSON.stringify(lines);
        if (key === lastBps) return;
        lastBps = key;
        if (remote) return;
        try { localStorage.setItem(BP_KEY, key); } catch (e) {}
        if (channel) channel.postMessage({ type: "breakpoints", lines: lines });
        var h = host();
        if (h && h.setBreakpoints) h.setBreakpoints(lines);
    }

    // The arrow and highlight on the line the debugger is stopped at. `broadcast` sends
    // it to the other editor too; the copy that arrives over the channel does not.
    function setDebugLine(line, broadcast) {
        if (!lineDecos) return;
        if (line) {
            lineDecos.set([{
                range: new monaco.Range(line, 1, line, 1),
                options: { isWholeLine: true, className: "pynodeDebugLine", glyphMarginClassName: "pynodeDebugArrow" }
            }]);
            mon.revealLineInCenterIfOutsideViewport(line);
        } else {
            lineDecos.set([]);
        }
        if (broadcast && channel) channel.postMessage({ type: "debugLine", line: line || null });
    }

    function debugKey(fn) {
        return function () {
            var h = host();
            if (h && h[fn]) h[fn]();
        };
    }

    function initDebugging() {
        bpDecos = mon.createDecorationsCollection([]);
        lineDecos = mon.createDecorationsCollection([]);

        mon.onMouseDown(function (e) {
            if (e.target && e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
                toggleBreakpoint(e.target.position.lineNumber);
            }
        });
        // Editing moves decorations; report the new line numbers.
        mon.onDidChangeModelContent(function () { breakpointsChanged(applyingRemote); });

        mon.addCommand(monaco.KeyCode.F9, function () { toggleBreakpoint(mon.getPosition().lineNumber); });
        mon.addCommand(monaco.KeyCode.F10, debugKey("stepOver"));
        mon.addCommand(monaco.KeyCode.F11, debugKey("stepInto"));
        mon.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F11, debugKey("stepOut"));
        mon.addCommand(monaco.KeyCode.F8, debugKey("continueRun"));
    }

    // After onReady, once the page has put the saved code in: restoring into the empty
    // startup model would drop every breakpoint below line 1. Not "remote" - the host
    // needs to hear about them too.
    function restoreBreakpoints() {
        var saved = [];
        try { saved = JSON.parse(localStorage.getItem(BP_KEY) || "[]"); } catch (e) {}
        lastBps = "[]";
        setBreakpoints(saved);
    }

    // Cross-window sync.
    //
    // The Ace version ran two independent editors that echoed full-document setValue at
    // each other on every keystroke, which destroyed cursor position and undo history in
    // whichever window was not focused. This sends the actual edit deltas instead, and
    // uses BroadcastChannel rather than window.opener - so the editor popup no longer
    // depends on the opener relationship at all.
    function initSync() {
        if (typeof BroadcastChannel === "undefined") return;
        channel = new BroadcastChannel(CHANNEL);

        channel.onmessage = function (ev) {
            var msg = ev.data;
            if (msg && mon && msg.type === "breakpoints") { setBreakpoints(msg.lines, true); return; }
            if (msg && mon && msg.type === "debugLine") { setDebugLine(msg.line, false); return; }
            if (!msg || msg.type !== "edit" || !mon) return;
            var model = mon.getModel();
            if (!model) return;
            applyingRemote = true;
            try {
                model.applyEdits(msg.changes.map(function (c) {
                    return { range: c.range, text: c.text, forceMoveMarkers: true };
                }));
            } catch (e) {
                // Ranges can go stale if the two documents diverged; fall back to a
                // full replace rather than leaving the windows out of sync.
                if (typeof msg.full === "string" && msg.full !== model.getValue()) {
                    model.setValue(msg.full);
                }
            } finally {
                applyingRemote = false;
            }
        };

        mon.onDidChangeModelContent(function (e) {
            if (applyingRemote) return;
            channel.postMessage({
                type: "edit",
                changes: e.changes.map(function (c) {
                    return { range: c.range, text: c.text };
                }),
                full: mon.getValue()
            });
        });
    }

    return { create: create, instance: function () { return mon; } };
})();
