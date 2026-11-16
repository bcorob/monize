import type { Browser, Page } from '@playwright/test';
import { csrfToken } from '../helpers/api';

// One receipt on one transaction, so the attachment list and preview have a
// picture to show. The receipt is drawn here, locally, in a throwaway page: no
// image is downloaded and none is checked in.

export const RECEIPT_FILE = 'avenida-palace-invoice.png';

const RECEIPT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #d8d4cc; font-family: "DejaVu Sans Mono", "Courier New", monospace; }
  .paper { width: 400px; margin: 24px auto; padding: 28px 30px 24px; background: #fdfcf8; color: #222; font-size: 13px; line-height: 1.55; box-shadow: 0 2px 10px rgba(0,0,0,.25); }
  h1 { font-size: 17px; margin: 0; text-align: center; letter-spacing: .5px; }
  .sub { text-align: center; color: #555; font-size: 11px; margin-bottom: 14px; }
  .row { display: flex; justify-content: space-between; gap: 12px; }
  hr { border: 0; border-top: 1px dashed #888; margin: 10px 0; }
  .total { font-weight: bold; font-size: 15px; }
  .note { color: #555; font-size: 11px; text-align: center; margin-top: 12px; }
</style></head><body><div class="paper">
  <h1>HOTEL AVENIDA PALACE</h1>
  <div class="sub">Rua 1 de Dezembro 123 &middot; 1200-359 Lisboa<br>NIF 500 000 000 &middot; Invoice FT 2026/4182</div>
  <div class="row"><span>Guest</span><span>Demo User</span></div>
  <div class="row"><span>Stay</span><span>3 nights, 2 guests</span></div>
  <hr>
  <div class="row"><span>Double room x 3</span><span>375.00</span></div>
  <div class="row"><span>Breakfast x 6</span><span>28.50</span></div>
  <div class="row"><span>City tax x 6</span><span>9.00</span></div>
  <hr>
  <div class="row total"><span>TOTAL EUR</span><span>412.50</span></div>
  <div class="row"><span>Paid by card</span><span>VISA</span></div>
  <div class="note">VAT included where applicable.<br>Obrigado pela sua visita.</div>
</div></body></html>`;

/** Draw the receipt and return it as PNG bytes. */
export async function renderReceipt(browser: Browser): Promise<Buffer> {
  const context = await browser.newContext({
    viewport: { width: 460, height: 100 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  try {
    const page = await context.newPage();
    await page.setContent(RECEIPT_HTML);
    await page.evaluate(() => document.fonts.ready);
    return await page.screenshot({ type: 'png', fullPage: true });
  } finally {
    await context.close();
  }
}

/** Attach the receipt to `transactionId` unless it already has an attachment. */
export async function seedReceipt(
  page: Page,
  browser: Browser,
  transactionId: string,
): Promise<void> {
  const list = await page.request.get(`/api/v1/transactions/${transactionId}/attachments`);
  if (!list.ok()) throw new Error(`Listing attachments failed (${list.status()})`);
  const attachments = (await list.json()) as unknown[];
  if (attachments.length > 0) return;

  const token = await csrfToken(page.request);
  const upload = await page.request.post(`/api/v1/transactions/${transactionId}/attachments`, {
    headers: token ? { 'X-CSRF-Token': token } : {},
    multipart: {
      file: { name: RECEIPT_FILE, mimeType: 'image/png', buffer: await renderReceipt(browser) },
    },
  });
  if (!upload.ok()) {
    throw new Error(`Uploading the receipt failed (${upload.status()}): ${await upload.text()}`);
  }
}
