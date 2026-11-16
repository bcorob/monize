---
title: "A field's InfoTooltip goes beside its label, not its box; DateInput and Select need their own label row for that"
author: Ken
date: 2026-10-27
branch: feat/payroll-deductions
id: l-3d5572a5
scope: repo
status: active
src: agent
---

## Decided
- On the payroll form Ken asked for every help tooltip beside the field's label text, never beside the input, and for side-by-side money boxes to share a baseline. The pattern is MortgageFields': a `flex items-center mb-1` row holding `<label htmlFor>` + `InfoTooltip`, then the input with `id` and no `label` prop. Giving every column that same label-row-then-input shape is what aligns the boxes.
- A row's remove control is the shared `RemoveSplitLineButton` (transactions/SplitLineButtons.tsx) pinned `absolute top-2 right-2` on a `relative` card, not a grey `×` beside a field.
- A `CurrencyInput` for a bill's money carries `prefix={getCurrencySymbol(currencyCode)}`, as the transaction and mortgage forms do.

## Tried and ruled out
- Keeping `DateInput`'s own `label` and placing the tooltip after the component: the icon lands beside the box. `label` is a string, so the tooltip cannot ride inside it.

## Watch out
- `DateInput` rendered without `label` loses its keyboard-shortcut hint (`DateShortcutTooltip` is drawn inside its label block); pass `id` or the input has none.
- Wording Ken reverted: the New Rule button, modal title and empty-state button stay singular even though the form writes several rules; a plural-looking count belongs in the toast only.
