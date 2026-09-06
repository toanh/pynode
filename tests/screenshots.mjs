// Utility, not a test: capture the app in both themes.
//
// Automated colour assertions cannot tell you whether something *looks* right. This is
// how unthemed native widgets - form controls still rendering light on a dark page - were
// caught, which no assertion in theme.test.mjs would have found.
//
//   npm run screenshots      -> tests/screenshots/*.png

import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startHarness, openApp } from './helpers.mjs';

const OUT = join(fileURLToPath(new URL('.', import.meta.url)), 'screenshots');

const DEMO = [
    'a = Node(1)', 'b = Node(2)', 'c = Node(3)',
    'graph.add_node(a)', 'graph.add_node(b)', 'graph.add_node(c)',
    'graph.add_edge(Edge(a, b))', 'graph.add_edge(Edge(b, c))',
    'print("theme screenshot")',
].join('\n');

await mkdir(OUT, { recursive: true });
const harness = await startHarness();

try {
    const { context, page } = await openApp(harness);
    await page.setViewportSize({ width: 1400, height: 1000 });

    await page.evaluate((s) => window.editor.setValue(s), DEMO);
    await page.click('#run');
    await page.waitForFunction(() => window.PyNodeHost.state() === 'idle', { timeout: 60000 });
    await page.waitForTimeout(1200);

    await page.evaluate(() => document.querySelector('.appWrapper').scrollIntoView());
    await page.waitForTimeout(400);

    for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => window.PyNodeTheme.set(t), theme);
        await page.waitForTimeout(700);
        await page.screenshot({ path: join(OUT, `app-${theme}.png`) });
    }

    // The header card is where the riskiest asset treatment lives: logo.png is black
    // artwork on an OPAQUE white square, rescued in dark mode by invert + screen.
    await page.evaluate(() => window.PyNodeTheme.set('dark'));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    await page.screenshot({
        path: join(OUT, 'header-dark.png'),
        clip: { x: 300, y: 0, width: 800, height: 520 },
    });

    console.log(`wrote app-dark.png, app-light.png, header-dark.png to ${OUT}`);
    await context.close();
} finally {
    await harness.close();
}
