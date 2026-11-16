import { isPostCommitFailure, PostCommitFailure } from "./post-commit-failure";

describe("PostCommitFailure", () => {
  it("carries the message, the cause, the name and the committed marker", () => {
    const cause = new Error("store down");
    const failure = new PostCommitFailure("attachment failed", { cause });

    expect(failure).toBeInstanceOf(Error);
    expect(failure.name).toBe("PostCommitFailure");
    expect(failure.message).toBe("attachment failed");
    expect(failure.committed).toBe(true);
    expect(failure.cause).toBe(cause);
  });

  it("is recognised by isPostCommitFailure", () => {
    expect(isPostCommitFailure(new PostCommitFailure("x"))).toBe(true);
  });

  it("does not match an ordinary error or a non-error", () => {
    expect(isPostCommitFailure(new Error("x"))).toBe(false);
    expect(isPostCommitFailure("PostCommitFailure")).toBe(false);
    expect(isPostCommitFailure(null)).toBe(false);
    expect(isPostCommitFailure({ committed: true })).toBe(false);
  });
});
