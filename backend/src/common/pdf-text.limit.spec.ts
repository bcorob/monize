const mockDestroy = jest.fn().mockResolvedValue(undefined);
const mockGetDocument = jest.fn();
jest.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: (options: unknown) => mockGetDocument(options),
}));
import { extractPdfText } from "./pdf-text";

function document(numPages: number) {
  const page = {
    getTextContent: async () => ({ items: [{ str: "x", hasEOL: true }] }),
    cleanup: jest.fn(),
  };
  mockGetDocument.mockReturnValue({
    promise: Promise.resolve({ numPages, getPage: async () => page }),
    destroy: mockDestroy,
  });
}

describe("extractPdfText page limit", () => {
  beforeEach(() => mockDestroy.mockClear());

  it("reads any page count when no limit is given", async () => {
    document(100);
    expect((await extractPdfText(new Uint8Array([1]))).length).toBe(300);
  });

  it("refuses a document over the limit and still releases it", async () => {
    document(3);
    await expect(extractPdfText(new Uint8Array([1]), 2)).rejects.toThrow(
      "PDF has 3 pages",
    );
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it("reads a document at the limit", async () => {
    document(2);
    await expect(extractPdfText(new Uint8Array([1]), 2)).resolves.toBe(
      "x\n\nx\n\n",
    );
  });

  it("hands pdf.js a copy of the bytes", async () => {
    document(1);
    const bytes = new Uint8Array([1, 2]);
    await extractPdfText(bytes);
    const data = mockGetDocument.mock.lastCall![0].data as Uint8Array;
    expect(data).toEqual(bytes);
    expect(data.buffer).not.toBe(bytes.buffer);
  });
});
