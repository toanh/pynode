// Monaco bootstrap shared by index.html and pynode_editor.html.
// Replaces the Ace blocks that were previously duplicated verbatim in both pages.
//
// Exposes the same globals the rest of PyNode already depends on, so nothing else
// has to change:
//   editor         - facade with getValue/setValue/on, because pynode_editor.html and
//                    pynode_output.html reach across windows via window.opener.editor
//   editor_exists  - the ?gist= / ?project= head scripts poll this on a 100ms interval
//   enable_editor  - reentrancy guard for cross-window sync
//   getCode / setCode / saveCode / loadCode / openCode

var PyNodeEditor = (function () {
    "use strict";

    var VS_PATH = "js/monaco/vs";
    var CHANNEL = "pynode-code";

    var mon = null;              // the real monaco.editor instance
    var channel = null;
    var applyingRemote = false;  // guard: don't echo an edit we just received

    function create(opts) {
        opts = opts || {};
        var containerId = opts.container || "editor";
        var onReady = opts.onReady || function () {};

        require.config({ paths: { vs: VS_PATH } });

        require(["vs/editor/editor.main"], function () {
            mon = monaco.editor.create(document.getElementById(containerId), {
                value: opts.value || "",
                language: "python",
                theme: "vs",              // Ace set no theme, so its light default applied
                fontSize: 15,             // Ace used 11pt
                automaticLayout: true,    // replaces the resize.js width hack + editor_resize() stub
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                tabSize: 4,
                insertSpaces: true
            });

            // Backwards-compatible facade. Keeps window.opener.editor.getValue() working
            // from pynode_editor.html and pynode_output.html.
            window.editor = {
                getValue: function () { return mon.getValue(); },
                setValue: function (src) {
                    mon.setValue(src == null ? "" : String(src));
                    mon.setPosition({ lineNumber: 1, column: 1 });
                },
                on: function (evt, fn) {
                    if (evt === "change") return mon.onDidChangeModelContent(fn);
                },
                focus: function () { mon.focus(); },
                monaco: mon
            };

            if (typeof registerPynodeCompletions === "function") {
                try { registerPynodeCompletions(monaco); } catch (e) { console.error(e); }
            }

            initSync();

            window.editor_exists = true;
            var box = document.getElementById("editorBox");
            if (box) box.style.visibility = "visible";

            onReady(window.editor);
        });
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
