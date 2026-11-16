import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";
import { PayeeLookupPreferredSource } from "../entities/payee-lookup-settings.entity";

/** The two orders, as data, so the DTO and the column's CHECK cannot drift. */
export const PAYEE_LOOKUP_PREFERRED_SOURCES: readonly PayeeLookupPreferredSource[] =
  ["google-places", "ai"];
import { GOOGLE_PLACES_CAP } from "../google-places/google-places-cap";
import { IsSendableApiKey } from "../google-places/google-places-key";

/** Surrounding whitespace is a paste artifact, never part of a key. Trimming
 *  it also turns an all-whitespace value into the empty string, which is the
 *  one value that means "remove the stored key" rather than "store this". */
const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

/**
 * What the Payee lookup settings card may change.
 *
 * Every field is optional and absence means "leave it alone", which is what
 * lets the card save the on/off switch without resending a key it cannot read
 * back. `apiKey: ""` is the one meaningful empty string: it clears the stored
 * key, and `isSendableApiKey` admits it for that reason. The only thing
 * asserted about a key is that it can be SENT -- its format is Google's
 * business, and the only honest test of one is the Test button, which asks
 * Google.
 *
 * The cap bounds come from `GOOGLE_PLACES_CAP`, the same constant the CHECK
 * constraint in migration 188 and the settings form derive from.
 */
export class UpdatePayeeLookupSettingsDto {
  @ApiPropertyOptional({
    description: "Whether Google Places answers payee contact lookups",
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      "Google Places API key. Empty string removes the stored key; omit to keep it. Never returned.",
  })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(2000)
  @IsSendableApiKey()
  apiKey?: string;

  @ApiPropertyOptional({
    description: "Whether the AI provider answers payee contact lookups",
  })
  @IsOptional()
  @IsBoolean()
  aiEnabled?: boolean;

  @ApiPropertyOptional({ description: "Whether the monthly cap is enforced" })
  @IsOptional()
  @IsBoolean()
  capEnabled?: boolean;

  @ApiPropertyOptional({
    description: "Requests allowed per calendar month",
    minimum: GOOGLE_PLACES_CAP.min,
    maximum: GOOGLE_PLACES_CAP.max,
    default: GOOGLE_PLACES_CAP.default,
  })
  @IsOptional()
  @IsInt()
  @Min(GOOGLE_PLACES_CAP.min)
  @Max(GOOGLE_PLACES_CAP.max)
  monthlyCap?: number;

  @ApiPropertyOptional({
    description: "Which source answers a lookup first",
    enum: PAYEE_LOOKUP_PREFERRED_SOURCES,
  })
  @IsOptional()
  @IsIn(PAYEE_LOOKUP_PREFERRED_SOURCES)
  preferredSource?: PayeeLookupPreferredSource;

  @ApiPropertyOptional({
    description:
      "Which AI provider answers a lookup. Null clears the pin back to every active provider in priority order.",
  })
  @IsOptional()
  // Explicitly nullable: null is the meaningful "no preference" value, and
  // @IsUUID alone would reject it. Absent still means "leave it alone".
  @ValidateIf((_o, value) => value !== null)
  @IsUUID()
  aiProviderConfigId?: string | null;
}

/** The draft key the Test button checks, when the user has typed a new one. */
export class TestPayeeLookupKeyDto {
  @ApiPropertyOptional({
    description:
      "Key to test. Omit to test the key already stored (or the operator's).",
  })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(2000)
  @IsSendableApiKey()
  apiKey?: string;
}
