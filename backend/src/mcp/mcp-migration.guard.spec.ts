import { readFileSync } from "fs";
import { join } from "path";
import { gitListFiles } from "../common/repo-tree.util";

/**
 * The mechanical half of the move to the 2026-07-28 revision.
 *
 * Each rule below is one mistake that compiles, passes every behavioural test,
 * and is wrong: identity read from somewhere other than the request, a
 * confirmation dropped on the floor, a second copy of the plumbing. Prose in
 * `CLAUDE.md` gets read, agreed with and violated anyway, so these are checked.
 */

const SRC = join(__dirname, "..");
const MCP = __dirname;

/**
 * Comments name the very patterns these rules ban -- the paragraph above
 * already spells one out -- so a scan of raw text would fail on its own
 * explanation. Blank them while keeping line numbers, so an offender still
 * points at the right line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_match, prefix: string) => prefix);
}

function read(relativePath: string): string {
  return stripComments(readFileSync(join(SRC, relativePath), "utf8"));
}

function sourceFiles(predicate: (path: string) => boolean): string[] {
  return gitListFiles(SRC)
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".spec.ts"))
    .filter(predicate);
}

describe("stripComments", () => {
  // A stripper that removes too much would silently pass every rule below.
  it("blanks comments and keeps everything else, line for line", () => {
    const source = [
      "const a = 1; // extra.sessionId",
      "/* ctx.sessionId */",
      'const url = "https://example.com/x";',
    ].join("\n");
    const stripped = stripComments(source);
    expect(stripped).not.toContain("extra.sessionId");
    expect(stripped).not.toContain("ctx.sessionId");
    expect(stripped).toContain("const a = 1;");
    expect(stripped).toContain("https://example.com/x");
    expect(stripped.split("\n")).toHaveLength(3);
  });
});

describe("the MCP server speaks the v2 SDK only", () => {
  const files = sourceFiles(() => true);

  it("finds the sources to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  // 1.x is frozen and can never speak 2026-07-28; an import of it would be a
  // second protocol implementation living beside the first.
  it("imports no 1.x package anywhere", () => {
    const offenders = files.filter((path) =>
      read(path).includes("@modelcontextprotocol/sdk"),
    );
    expect(offenders).toEqual([]);
  });
});

describe("identity comes from the request", () => {
  const mcpFiles = sourceFiles((path) => path.startsWith("mcp/"));

  it("finds the MCP sources to scan", () => {
    expect(mcpFiles.length).toBeGreaterThan(20);
  });

  // These were the session-shaped reads. A 2026-07-28 request has no session at
  // all, so a handler reaching for one resolves nobody.
  it.each(["extra.sessionId", "extra.requestId", "UserContextResolver"])(
    "no handler reads %s",
    (banned) => {
      const offenders = mcpFiles.filter((path) => read(path).includes(banned));
      expect(offenders).toEqual([]);
    },
  );

  // `resolveUserContext` validates the shape before trusting it, and
  // `callerKey` is the one place the session-or-credential decision is made.
  // A handler reading either directly would be a second answer to the same
  // question.
  it("reads authInfo and sessionId in mcp-context.ts alone", () => {
    const offenders = mcpFiles.filter(
      (path) =>
        path !== "mcp/mcp-context.ts" &&
        /authInfo\?\.extra|ctx\.sessionId/.test(read(path)),
    );
    expect(offenders).toEqual([]);
  });
});

describe("a write confirmation is asked in one place", () => {
  const toolFiles = sourceFiles((path) => path.startsWith("mcp/tools/"));

  it("finds the tool sources to scan", () => {
    expect(toolFiles.length).toBeGreaterThan(5);
  });

  // The confirmation state machine (the seal, the fingerprint, the era branch)
  // lives in mcp-confirm.ts. A tool that built its own `inputRequired` would
  // ask a question nothing verifies the answer to.
  it.each(["inputRequired(", "createRequestStateCodec("])(
    "no tool calls %s itself",
    (banned) => {
      const offenders = toolFiles.filter((path) => read(path).includes(banned));
      expect(offenders).toEqual([]);
    },
  );

  // The half of a multi round-trip confirmation that is easy to forget: round
  // one returns a QUESTION, and a tool that falls through it writes without an
  // answer. Every file that asks must also handle the question.
  it("every tool that confirms a write handles the unanswered round", () => {
    const asking = toolFiles.filter((path) =>
      /confirmWrite\(|confirmWriteMany\(/.test(read(path)),
    );
    expect(asking.length).toBeGreaterThan(0);
    const offenders = asking.filter((path) => !read(path).includes("isAsk("));
    expect(offenders).toEqual([]);
  });

  // The action a card is fingerprinted under is `confirmItemsForCards`'
  // decision, in one place. Three tools had their own copy of the mapping, and
  // a fourth would be the one that passes something the round that writes
  // cannot re-derive.
  it("no tool builds its own confirmation card mapping", () => {
    const offenders = toolFiles.filter((path) =>
      /key:\s*cardKey\(/.test(read(path)),
    );
    expect(offenders).toEqual([]);
  });

  // A tool reading the answers itself would skip the fingerprint check, which
  // is what proves the retry is about the change the user approved.
  it("no tool reads inputResponses directly", () => {
    const offenders = toolFiles.filter((path) =>
      read(path).includes("inputResponses"),
    );
    expect(offenders).toEqual([]);
  });
});

describe("the confirmation seal", () => {
  // Signed, not encrypted: the client can read the payload, so it may carry a
  // fingerprint and nothing else. A row id, an amount or a name in there would
  // be handed to whoever holds the token.
  it("puts nothing but a fingerprint on the wire", () => {
    const state = readFileSync(join(MCP, "mcp-request-state.ts"), "utf8");
    const shape = state.slice(
      state.indexOf("export interface McpConfirmState"),
      state.indexOf("}", state.indexOf("export interface McpConfirmState")),
    );
    const fields = [...stripComments(shape).matchAll(/^\s*(\w+)[?]?:/gm)].map(
      (match) => match[1],
    );
    expect(fields.sort()).toEqual(["fingerprint", "keys", "v"]);
  });

  // The fingerprint is recomputed on a LATER tool call, so it may only cover
  // fields the change itself determines. `roundStableAction` is where the
  // per-build ones are dropped; hashing `item.action` raw is the defect it
  // exists to prevent, and it is one edit away at all times.
  it("fingerprints the round-stable projection, not the raw action", () => {
    const confirm = read("mcp/mcp-confirm.ts");
    expect(confirm).toContain("action: roundStableAction(item.action)");
    expect(confirm).not.toMatch(/^\s*action: item\.action,$/m);
  });
});
