import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsBoolean, IsOptional } from "class-validator";

/** A query-string boolean: exactly `true` or `false`, anything else refused. */
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === "true" ? true : value === "false" ? false : value;

/**
 * `POST /warranties/import` query. The preview is the default: a commit says
 * `dryRun=false`, so a client that forgets the flag writes nothing.
 */
export class ImportWarrantiesDto {
  @ApiPropertyOptional({
    default: true,
    description: "true validates and reports without writing",
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      "On a commit, import the valid rows and report the invalid ones instead of refusing the file",
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  skipInvalid?: boolean;
}
