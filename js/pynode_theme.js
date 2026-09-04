// Light / dark theme for PyNode.
//
// The colour values live in css/style.css as custom properties; this file only decides
// WHICH set applies, persists the choice, keeps the four documents in step, and injects
// the toggle button.
//
// Resolution order:
//   1. data-theme="dark"|"light" on <html>  - an explicit choice by the user
//   2. otherwise prefers-color-scheme       - resolved natively by CSS, no JS involved
//
// The attribute is only ever written once the user has chosen. While it is absent the
// page keeps following the OS live, and the small inline script in each page's <head>
// (which runs before the stylesheet) is what prevents a flash of the wrong theme.

var PyNodeTheme = (function () {
    "use strict";

    var KEY = "pynode-theme";
    var CHANNEL = "pynode-theme";
    var channel = null;

    var SVG =
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
          '<g class="iconSun">' +
            '<circle cx="12" cy="12" r="4.5"/>' +
            '<g stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
              '<line x1="12" y1="1.5" x2="12" y2="4"/>' +
              '<line x1="12" y1="20" x2="12" y2="22.5"/>' +
              '<line x1="1.5" y1="12" x2="4" y2="12"/>' +
              '<line x1="20" y1="12" x2="22.5" y2="12"/>' +
              '<line x1="4.4" y1="4.4" x2="6.2" y2="6.2"/>' +
              '<line x1="17.8" y1="17.8" x2="19.6" y2="19.6"/>' +
              '<line x1="19.6" y1="4.4" x2="17.8" y2="6.2"/>' +
              '<line x1="6.2" y1="17.8" x2="4.4" y2="19.6"/>' +
            '</g>' +
          '</g>' +
          '<path class="iconMoon" d="M21 13.2A9 9 0 1 1 10.8 3a7.2 7.2 0 0 0 10.2 10.2z"/>' +
        '</svg>';

    function resolved() {
        var t = document.documentElement.getAttribute("data-theme");
        if (t === "dark" || t === "light") return t;
        try {
            return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        } catch (e) { return "light"; }
    }

    // Monaco is the one piece that cannot read CSS custom properties.
    function applyMonaco(theme) {
        try {
            if (window.monaco && monaco.editor) {
                monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs");
            }
        } catch (e) {}
    }

    function apply(theme) {
        document.documentElement.setAttribute("data-theme", theme);
        applyMonaco(theme);
    }

    function set(theme, broadcast) {
        apply(theme);
        try { localStorage.setItem(KEY, theme); } catch (e) {}
        if (broadcast !== false && channel) {
            try { channel.postMessage({ theme: theme }); } catch (e) {}
        }
    }

    function toggle() {
        set(resolved() === "dark" ? "light" : "dark");
    }

    // The .appSectionTitle bar is the only header structure all four documents share.
    // Its children are float:right, so appending puts the toggle leftmost in the strip.
    function injectToggle() {
        if (document.querySelector(".themeToggle")) return;
        var host = document.querySelector(".appSectionTitle .appSectionEnlarge") ||
                   document.querySelector(".appSectionTitle");
        if (!host) return;

        var el = document.createElement("div");
        el.className = "themeToggle";
        el.title = "Toggle light / dark theme";
        el.setAttribute("role", "button");
        el.setAttribute("tabindex", "0");
        el.innerHTML = SVG;
        el.addEventListener("click", function () { toggle(); });
        el.addEventListener("keydown", function (ev) {
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); }
        });
        host.appendChild(el);
    }

    function init() {
        // Same house pattern as monaco_setup.js's "pynode-code" channel. Works for popups
        // opened directly, which have no window.opener.
        try {
            channel = new BroadcastChannel(CHANNEL);
            channel.onmessage = function (ev) {
                // Apply without re-broadcasting, or the windows ping-pong forever.
                if (ev.data && (ev.data.theme === "dark" || ev.data.theme === "light")) {
                    apply(ev.data.theme);
                }
            };
        } catch (e) {}

        // With no explicit choice the CSS re-resolves on its own when the OS flips;
        // only Monaco needs to be told.
        try {
            window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
                if (!document.documentElement.getAttribute("data-theme")) applyMonaco(resolved());
            });
        } catch (e) {}

        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", injectToggle);
        } else {
            injectToggle();
        }
    }

    return {
        init: init,
        toggle: toggle,
        set: set,
        resolved: resolved,
        applyMonaco: applyMonaco
    };
})();

PyNodeTheme.init();
