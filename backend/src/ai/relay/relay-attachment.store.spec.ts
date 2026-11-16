import { BadRequestException } from "@nestjs/common";

import {
  RelayAttachmentStore,
  ATTACHMENT_TTL_MS,
} from "./relay-attachment.store";
import { createRelayRowsHarness, RelayRowsHarness } from "./relay-rows.harness";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";
const OTHER = "user-2";

// A valid 1x1 PNG so magic-byte validation passes.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const CSV_BASE64 = Buffer.from("a,b\n1,2\n").toString("base64");

const png = (filename = "img.png") => ({
  kind: "image" as const,
  mediaType: "image/png",
  filename,
  data: PNG_BASE64,
});

describe("RelayAttachmentStore", () => {
  let harness: RelayRowsHarness;
  let store: RelayAttachmentStore;

  beforeEach(() => {
    jest.useFakeTimers();
    harness = createRelayRowsHarness();
    store = harness.attachmentStore;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("returns an empty list and stores nothing for no attachments", async () => {
    await expect(store.store(USER, [])).resolves.toEqual([]);
    expect(harness.attachments).toHaveLength(0);
  });

  it("stores an attachment and returns a ref with a resource uri", async () => {
    const [ref] = await store.store(USER, [png("chart.png")]);
    expect(ref.filename).toBe("chart.png");
    expect(ref.kind).toBe("image");
    expect(ref.mediaType).toBe("image/png");
    expect(ref.uri).toBe(`monize-attachment://${ref.id}`);

    const stored = await store.get(USER, ref.id);
    expect(stored?.data.toString("base64")).toBe(PNG_BASE64);
  });

  it("puts the file in rows, bytes and all", async () => {
    const [ref] = await store.store(USER, [png()]);

    // The whole point of R5: a second replica reads this file, so nothing
    // about it may live in this process.
    expect(harness.attachments[0]).toMatchObject({
      id: ref.id,
      userId: USER,
      filename: "img.png",
      kind: "image",
      mime: "image/png",
    });
    expect(harness.attachments[0].size).toBeGreaterThan(0);
    expect(harness.attachments[0].data.toString("base64")).toBe(PNG_BASE64);
  });

  it("is readable by a second store over the same rows", async () => {
    const [ref] = await store.store(USER, [png()]);

    const otherReplica = new RelayAttachmentStore(harness.dataSource as never);

    await expect(otherReplica.get(USER, ref.id)).resolves.toMatchObject({
      filename: "img.png",
    });
  });

  it("decodes text attachments to readable bytes", async () => {
    const [ref] = await store.store(USER, [
      {
        kind: "text",
        mediaType: "text/csv",
        filename: "rows.csv",
        data: CSV_BASE64,
      },
    ]);
    const stored = await store.get(USER, ref.id);
    expect(stored?.data.toString("utf-8")).toBe("a,b\n1,2\n");
  });

  it("isolates attachments between users", async () => {
    const [ref] = await store.store(USER, [png()]);
    // Another user cannot resolve this id, even though it is globally unique:
    // the owner is in the statement, not in a bucket the caller picked.
    await expect(store.get(OTHER, ref.id)).resolves.toBeUndefined();
    await expect(store.get(USER, ref.id)).resolves.toBeDefined();
  });

  it("returns undefined for an unknown id", async () => {
    await expect(
      store.get(USER, "00000000-0000-0000-0000-000000000000"),
    ).resolves.toBeUndefined();
  });

  it("releases only the prompt's own attachments", async () => {
    const [a, b] = await store.store(USER, [png("a.png"), png("b.png")]);

    await store.releaseForPrompt(USER, [a.id]);

    await expect(store.get(USER, a.id)).resolves.toBeUndefined();
    await expect(store.get(USER, b.id)).resolves.toBeDefined();
    expect(harness.attachments).toHaveLength(1);
  });

  it("does not release another user's attachment", async () => {
    const [mine] = await store.store(USER, [png()]);

    await store.releaseForPrompt(OTHER, [mine.id]);

    await expect(store.get(USER, mine.id)).resolves.toBeDefined();
  });

  it("stops serving an attachment past its TTL", async () => {
    const [ref] = await store.store(USER, [png()]);

    await jest.advanceTimersByTimeAsync(ATTACHMENT_TTL_MS + 1);

    await expect(store.get(USER, ref.id)).resolves.toBeUndefined();
  });

  describe("validation", () => {
    it("rejects a kind/media-type mismatch", async () => {
      await expect(
        store.store(USER, [{ ...png(), kind: "pdf" }]),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects bytes that do not match the declared type (magic bytes)", async () => {
      await expect(
        store.store(USER, [
          { ...png(), data: Buffer.from("not a png").toString("base64") },
        ]),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects an attachment over the per-file size limit", async () => {
      // A PNG header followed by >5 MB of padding.
      const header = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const big = Buffer.concat([header, Buffer.alloc(5 * 1024 * 1024 + 1)]);
      await expect(
        store.store(USER, [{ ...png(), data: big.toString("base64") }]),
      ).rejects.toThrow(BadRequestException);
    });

    it("writes nothing at all when one attachment in a batch is rejected", async () => {
      await expect(
        store.store(USER, [png("ok.png"), { ...png(), kind: "pdf" }]),
      ).rejects.toThrow(BadRequestException);

      expect(harness.attachments).toHaveLength(0);
    });
  });
});
