import { McpRelayAttachmentResource } from "./relay-attachment.resource";
import { RelayAttachmentStore } from "../../ai/relay/relay-attachment.store";
import { createRelayRowsHarness } from "../../ai/relay/relay-rows.harness";
import { extractPdfText } from "../../common/pdf-text";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

jest.mock("../../common/pdf-text", () => ({
  extractPdfText: jest.fn(),
}));
const mockExtractPdfText = extractPdfText as jest.MockedFunction<
  typeof extractPdfText
>;

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const CSV_BASE64 = Buffer.from("a,b\n1,2\n").toString("base64");
// The store only checks the leading %PDF magic bytes; extraction is mocked.
const PDF_BASE64 = Buffer.from("%PDF-1.4 minimal").toString("base64");

// The handler only reads `uri.href`, so a light stub suffices.
const uriFor = (id: string) => ({ href: `monize-attachment://${id}` }) as any;

describe("McpRelayAttachmentResource", () => {
  let store: RelayAttachmentStore;
  let resource: McpRelayAttachmentResource;
  let server: { registerResource: jest.Mock };
  let ctx: McpTestContext;
  let handler: (...args: any[]) => any;

  beforeEach(() => {
    store = createRelayRowsHarness().attachmentStore;
    resource = new McpRelayAttachmentResource(store);
    server = {
      registerResource: jest.fn((_name, _template, _opts, h) => {
        handler = h;
      }),
    };
    ctx = mcpTestCtx();
    resource.register(server as any);
  });

  it("registers a templated resource", () => {
    expect(server.registerResource).toHaveBeenCalledWith(
      "relay-attachment",
      expect.any(Object),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns an error when there is no user context", async () => {
    ctx.setUser(undefined);
    const result = await handler(uriFor("x"), { id: "x" }, ctx);
    expect(result.contents[0].text).toContain("Error");
  });

  it("returns an error when the read scope is missing", async () => {
    ctx.setUser({ userId: "u1", scopes: "write" });
    const result = await handler(uriFor("x"), { id: "x" }, ctx);
    expect(result.contents[0].text).toContain("Insufficient scope");
  });

  it("returns a not-found error for an unknown or expired id", async () => {
    ctx.setUser({ userId: "u1", scopes: "read" });
    const result = await handler(uriFor("nope"), { id: "nope" }, ctx);
    expect(result.contents[0].text).toContain("not found or expired");
  });

  it("returns a base64 blob for an image attachment", async () => {
    const [ref] = await store.store("u1", [
      {
        kind: "image",
        mediaType: "image/png",
        filename: "i.png",
        data: PNG_BASE64,
      },
    ]);
    ctx.setUser({ userId: "u1", scopes: "read" });

    const result = await handler(uriFor(ref.id), { id: ref.id }, ctx);
    expect(result.contents[0].mimeType).toBe("image/png");
    expect(result.contents[0].blob).toBe(PNG_BASE64);
    expect(result.contents[0].text).toBeUndefined();
  });

  it("returns text for a text attachment", async () => {
    const [ref] = await store.store("u1", [
      {
        kind: "text",
        mediaType: "text/csv",
        filename: "r.csv",
        data: CSV_BASE64,
      },
    ]);
    ctx.setUser({ userId: "u1", scopes: "read" });

    const result = await handler(uriFor(ref.id), { id: ref.id }, ctx);
    expect(result.contents[0].mimeType).toBe("text/csv");
    expect(result.contents[0].text).toBe("a,b\n1,2\n");
    expect(result.contents[0].blob).toBeUndefined();
  });

  it("returns server-extracted text (not a blob) for a PDF attachment", async () => {
    mockExtractPdfText.mockResolvedValue("  Bank statement: balance $100\n");
    const [ref] = await store.store("u1", [
      {
        kind: "pdf",
        mediaType: "application/pdf",
        filename: "statement.pdf",
        data: PDF_BASE64,
      },
    ]);
    ctx.setUser({ userId: "u1", scopes: "read" });

    const result = await handler(uriFor(ref.id), { id: ref.id }, ctx);
    // Returned as text/plain so the agent's client never sees a PDF blob.
    expect(result.contents[0].mimeType).toBe("text/plain");
    expect(result.contents[0].text).toBe("Bank statement: balance $100");
    expect(result.contents[0].blob).toBeUndefined();
  });

  it("falls back to a base64 blob when a PDF has no extractable text", async () => {
    mockExtractPdfText.mockResolvedValue("");
    const [ref] = await store.store("u1", [
      {
        kind: "pdf",
        mediaType: "application/pdf",
        filename: "scan.pdf",
        data: PDF_BASE64,
      },
    ]);
    ctx.setUser({ userId: "u1", scopes: "read" });

    const result = await handler(uriFor(ref.id), { id: ref.id }, ctx);
    // A scanned/image-only PDF is served as raw bytes, like a picture, so a
    // vision-capable client/model can still read it.
    expect(result.contents[0].mimeType).toBe("application/pdf");
    expect(result.contents[0].blob).toBe(PDF_BASE64);
    expect(result.contents[0].text).toBeUndefined();
  });

  it("falls back to a base64 blob when PDF extraction fails", async () => {
    mockExtractPdfText.mockRejectedValue(new Error("corrupt pdf"));
    const [ref] = await store.store("u1", [
      {
        kind: "pdf",
        mediaType: "application/pdf",
        filename: "broken.pdf",
        data: PDF_BASE64,
      },
    ]);
    ctx.setUser({ userId: "u1", scopes: "read" });

    const result = await handler(uriFor(ref.id), { id: ref.id }, ctx);
    // PDF extraction failing should not fail the read -- serve the raw bytes instead.
    expect(result.contents[0].mimeType).toBe("application/pdf");
    expect(result.contents[0].blob).toBe(PDF_BASE64);
    expect(result.contents[0].text).toBeUndefined();
  });

  it("does not let one user read another user's attachment", async () => {
    const [ref] = await store.store("u1", [
      {
        kind: "image",
        mediaType: "image/png",
        filename: "i.png",
        data: PNG_BASE64,
      },
    ]);
    // A different user is resolved from the request; the id belongs to u1.
    ctx.setUser({ userId: "u2", scopes: "read" });

    const result = await handler(uriFor(ref.id), { id: ref.id }, ctx);
    expect(result.contents[0].text).toContain("not found or expired");
    expect(result.contents[0].blob).toBeUndefined();
  });
});
