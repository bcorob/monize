import { SingleUseTokenService } from "../auth/single-use-token.service";

/**
 * A `SingleUseTokenService` double backed by a `Set`.
 *
 * Wins the first claim on a `purpose:token` pair and loses every later one, and
 * makes a released pair claimable again -- the real service's whole contract. A double that always returned
 * `true` would take the replay assertions with it -- and the replay refusal is
 * the reason the service exists.
 *
 * The set is in the *test*: it stands in for one shared table, so a spec can
 * pre-seed a claim to model "another replica already spent this".
 */
export type SingleUseTokenMock = jest.Mocked<
  Pick<SingleUseTokenService, "claim" | "release">
> & {
  /** Claims already spent, keyed `purpose\u0000token` (the raw token, unhashed). */
  claimed: Set<string>;
};

export function singleUseKey(purpose: string, token: string): string {
  return `${purpose}\u0000${token}`;
}

export function createSingleUseTokenMock(): SingleUseTokenMock {
  const claimed = new Set<string>();
  return {
    claimed,
    claim: jest.fn(async (purpose: string, token: string, _ttlMs: number) => {
      const id = singleUseKey(purpose, token);
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    }),
    release: jest.fn(async (purpose: string, token: string) => {
      claimed.delete(singleUseKey(purpose, token));
    }),
  };
}

/** Provider entry for `Test.createTestingModule({ providers: [...] })`. */
export function singleUseTokenProvider(
  mock: SingleUseTokenMock = createSingleUseTokenMock(),
): {
  provide: typeof SingleUseTokenService;
  useValue: SingleUseTokenMock;
} {
  return { provide: SingleUseTokenService, useValue: mock };
}
