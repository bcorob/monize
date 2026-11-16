import { Injectable, Logger } from "@nestjs/common";
import { ProviderHealthService } from "../../../provider-health/provider-health.service";
import { getActiveScopedManager } from "../../../common/db/scoped-db";
import { simplefinAccessRequest, simplefinClaimUrl } from "./simplefin.urls";
import {
  SimplefinTransport,
  SimplefinTransportError,
} from "./simplefin.transport";

export class SimplefinNotDispatchedError extends SimplefinTransportError {}

@Injectable()
export class SimplefinClient {
  private readonly logger = new Logger(SimplefinClient.name);
  constructor(
    private readonly transport: SimplefinTransport,
    private readonly health: ProviderHealthService,
  ) {}

  claim(token: string): Promise<string> {
    simplefinClaimUrl(token);
    return this.attempt(() => this.transport.claim(token));
  }

  accounts(
    accessUrl: string,
    window?: { startDate: number; endDate: number },
  ): Promise<unknown> {
    simplefinAccessRequest(accessUrl);
    return this.attempt(() => this.transport.accounts(accessUrl, window));
  }

  private async attempt<T>(operation: () => Promise<T>): Promise<T> {
    if (getActiveScopedManager())
      throw new Error("Call SimpleFIN outside an active database transaction");
    try {
      this.health.assertAvailable("simplefin");
    } catch {
      throw new SimplefinNotDispatchedError("transport");
    }
    try {
      const result = await operation();
      this.health.recordSuccess("simplefin");
      return result;
    } catch (error) {
      // Every HTTP answer proves reachability. No provider text or original
      // network error crosses into the logger / outage notification machinery.
      if (
        error instanceof SimplefinTransportError &&
        error.kind !== "transport"
      ) {
        this.health.recordSuccess("simplefin");
      } else {
        const safe = Object.assign(new Error("SimpleFIN transport failed"), {
          code: "ECONNRESET",
        });
        this.health.recordFailure("simplefin", safe);
        this.health.logFailure(this.logger, "simplefin", "request", safe);
      }
      throw error instanceof SimplefinTransportError
        ? error
        : new SimplefinTransportError("transport");
    }
  }
}
