import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as client from "openid-client";

export interface OidcTokenResult {
  access_token: string;
  sub: string;
  /** "amr" (Authentication Methods References) claim from the ID token. */
  amr?: string[];
  /** "acr" (Authentication Context Class Reference) claim from the ID token. */
  acr?: string;
  /**
   * "auth_time" claim: when the end-user actually authenticated, in seconds
   * since the epoch. Requested via `max_age`, and what separates a fresh
   * credential prompt from a reused SSO session. Absent when the provider does
   * not supply it, which the re-authentication flow treats as "not fresh"
   * rather than as "fine".
   */
  auth_time?: number;
}

@Injectable()
export class OidcService implements OnModuleInit {
  private config: client.Configuration | null = null;
  private readonly logger = new Logger(OidcService.name);
  private _enabled = false;
  private callbackUrl: string;

  constructor(private configService: ConfigService) {
    this.callbackUrl =
      this.configService.get<string>("OIDC_CALLBACK_URL") ||
      "http://localhost:3001/api/v1/auth/oidc/callback";
  }

  async onModuleInit() {
    await this.initialize();
  }

  get enabled(): boolean {
    return this._enabled;
  }

  async initialize(): Promise<boolean> {
    const issuerUrl = this.configService.get<string>("OIDC_ISSUER_URL");
    const clientId = this.configService.get<string>("OIDC_CLIENT_ID");
    const clientSecret = this.configService.get<string>("OIDC_CLIENT_SECRET");

    if (!issuerUrl || !clientId || !clientSecret) {
      this.logger.log("OIDC not configured - OIDC login disabled");
      return false;
    }

    try {
      this.config = await client.discovery(
        new URL(issuerUrl),
        clientId,
        clientSecret,
      );
      this.logger.log(
        `Discovered OIDC issuer: ${this.config.serverMetadata().issuer}`,
      );

      this._enabled = true;
      this.logger.log("OIDC initialized successfully");
      return true;
    } catch (error) {
      this.logger.error(`Failed to initialize OIDC: ${error.message}`);
      return false;
    }
  }

  /**
   * Generate authorization URL for OIDC login.
   *
   * `forceReauthentication` adds `prompt=login` and `max_age=0`, which ask the
   * provider to challenge the user again rather than silently re-using its
   * existing session. That is the whole point of a re-authentication: without it
   * the round trip is a redirect the user never notices, and it proves nothing
   * beyond what the Monize session already proved (P2-005). Both parameters are
   * sent because providers honour them unevenly -- `prompt=login` is the RFC 6749
   * spelling, `max_age=0` the OIDC Core one.
   */
  getAuthorizationUrl(
    state: string,
    nonce: string,
    { forceReauthentication = false }: { forceReauthentication?: boolean } = {},
  ): string {
    if (!this.config) {
      throw new Error("OIDC client not initialized");
    }

    const url = client.buildAuthorizationUrl(this.config, {
      redirect_uri: this.callbackUrl,
      scope: "openid profile email",
      state,
      nonce,
      ...(forceReauthentication ? { prompt: "login", max_age: "0" } : {}),
    });

    return url.href;
  }

  /**
   * Handle the callback from the OIDC provider
   */
  async handleCallback(
    params: Record<string, string>,
    state: string,
    nonce: string,
  ): Promise<OidcTokenResult> {
    if (!this.config) {
      throw new Error("OIDC client not initialized");
    }

    // Build the full callback URL with query params for v6's authorizationCodeGrant
    const callbackUrl = new URL(this.callbackUrl);
    for (const [key, value] of Object.entries(params)) {
      callbackUrl.searchParams.set(key, value);
    }

    const tokens = await client.authorizationCodeGrant(
      this.config,
      callbackUrl,
      {
        expectedState: state,
        expectedNonce: nonce,
      },
    );

    if (!tokens.access_token) {
      throw new Error("No access token received from OIDC provider");
    }

    const claims = tokens.claims();
    if (!claims?.sub) {
      throw new Error("No subject claim in ID token");
    }

    const rawAmr = (claims as Record<string, unknown>).amr;
    const amr = Array.isArray(rawAmr)
      ? rawAmr.filter((v): v is string => typeof v === "string")
      : undefined;
    const rawAcr = (claims as Record<string, unknown>).acr;
    const acr = typeof rawAcr === "string" ? rawAcr : undefined;
    const rawAuthTime = (claims as Record<string, unknown>).auth_time;
    const auth_time =
      typeof rawAuthTime === "number" && Number.isFinite(rawAuthTime)
        ? rawAuthTime
        : undefined;

    return {
      access_token: tokens.access_token,
      sub: claims.sub,
      amr,
      acr,
      auth_time,
    };
  }

  /**
   * Get user info from the OIDC provider
   */
  async getUserInfo(
    accessToken: string,
    expectedSubject: string,
  ): Promise<Record<string, unknown>> {
    if (!this.config) {
      throw new Error("OIDC client not initialized");
    }

    const userInfo = await client.fetchUserInfo(
      this.config,
      accessToken,
      expectedSubject,
    );

    return userInfo as unknown as Record<string, unknown>;
  }

  /**
   * Generate a random state value for CSRF protection
   */
  generateState(): string {
    return client.randomState();
  }

  /**
   * Generate a random nonce value for replay protection
   */
  generateNonce(): string {
    return client.randomNonce();
  }
}
