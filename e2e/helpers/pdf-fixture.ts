/**
 * A one-page PDF, generated rather than checked in.
 *
 * The end-to-end spec drives the real pdf.js engine in a real browser: the
 * vendored worker, its module MIME type, the page's CSP and COEP headers, all
 * of which the unit suites mock away. It needs a document with something on
 * the page, and a binary blob in the repository would be a fixture nobody can
 * review. The cross-reference offsets are computed, not typed, so the file is
 * well-formed however the objects below are edited.
 */
export function minimalPdf(text = 'Monize receipt'): Buffer {
  const content = [
    '0.9 0.9 0.9 rg',
    '40 640 320 120 re f',
    '0 0 0 rg',
    'BT /F1 24 Tf 60 700 Td (' + text.replace(/[()\\]/g, '') + ') Tj ET',
    '0 0 1 RG 4 w 40 40 m 360 600 l S',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 800] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
