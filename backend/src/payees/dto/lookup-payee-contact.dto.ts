import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { LOOKUP_CONTEXT_MAX_LENGTH } from "../lookup/lookup-context";

/**
 * Body of `POST /payees/lookup-contact`: the name the form holds, plus
 * whatever else it holds. The extra fields are context, never stored by this
 * endpoint -- they tell the lookup which organisation and which of its
 * locations is meant, so a form carrying "Toronto" does not come back with a
 * branch in another country.
 *
 * Every field is optional and every one is a plain string: these are the
 * form's current values, which may be half-typed and are not validated as
 * contact details here (a malformed address is still a usable clue). Caps
 * match the columns' own, so nothing longer than a storable value is sent.
 */
export class LookupPayeeContactDto {
  @ApiProperty({ example: "Starbucks", description: "Name of the payee" })
  @IsString()
  @MinLength(1)
  // Mirrors CreatePayeeDto.name: a name the form could not save is not
  // worth looking up.
  @MaxLength(100)
  @SanitizeHtml()
  name: string;

  @ApiPropertyOptional({ description: "Website already on the form" })
  @IsOptional()
  @IsString()
  @MaxLength(LOOKUP_CONTEXT_MAX_LENGTH.website)
  @SanitizeHtml()
  website?: string;

  @ApiPropertyOptional({
    description: "Address already on the form; may be a bare city",
    example: "Toronto",
  })
  @IsOptional()
  @IsString()
  @MaxLength(LOOKUP_CONTEXT_MAX_LENGTH.address)
  @SanitizeHtml()
  address?: string;

  @ApiPropertyOptional({ description: "Email already on the form" })
  @IsOptional()
  @IsString()
  @MaxLength(LOOKUP_CONTEXT_MAX_LENGTH.email)
  @SanitizeHtml()
  email?: string;

  @ApiPropertyOptional({ description: "Phone already on the form" })
  @IsOptional()
  @IsString()
  @MaxLength(LOOKUP_CONTEXT_MAX_LENGTH.phone)
  @SanitizeHtml()
  phone?: string;

  @ApiPropertyOptional({ description: "Notes already on the form" })
  @IsOptional()
  @IsString()
  @MaxLength(LOOKUP_CONTEXT_MAX_LENGTH.notes)
  @SanitizeHtml()
  notes?: string;
}
