import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import {
  HIDEABLE_TABLE_COLUMNS,
  isHiddenColumnTable,
} from "../hidden-table-columns";

// The map is keyed by table kind; each value lists that kind's hidden column
// ids. Anything outside the declared sets is refused, never dropped, so a
// client that sends an id the server does not know learns of it. Requiring
// every key to be a known kind also excludes `__proto__`, `constructor` and
// `prototype`. No duplicates bounds each list by its kind's list length.
function isHiddenList(value: unknown, allowed: readonly string[]): boolean {
  if (!Array.isArray(value)) return false;
  if (value.length > allowed.length) return false;

  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string") return false;
    if (!allowed.includes(id)) return false;
    if (seen.has(id)) return false;
    seen.add(id);
  }

  return true;
}

@ValidatorConstraint({ async: false })
export class IsHiddenTableColumnsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value !== "object" || Array.isArray(value)) return false;

    const map = value as Record<string, unknown>;
    for (const table of Object.keys(map)) {
      if (!isHiddenColumnTable(table)) return false;
      if (!isHiddenList(map[table], HIDEABLE_TABLE_COLUMNS[table])) {
        return false;
      }
    }

    return true;
  }

  defaultMessage(): string {
    return "hiddenTableColumns must be an object keyed by table kind (transactions, investmentHoldings, investmentRegister), each value an array of that table's hideable column ids without duplicates";
  }
}

export function IsHiddenTableColumns(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      constraints: [],
      validator: IsHiddenTableColumnsConstraint,
    });
  };
}
