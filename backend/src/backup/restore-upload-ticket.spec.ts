import { createHmac } from "crypto";
import type { IncomingMessage } from "http";
import {
  RESTORE_TICKET_HEADER,
  RESTORE_TICKET_TTL_MS,
  createRestoreTicketAuthorizer,
  mintRestoreUploadTicket,
  verifyRestoreUploadTicket,
} from "./restore-upload-ticket";

const SECRET = "a-jwt-secret-of-at-least-32-characters!!";
const OTHER_SECRET = "a-different-jwt-secret-of-32-chars!!!!!!";
const USER = "11111111-2222-3333-4444-555555555555";
const NOW = 1_800_000_000_000;

const requestWith = (token?: string): IncomingMessage =>
  ({
    headers: token === undefined ? {} : { [RESTORE_TICKET_HEADER]: token },
  }) as unknown as IncomingMessage;

describe("restore upload tickets", () => {
  it("round-trips the user it was minted for", () => {
    const { ticket, expiresAt } = mintRestoreUploadTicket(USER, SECRET, NOW);
    expect(expiresAt).toBe(NOW + RESTORE_TICKET_TTL_MS);

    const result = verifyRestoreUploadTicket(ticket, SECRET, NOW + 1000);
    expect(result).toEqual({
      ok: true,
      payload: { userId: USER, expiresAt },
    });
  });

  it("expires", () => {
    const { ticket } = mintRestoreUploadTicket(USER, SECRET, NOW);
    // On the boundary it is already gone: a ticket valid "until" its expiry and
    // one valid "at" it differ by a second nobody can reason about.
    expect(
      verifyRestoreUploadTicket(ticket, SECRET, NOW + RESTORE_TICKET_TTL_MS),
    ).toEqual({ ok: false, reason: "expired" });
  });

  /**
   * The forgery that would matter: a caller who edits the expiry so their ticket
   * never runs out. The payload is inside the signature, so it cannot be moved
   * without the key -- and the expiry is only read *after* the signature holds,
   * because reading an attacker-supplied claim first is trusting the half of the
   * token that is not yet authentic.
   */
  it("refuses a payload whose expiry was extended", () => {
    const { ticket } = mintRestoreUploadTicket(USER, SECRET, NOW);
    const [, signature] = ticket.split(".");
    const forged = Buffer.from(
      JSON.stringify({ userId: USER, expiresAt: NOW + 10 ** 12 }),
      "utf-8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(
      verifyRestoreUploadTicket(`${forged}.${signature}`, SECRET, NOW),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a ticket signed with another key", () => {
    const { ticket } = mintRestoreUploadTicket(USER, OTHER_SECRET, NOW);
    expect(verifyRestoreUploadTicket(ticket, SECRET, NOW)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  /**
   * Domain separation: the ticket key is derived from `JWT_SECRET`, never the
   * secret itself, so a ticket cannot be produced by anything that merely holds
   * the JWT signing key's outputs -- and a ticket is not an access token.
   */
  it("does not sign with the raw JWT secret", () => {
    const { ticket } = mintRestoreUploadTicket(USER, SECRET, NOW);
    expect(ticket).not.toContain(SECRET);
    // A signature computed directly over the payload with the raw secret must not
    // verify: that is what a domain separator is for.
    const [payload] = ticket.split(".");
    const naive = createHmac("sha256", SECRET)
      .update(payload)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(
      verifyRestoreUploadTicket(`${payload}.${naive}`, SECRET, NOW),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it.each([
    ["nothing", undefined],
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("reports %s as missing rather than malformed", (_label, token) => {
    expect(verifyRestoreUploadTicket(token, SECRET, NOW)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it.each([
    ["no separator", "notaticket"],
    ["an empty payload", ".signature"],
    ["an empty signature", "payload."],
    ["three parts", "a.b.c"],
  ])("refuses %s", (_label, token) => {
    const result = verifyRestoreUploadTicket(token, SECRET, NOW);
    expect(result.ok).toBe(false);
  });

  it("refuses a correctly signed payload that is not a ticket", () => {
    // Signed with the right key, so the signature holds -- and still refused,
    // because the claim inside is not one this can read. A verifier that trusted
    // the signature and then destructured would hand `undefined` to its caller.
    const payload = Buffer.from(JSON.stringify({ hello: "world" }), "utf-8")
      .toString("base64")
      .replace(/=+$/, "");
    const { ticket } = mintRestoreUploadTicket(USER, SECRET, NOW);
    void ticket;
    const result = verifyRestoreUploadTicket(
      `${payload}.${"x".repeat(43)}`,
      SECRET,
      NOW,
    );
    expect(result.ok).toBe(false);
  });
});

describe("createRestoreTicketAuthorizer", () => {
  it("admits a request carrying a valid ticket", () => {
    const authorize = createRestoreTicketAuthorizer(SECRET);
    const { ticket } = mintRestoreUploadTicket(USER, SECRET);
    expect(authorize(requestWith(ticket))).toEqual({ ok: true });
  });

  it("refuses a request with no ticket, naming where to get one", () => {
    const authorize = createRestoreTicketAuthorizer(SECRET);
    const result = authorize(requestWith());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // 403, not 401. The client's interceptor reads a 401 as an expired session
    // and retries the request after refreshing the token -- which here means
    // re-uploading the whole artifact, or logging the user out mid-restore.
    expect(result.status).toBe(403);
    // The remedy has to be in the message: a refusal on a route the client
    // believes it is authenticated for is otherwise unexplainable.
    expect(result.message).toContain("restore/ticket");
  });

  it("gives one answer for every rejection", () => {
    const authorize = createRestoreTicketAuthorizer(SECRET);
    const expired = mintRestoreUploadTicket(USER, SECRET, 0).ticket;
    const forged = mintRestoreUploadTicket(USER, OTHER_SECRET).ticket;
    const messages = [requestWith(), requestWith(expired), requestWith(forged)]
      .map((req) => authorize(req))
      .map((result) => (result.ok ? "admitted" : result.message));
    expect(new Set(messages).size).toBe(1);
  });

  it("refuses everything when the deployment has no signing secret", () => {
    // Not "admits everything": a ticket signed with an empty key is forgeable by
    // anyone, so an unverifiable deployment must refuse rather than wave through.
    const authorize = createRestoreTicketAuthorizer(undefined);
    const result = authorize(requestWith("anything"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(503);
  });

  it("reads the first value of a repeated header", () => {
    const authorize = createRestoreTicketAuthorizer(SECRET);
    const { ticket } = mintRestoreUploadTicket(USER, SECRET);
    const req = {
      headers: { [RESTORE_TICKET_HEADER]: [ticket, "junk"] },
    } as unknown as IncomingMessage;
    expect(authorize(req)).toEqual({ ok: true });
  });
});
