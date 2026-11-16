import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import {
  resolveCategoryNamePaths,
  type CategoryNameRef,
} from "../../categories/category-name.util";
import { Category } from "../../categories/entities/category.entity";
import { tr } from "../../i18n/translate";
import { isRecord } from "../../common/helpers/is-record";

/**
 * A profile names its default categories by NAME (`defaultCategory`, ...) and
 * stores their ids (`defaultCategoryId`, ...): a person and a model write and
 * read names, the matcher and the proposal read ids. The writer converts name to
 * id inside the write's own transaction (`resolveParserCategoryNames`), the
 * reader id to name (`nameParserCategories`), so the JSON a client sees never
 * carries an id it cannot read.
 */
export const PARSER_CATEGORY_NAME_FIELDS = [
  { name: "defaultCategory", id: "defaultCategoryId" },
  { name: "shippingCategory", id: "shippingCategoryId" },
  { name: "feesCategory", id: "feesCategoryId" },
] as const;

/**
 * The definition with every category name replaced by the id of the user's
 * category of that name (case-insensitive; `Parent: Child` or a leaf that names
 * exactly one category). An unknown or ambiguous name is a 400 naming it. A
 * value that is not a string is left for the validator to report. The user's
 * categories are read through the caller's manager, so a refusal has written
 * nothing. The input is never mutated.
 */
export async function resolveParserCategoryNames(
  m: EntityManager,
  userId: string,
  input: unknown,
): Promise<unknown> {
  if (!isRecord(input)) return input;
  const wanted = PARSER_CATEGORY_NAME_FIELDS.filter(
    (field) => input[field.name] !== undefined,
  );
  if (wanted.length === 0) return input;
  const result: Record<string, unknown> = { ...input };
  const categories: CategoryNameRef[] = await m
    .getRepository(Category)
    .find({ where: { userId }, select: ["id", "name", "parentId"] });
  for (const field of wanted) {
    const value = input[field.name];
    delete result[field.name];
    if (value === null || value === "") continue;
    if (typeof value !== "string") {
      result[field.name] = value;
      continue;
    }
    const [match] = resolveCategoryNamePaths(categories, [value]);
    if (match.id === null) {
      throw new BadRequestException(
        match.failure === "ambiguous"
          ? tr(
              "errors.emailReceipts.parserCategoryNameAmbiguous",
              `The category "${value}" matches several categories (${match.candidates.join(", ")}). Use the full name, for example "Parent: Child".`,
              { name: value, candidates: match.candidates.join(", ") },
            )
          : tr(
              "errors.emailReceipts.parserCategoryNameUnknown",
              `The category "${value}" was not found. Use the name of one of your categories.`,
              { name: value },
            ),
      );
    }
    result[field.id] = match.id;
  }
  return result;
}

/**
 * The definition as a client reads it: each stored category id shown as the
 * category's qualified name under its name key. An id with no known category
 * stays as the id, so nothing is silently dropped.
 */
export function nameParserCategories(
  definition: Record<string, unknown>,
  categoryNames: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...definition };
  for (const field of PARSER_CATEGORY_NAME_FIELDS) {
    const id = definition[field.id];
    if (typeof id !== "string") continue;
    const name = categoryNames.get(id);
    if (name === undefined) continue;
    delete result[field.id];
    result[field.name] = name;
  }
  return result;
}
