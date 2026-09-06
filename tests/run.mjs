// Entry point. Each test file starts its own server and browser (see startHarness in
// helpers.mjs), so this only has to run the suite serially with sane timeouts.
//
// Concurrency is pinned to 1 on purpose. `node --test` spawns one child process per test
// file and defaults to CPU-count parallelism; eight concurrent Chrome instances each
// booting Pyodide would thrash and produce timeouts that look like real failures.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

const args = [
    '--test',
    '--test-concurrency=1',
    '--test-timeout=300000',
    '--test-reporter=spec',
    // Anything extra is passed through, e.g.
    //   npm test -- --test-name-pattern=theme
    //   npm test -- ./io.test.mjs
    ...process.argv.slice(2),
];

const child = spawn(process.execPath, args, {
    cwd: here,
    stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (err) => { console.error(err); process.exit(1); });
