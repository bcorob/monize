-- Contact information for payees: a free-text address, an email and a phone
-- number.
--
-- The address is one free-text field rather than structured parts: users paste
-- what they have, formats are locale-specific, and the only consumer is a link
-- that hands the whole string to the reader's maps application, which takes a
-- single query anyway.
--
-- The phone column is deliberately wide and unconstrained: international
-- numbers carry country codes, spaces, parentheses and extensions, so the value
-- is stored as written and only ever rendered or turned into a tel: link.

ALTER TABLE payees ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE payees ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE payees ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
