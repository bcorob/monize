import { describe, it, expect, vi, beforeEach } from 'vitest';
import type jsPDF from 'jspdf';
import { addSummaryCardsToPdf, PdfSummaryCard } from './pdf-export-cards';

function createMockDoc() {
  return {
    setFillColor: vi.fn(),
    setDrawColor: vi.fn(),
    setLineWidth: vi.fn(),
    roundedRect: vi.fn(),
    setFontSize: vi.fn(),
    setFont: vi.fn(),
    setTextColor: vi.fn(),
    text: vi.fn(),
  } as unknown as jsPDF;
}

describe('addSummaryCardsToPdf', () => {
  let doc: jsPDF;

  beforeEach(() => {
    doc = createMockDoc();
  });

  it('returns startY unchanged when cards array is empty', () => {
    const result = addSummaryCardsToPdf(doc, [], {
      startY: 30,
      pageWidth: 297,
      margin: 14,
    });

    expect(result).toBe(30);
    expect(doc.roundedRect).not.toHaveBeenCalled();
    expect(doc.text).not.toHaveBeenCalled();
  });

  it('draws a rounded rect and two text elements per card', () => {
    const cards: PdfSummaryCard[] = [
      { label: 'Net Worth', value: '$100,000' },
      { label: 'Change', value: '+$5,000', color: '#16a34a' },
    ];

    addSummaryCardsToPdf(doc, cards, {
      startY: 30,
      pageWidth: 297,
      margin: 14,
    });

    // One rounded rect per card
    expect(doc.roundedRect).toHaveBeenCalledTimes(2);

    // Two text calls per card (label + value) = 4 total
    expect(doc.text).toHaveBeenCalledTimes(4);

    // Verify label text
    expect(doc.text).toHaveBeenCalledWith('Net Worth', expect.any(Number), expect.any(Number));
    expect(doc.text).toHaveBeenCalledWith('$100,000', expect.any(Number), expect.any(Number));
    expect(doc.text).toHaveBeenCalledWith('Change', expect.any(Number), expect.any(Number));
    expect(doc.text).toHaveBeenCalledWith('+$5,000', expect.any(Number), expect.any(Number));
  });

  it('returns correct Y position after cards', () => {
    const cards: PdfSummaryCard[] = [
      { label: 'Total', value: '$50,000' },
    ];

    const result = addSummaryCardsToPdf(doc, cards, {
      startY: 30,
      pageWidth: 297,
      margin: 14,
    });

    // startY (30) + CARD_HEIGHT (18) + CARD_GAP (4) = 52
    expect(result).toBe(52);
  });

  it('uses default color when no color specified', () => {
    const cards: PdfSummaryCard[] = [
      { label: 'Metric', value: '42' },
    ];

    addSummaryCardsToPdf(doc, cards, {
      startY: 30,
      pageWidth: 297,
      margin: 14,
    });

    // Default color is #111827 -> RGB(17, 24, 39)
    expect(doc.setTextColor).toHaveBeenCalledWith(17, 24, 39);
  });

  it('uses specified color for value text', () => {
    const cards: PdfSummaryCard[] = [
      { label: 'Income', value: '$1,000', color: '#16a34a' },
    ];

    addSummaryCardsToPdf(doc, cards, {
      startY: 30,
      pageWidth: 297,
      margin: 14,
    });

    // #16a34a -> RGB(22, 163, 74)
    expect(doc.setTextColor).toHaveBeenCalledWith(22, 163, 74);
  });

  it('handles single card using full available width', () => {
    const cards: PdfSummaryCard[] = [
      { label: 'Total', value: '$10,000' },
    ];

    addSummaryCardsToPdf(doc, cards, {
      startY: 30,
      pageWidth: 297,
      margin: 14,
    });

    // Card width = (297 - 14*2 - 0 gaps) / 1 = 269
    expect(doc.roundedRect).toHaveBeenCalledWith(
      14, 30, 269, 18, 2, 2, 'FD',
    );
  });

  it('positions multiple cards with gaps between them', () => {
    const cards: PdfSummaryCard[] = [
      { label: 'A', value: '1' },
      { label: 'B', value: '2' },
      { label: 'C', value: '3' },
    ];

    addSummaryCardsToPdf(doc, cards, {
      startY: 30,
      pageWidth: 297,
      margin: 14,
    });

    expect(doc.roundedRect).toHaveBeenCalledTimes(3);

    // availableWidth = 297 - 28 = 269
    // cardWidth = (269 - 4*2) / 3 = 87
    const cardWidth = (269 - 4 * 2) / 3;
    const calls = vi.mocked(doc.roundedRect).mock.calls;

    // First card at x=14
    expect(calls[0][0]).toBeCloseTo(14);
    // Second card at x = 14 + cardWidth + 4
    expect(calls[1][0]).toBeCloseTo(14 + cardWidth + 4);
    // Third card at x = 14 + 2*(cardWidth + 4)
    expect(calls[2][0]).toBeCloseTo(14 + 2 * (cardWidth + 4));
  });

  describe('a card note', () => {
    function docWithSplit() {
      const d = createMockDoc() as unknown as Record<string, unknown>;
      d.splitTextToSize = vi.fn((text: string) => [text]);
      return d as unknown as jsPDF;
    }

    it('prints the note under the value and grows every card by the same strip', () => {
      const withNote = docWithSplit();
      const after = addSummaryCardsToPdf(
        withNote,
        [{ label: 'Net Worth', value: '$1', note: 'Partial total' }, { label: 'Change', value: '$2' }],
        { startY: 30, pageWidth: 297, margin: 14 },
      );
      const plain = addSummaryCardsToPdf(
        createMockDoc(),
        [{ label: 'Net Worth', value: '$1' }, { label: 'Change', value: '$2' }],
        { startY: 30, pageWidth: 297, margin: 14 },
      );
      expect(withNote.text).toHaveBeenCalledWith(['Partial total'], expect.any(Number), expect.any(Number));
      expect(after).toBeGreaterThan(plain);
      const heights = (withNote.roundedRect as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[3]);
      expect(new Set(heights).size).toBe(1);
    });

    it('leaves a row without notes laid out as before', () => {
      const d = createMockDoc();
      addSummaryCardsToPdf(d, [{ label: 'A', value: '1' }], { startY: 30, pageWidth: 297, margin: 14 });
      expect((d.roundedRect as ReturnType<typeof vi.fn>).mock.calls[0][3]).toBe(18);
      expect(d.text).toHaveBeenCalledTimes(2);
    });
  });
});
