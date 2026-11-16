-- Per-category override for the client-side automatic amount sign (issue
-- #1553): a category can turn off "income categories make the amount
-- positive, expense categories make it negative" for amounts typed against
-- it. Nullable with no default so every existing row keeps today's
-- behaviour; NULL means "inherit from the nearest ancestor that has an
-- explicit value, or on for a root with none". Never forced or cascaded
-- like is_income -- only the *effective* value (resolved at read time) is
-- inherited.
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS auto_sign BOOLEAN;
