/**
 * The space a labelled field gives its label, reserved above a control that has
 * none.
 *
 * A button standing beside a labelled field is the height of the *field*, not
 * of the field plus its label. Reserving the label's own space above it means
 * what is left to stretch into is exactly the input's height, with no magic
 * number that a font or padding change would silently invalidate --
 * `self-stretch` alone measures from the top of the label and stands a label
 * taller, and matching the field's padding by hand drifts the first time either
 * control's type scale changes.
 *
 * Use it with a `flex flex-col` wrapper and a `flex-1 items-stretch` row around
 * the control, the way `AccountBalancesControls` and the loan amortization
 * toolbar do.
 */
export function LabelSpacer() {
  return (
    <span aria-hidden="true" className="mb-1 block text-sm font-medium">
      {'\u00a0'}
    </span>
  );
}
