import { EntityManager } from "typeorm";
import { Tag } from "../../../tags/entities/tag.entity";
import {
  TagFinder,
  tagIdsFor,
  writeSplitTagLinks,
  writeTags,
  writeTransactionTagLinks,
} from "./write-tags";

/**
 * Tags are find-or-create through `TagsService`, so this spec pins the writer's
 * own two jobs: resolving each classification handle to the id the service
 * answered (case-insensitively, as the unique index compares) and counting only
 * the tags that did not exist before the import.
 */

function tag(id: string, name: string): Tag {
  return { id, name } as Tag;
}

/** A `TagFinder` whose two methods are mocks, typed so the spec can read them. */
type FinderDouble = TagFinder & {
  findByNames: jest.Mock;
  findOrCreateByNames: jest.Mock;
};

function finder(existing: Tag[], all: Tag[]): FinderDouble {
  return {
    findByNames: jest.fn().mockResolvedValue(existing),
    findOrCreateByNames: jest.fn().mockResolvedValue(all),
  };
}

function managerWith(repo: Record<string, jest.Mock>): EntityManager {
  return { getRepository: jest.fn(() => repo) } as unknown as EntityManager;
}

const manager = {} as EntityManager;

describe("writeTags", () => {
  it("does not touch the service when there is nothing to write", async () => {
    const tags = finder([], []);

    const written = await writeTags(manager, tags, "user-1", []);

    expect(written).toEqual({ idByHandle: new Map(), created: 0 });
    expect(tags.findOrCreateByNames).not.toHaveBeenCalled();
  });

  it("maps every handle to the id the service answers, by name", async () => {
    const tags = finder(
      [],
      [
        tag("tag-a", "Properties:20 Spring Apartment"),
        tag("tag-b", "Properties:Cottage"),
      ],
    );

    const written = await writeTags(manager, tags, "user-1", [
      { handle: 552, name: "Properties:20 Spring Apartment" },
      { handle: 560, name: "Properties:Cottage" },
    ]);

    expect(tags.findOrCreateByNames).toHaveBeenCalledWith(manager, "user-1", [
      "Properties:20 Spring Apartment",
      "Properties:Cottage",
    ]);
    expect([...written.idByHandle]).toEqual([
      [552, "tag-a"],
      [560, "tag-b"],
    ]);
    expect(written.created).toBe(2);
  });

  it("counts a tag the user already had as reused, matched case-insensitively", async () => {
    const tags = finder(
      [tag("tag-a", "properties:20 spring apartment")],
      [tag("tag-a", "properties:20 spring apartment")],
    );

    const written = await writeTags(manager, tags, "user-1", [
      { handle: 552, name: "Properties:20 Spring Apartment" },
    ]);

    expect(written.idByHandle.get(552)).toBe("tag-a");
    expect(written.created).toBe(0);
  });

  it("sends one name per distinct tag, not one per handle", async () => {
    const shared = { handle: 552, name: "Properties:Home" };
    const tags = finder([], [tag("tag-a", "Properties:Home")]);

    const written = await writeTags(manager, tags, "user-1", [
      shared,
      { ...shared, handle: 561 },
    ]);

    expect(tags.findOrCreateByNames.mock.calls[0][2]).toEqual([
      "Properties:Home",
    ]);
    expect(written.idByHandle.get(561)).toBe("tag-a");
  });

  it("splits a long list into the service's per-call limit", async () => {
    const mapped = Array.from({ length: 150 }, (_, index) => ({
      handle: index,
      name: `Properties:Item ${index}`,
    }));
    const tags = finder(
      [],
      mapped.map((entry) => tag(`tag-${entry.handle}`, entry.name)),
    );

    await writeTags(manager, tags, "user-1", mapped);

    expect(tags.findOrCreateByNames).toHaveBeenCalledTimes(2);
    expect(tags.findOrCreateByNames.mock.calls[0][2]).toHaveLength(100);
    expect(tags.findOrCreateByNames.mock.calls[1][2]).toHaveLength(50);
  });
});

describe("tagIdsFor", () => {
  it("resolves the handles it knows and de-duplicates", () => {
    const idByHandle = new Map([
      [552, "tag-a"],
      [561, "tag-a"],
    ]);

    expect(tagIdsFor([552, 561, 999], idByHandle)).toEqual(["tag-a"]);
    expect(tagIdsFor([], idByHandle)).toEqual([]);
  });
});

describe("tag links", () => {
  it("writes transaction links as multi-row inserts and skips an empty list", async () => {
    const repo = { insert: jest.fn().mockResolvedValue(undefined) };

    expect(await writeTransactionTagLinks(managerWith(repo), [])).toBe(0);
    expect(repo.insert).not.toHaveBeenCalled();

    const written = await writeTransactionTagLinks(managerWith(repo), [
      { rowId: "tx-1", tagId: "tag-a" },
      { rowId: "tx-2", tagId: "tag-a" },
    ]);

    expect(written).toBe(2);
    expect(repo.insert).toHaveBeenCalledWith([
      { transactionId: "tx-1", tagId: "tag-a" },
      { transactionId: "tx-2", tagId: "tag-a" },
    ]);
  });

  it("writes split links against the split column", async () => {
    const repo = { insert: jest.fn().mockResolvedValue(undefined) };

    const written = await writeSplitTagLinks(managerWith(repo), [
      { rowId: "split-1", tagId: "tag-a" },
    ]);

    expect(written).toBe(1);
    expect(repo.insert).toHaveBeenCalledWith([
      { transactionSplitId: "split-1", tagId: "tag-a" },
    ]);
  });
});
