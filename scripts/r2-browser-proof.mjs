// Called only by the opt-in R2 live test. Signed credentials arrive over stdin,
// never through command-line arguments, traces, screenshots or log output.
import { chromium } from '@playwright/test';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const fixture = JSON.parse(input);
if (!['http://localhost:5173', 'https://diagrams.bonatak.is'].includes(fixture.origin)) throw new Error('Unexpected fixture origin');
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Serve a generated page at the permitted environment origin. This exercises
  // Chrome's real CORS and forbidden-header handling without touching the user's
  // running dev server, browser library or diagrams.
  await page.route(fixture.origin + '/', route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<!doctype html><title>R2 fixture</title>',
  }));
  await page.goto(fixture.origin + '/');
  const result = await page.evaluate(async ({ url, headers, body, contentType }) => {
    try {
      const response = await fetch(url, {
        method: 'PUT', headers, body: new Blob([body], { type: contentType }),
        credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
      return { status: response.status };
    } catch { return { status: 0 }; }
  }, fixture);
  process.stdout.write(JSON.stringify(result));
} finally {
  await browser.close();
}
