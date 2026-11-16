import { ServiceUnavailableException } from "@nestjs/common";
import { AttachmentStorageProvider } from "./attachment-storage.interface";
import {
  ATTACHMENT_STORE_UNREACHABLE_CODE,
  AttachmentStorageRegistry,
} from "./attachment-storage.registry";

function store(name: string, addressable = true): AttachmentStorageProvider {
  return {
    name,
    addressable,
    save: jest.fn(),
    load: jest.fn(),
    delete: jest.fn(),
  };
}

describe("AttachmentStorageRegistry", () => {
  const database = store("database");
  const local = store("local");

  describe("resolving a row's backend", () => {
    it("answers with the provider the row names, not the active one", () => {
      const registry = new AttachmentStorageRegistry(database, [
        database,
        local,
      ]);

      // The whole point: `local` is where this row's bytes are, whatever the
      // deployment now writes new ones to.
      expect(registry.resolve("local")).toBe(local);
      expect(registry.active).toBe(database);
    });

    it("answers null for a backend this build does not have", () => {
      const registry = new AttachmentStorageRegistry(database, [database]);

      expect(registry.resolve("azure-blob")).toBeNull();
    });

    it("answers null for a backend it has but cannot address", () => {
      const s3 = store("s3", false);
      const registry = new AttachmentStorageRegistry(database, [database, s3]);

      // Configured-not-at-all, which is a deployment repair and not a missing
      // attachment -- so it must not be reported as "no bytes".
      expect(registry.resolve("s3")).toBeNull();
      expect(registry.addressable()).toEqual([database]);
    });
  });

  describe("require", () => {
    it("names the backend in the refusal", () => {
      const registry = new AttachmentStorageRegistry(database, [database]);

      expect(() => registry.require("s3")).toThrow(ServiceUnavailableException);
      // An operator reading "attachment unavailable" looks in the wrong place;
      // the provider name is what points at the setting to fix.
      expect(() => registry.require("s3")).toThrow(/s3/);
    });

    it("carries a stable code the client can match on", () => {
      const registry = new AttachmentStorageRegistry(database, [database]);

      // The status alone is not enough on the client: a reverse proxy answers 503
      // when the backend is down, and the preview must not read that as "your
      // file is in an unconfigured storage backend".
      try {
        registry.require("s3");
        throw new Error("require should have refused");
      } catch (error) {
        const body = (error as ServiceUnavailableException).getResponse();
        expect(body).toMatchObject({
          code: ATTACHMENT_STORE_UNREACHABLE_CODE,
          message: expect.stringContaining("s3"),
        });
      }
    });

    it("returns the provider when it is addressable", () => {
      const registry = new AttachmentStorageRegistry(local, [database, local]);

      expect(registry.require("database")).toBe(database);
    });
  });

  describe("what it refuses to be built with", () => {
    it("rejects two providers answering to one name", () => {
      // The name is persisted in a column, so a duplicate would make `resolve`
      // pick whichever was constructed last: a silently wrong backend.
      expect(
        () =>
          new AttachmentStorageRegistry(database, [
            database,
            store("database"),
          ]),
      ).toThrow(/named "database"/);
    });

    it("rejects an active provider that is not registered", () => {
      expect(
        () => new AttachmentStorageRegistry(store("s3"), [database, local]),
      ).toThrow(/not among the registered providers/);
    });
  });
});
