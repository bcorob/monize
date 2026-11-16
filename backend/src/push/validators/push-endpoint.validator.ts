import { privatePushEndpoint } from "../unifiedpush-private-endpoints";
import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { validateUrlIsSafeWithin } from "../../ai/validators/safe-url.validator";

/** Longest endpoint accepted. Real ones sit well under 500 characters. */
export const MAX_PUSH_ENDPOINT_LENGTH = 1024;

/**
 * A push endpoint is a URL the server will make an outbound request to, on a
 * schedule, with a payload -- so it is an SSRF surface, and the comment thread
 * on discussion #1291 named it as one before any alternative transport exists.
 *
 * The private-address, metadata-endpoint, alternate-IP-encoding and
 * DNS-rebinding checks are `validateUrlIsSafe`'s, reused rather than restated:
 * the AI provider `baseUrl` field has needed exactly this since before push
 * did. What is added here is the protocol floor. `validateUrlIsSafe` admits
 * `http:` because a self-hosted model server may be plain HTTP on a LAN; a push
 * endpoint is issued by Mozilla, Google or Apple and is always `https:`, so
 * anything else is a forged value rather than a permissive deployment.
 *
 * The check runs under `validateUrlIsSafeWithin`'s deadline rather than
 * unbounded. It resolves the host, and a resolver that never answers would hold
 * this request -- one an authenticated caller may make twenty times a minute --
 * for the DNS retry budget, before validation has even returned its 400.
 */
@ValidatorConstraint({ async: true })
export class IsPushEndpointConstraint implements ValidatorConstraintInterface {
  async validate(value: unknown, args?: ValidationArguments): Promise<boolean> {
    if (typeof value !== "string") return false;
    if (value.length > MAX_PUSH_ENDPOINT_LENGTH) return false;

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    if (parsed.protocol !== "https:") return false;

    const transport = (args?.object as { transport?: string } | undefined)
      ?.transport;
    if (privatePushEndpoint(value, transport)) return true;
    return validateUrlIsSafeWithin(value);
  }

  defaultMessage(): string {
    return "endpoint must be an https URL on a publicly routable host";
  }
}

export function IsPushEndpoint(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      constraints: [],
      validator: IsPushEndpointConstraint,
    });
  };
}
