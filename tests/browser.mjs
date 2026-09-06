// Finds a Chromium-based browser already installed on this machine.
//
// playwright-core ships no browsers of its own, which is deliberate here: the suite stays
// a small dependency and uses the Chrome you already have. Edge is an accepted fallback -
// it is Chromium, and supports SharedArrayBuffer, module workers and service workers just
// as well, which is all the suite needs.

import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const CANDIDATES = {
    win32: [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ],
    darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
    ],
};

export function findBrowser() {
    if (process.env.CHROME_PATH) {
        if (!existsSync(process.env.CHROME_PATH)) {
            throw new Error(`CHROME_PATH is set but does not exist: ${process.env.CHROME_PATH}`);
        }
        return process.env.CHROME_PATH;
    }
    for (const path of CANDIDATES[process.platform] || []) {
        if (path && existsSync(path)) return path;
    }
    throw new Error(
        'No Chrome/Chromium/Edge found. Install one, or set CHROME_PATH to its executable, e.g.\n' +
        '  CHROME_PATH="/path/to/chrome" npm test'
    );
}

export async function launch() {
    return chromium.launch({
        executablePath: findBrowser(),
        headless: true,
        // The suite opens the detached editor/console/output windows.
        args: ['--disable-popup-blocking'],
    });
}
