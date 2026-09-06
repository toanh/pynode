// Minimal static server for the test suite.
//
// Exists instead of `python -m http.server` for one reason that matters: Python serves
// .mjs as text/plain, browsers reject that for module scripts, and the resulting failure
// surfaces as a module-worker error event with an EMPTY message and filename. That is
// close to undebuggable if you do not already know the cause. Here the MIME types are
// correct by construction, and `npm test` needs no Python at all.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.py': 'text/plain; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.ttf': 'font/ttf',
    '.zip': 'application/zip',
};

/**
 * @param {object} [opts]
 * @param {'headers'|'none'} [opts.coi] How cross-origin isolation is obtained.
 *
 *   'headers' (default) - the server sends COOP/COEP itself, so the page is isolated on
 *      its FIRST paint. coi-serviceworker.js then hits its early return and never
 *      registers, which removes the once-per-context reload. That reload is the single
 *      largest source of nondeterminism and per-test cost in this suite.
 *      The policy must be `credentialless`, not `require-corp`, so that it matches what
 *      the shim actually synthesizes on Chrome (coepCredentialless defaults to true) -
 *      the tests should run under the same policy production does.
 *
 *   'none' - send nothing, exactly like GitHub Pages. The service worker registers, the
 *      page reloads once, and isolation lands on the second load. isolation.test.mjs uses
 *      this to exercise the real production path, which the default mode bypasses.
 */
export function startServer({ coi = 'headers', port = 0 } = {}) {
    const server = createServer(async (req, res) => {
        try {
            let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
            if (path.endsWith('/')) path += 'index.html';

            const full = normalize(join(ROOT, path));
            if (!full.startsWith(ROOT + sep) && full !== ROOT) {
                res.writeHead(403).end('Forbidden');
                return;
            }

            const info = await stat(full).catch(() => null);
            if (!info || !info.isFile()) {
                res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + path);
                return;
            }

            const headers = {
                'Content-Type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
                'Content-Length': info.size,
                'Cache-Control': 'no-cache',
            };
            if (coi === 'headers') {
                headers['Cross-Origin-Opener-Policy'] = 'same-origin';
                headers['Cross-Origin-Embedder-Policy'] = 'credentialless';
            }

            res.writeHead(200, headers);
            createReadStream(full).pipe(res);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(err));
        }
    });

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.unref();
            resolve({
                origin: `http://127.0.0.1:${server.address().port}`,
                close: async () => {
                    // Mandatory. Chrome holds keep-alive sockets open, and a bare
                    // server.close() waits on them forever - the suite then passes and
                    // simply never exits, which is the most confusing failure mode there
                    // is. closeAllConnections() is what makes teardown terminate.
                    server.closeAllConnections();
                    await new Promise((done) => server.close(done));
                },
            });
        });
    });
}
