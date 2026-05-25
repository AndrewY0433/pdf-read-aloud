import { test, expect, type ConsoleMessage } from '@playwright/test';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures');
const FIXTURE_PDF = join(FIXTURE_DIR, 'hello.pdf');

/**
 * Tiny hand-crafted single-page PDF that renders the phrase
 *   "Hello PDF read aloud world."
 * in Helvetica. Generated once at test-setup time and committed-free.
 */
function buildHelloPdf(): Uint8Array {
  const content = 'BT /F1 24 Tf 50 700 Td (Hello PDF read aloud world.) Tj ET';
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  const offsets: number[] = [];

  const push = (s: string): void => {
    const bytes = encoder.encode(s);
    chunks.push(bytes);
    cursor += bytes.length;
  };

  push('%PDF-1.4\n');
  // Binary marker so picky parsers don't treat this as 7-bit-clean text.
  chunks.push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  cursor += 6;

  objects.forEach((body, i) => {
    offsets.push(cursor);
    push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefStart = cursor;
  push(`xref\n0 ${objects.length + 1}\n`);
  push('0000000000 65535 f \n');
  for (const off of offsets) push(`${String(off).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`);
  push(`startxref\n${xrefStart}\n%%EOF`);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

function ensureFixture(): void {
  if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });
  if (!existsSync(FIXTURE_PDF)) writeFileSync(FIXTURE_PDF, buildHelloPdf());
}

test.beforeAll(() => {
  ensureFixture();
});

test.describe('PDF read-aloud — initial UI', () => {
  test('loads without console errors and exposes the expected chrome', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto('/');
    await expect(page).toHaveTitle(/PDF read-aloud/i);
    await expect(page.locator('.bottom-bar')).toBeVisible();
    await expect(page.locator('.drop-overlay')).toBeVisible();
    await expect(page.locator('.engine-toggle')).toBeVisible();
    await expect(page.locator('.speed-control')).toBeVisible();
    await expect(page.locator('.speed-value')).toHaveText('1.0x');
    expect(errors).toEqual([]);
  });

  test('Play and Pause are disabled before a PDF is loaded', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-act=play]')).toBeDisabled();
    await expect(page.locator('[data-act=pause]')).toBeDisabled();
  });
});

test.describe('Speed control', () => {
  test('« and » step the displayed rate by 0.25x', async ({ page }) => {
    await page.goto('/');
    const value = page.locator('.speed-value');
    await page.locator('[data-act=speed-up]').click();
    await expect(value).toHaveText('1.25x');
    await page.locator('[data-act=speed-up]').click();
    await expect(value).toHaveText('1.5x');
    await page.locator('[data-act=speed-down]').click();
    await expect(value).toHaveText('1.25x');
  });

  test('disables » at the maximum rate and « at the minimum', async ({ page }) => {
    await page.goto('/');
    const upBtn = page.locator('[data-act=speed-up]');
    const downBtn = page.locator('[data-act=speed-down]');
    // 1.0 -> 3.0 is 8 quarter-steps.
    for (let i = 0; i < 8; i++) await upBtn.click();
    await expect(page.locator('.speed-value')).toHaveText('3.0x');
    await expect(upBtn).toBeDisabled();
    // Walk all the way back down.
    for (let i = 0; i < 10; i++) {
      if (await downBtn.isDisabled()) break;
      await downBtn.click();
    }
    await expect(page.locator('.speed-value')).toHaveText('0.5x');
    await expect(downBtn).toBeDisabled();
  });
});

test.describe('Engine toggle', () => {
  test('switching engines updates the active button and persists across reload', async ({
    page,
  }) => {
    await page.goto('/');
    // The default is Kokoro/Neural, so click Browser to verify it persists.
    await page.locator('.engine-toggle [data-engine="web-speech"]').click();
    await expect(
      page.locator('.engine-toggle [data-engine="web-speech"]'),
    ).toHaveClass(/active/);
    await page.reload();
    await expect(
      page.locator('.engine-toggle [data-engine="web-speech"]'),
    ).toHaveClass(/active/);
  });
});

test.describe('PDF upload', () => {
  test('uploading a minimal PDF renders pages and enables Play', async ({ page }) => {
    await page.goto('/');
    const fileInput = page.locator('input[type=file]');
    await fileInput.setInputFiles(FIXTURE_PDF);
    // The viewer renders one .pdf-page per page in the document.
    await expect(page.locator('.pdf-page')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('.pdf-page canvas')).toBeVisible();
    await expect(page.locator('[data-act=play]')).toBeEnabled();
    await expect(page.locator('.filename')).toHaveText(/hello\.pdf/);
    await expect(page.locator('.progress-bar')).toBeVisible();
    await expect(page.locator('.progress-bar__tooltip')).toHaveText('Page 1 of 1');
  });

  test('clicking Play flips the Pause button to enabled', async ({ page }) => {
    await page.goto('/');
    // Force the simpler engine so the test doesn't depend on a Hugging Face
    // download. Set this BEFORE first navigation so the app reads it on init.
    await page.evaluate(() =>
      localStorage.setItem('pdf-read-aloud.engine', 'web-speech'),
    );
    await page.reload();
    await page.locator('input[type=file]').setInputFiles(FIXTURE_PDF);
    await expect(page.locator('.pdf-page')).toHaveCount(1, { timeout: 15_000 });

    const playBtn = page.locator('[data-act=play]');
    const pauseBtn = page.locator('[data-act=pause]');
    await expect(playBtn).toBeEnabled();
    await playBtn.click();
    await expect(pauseBtn).toBeEnabled();
  });
});
