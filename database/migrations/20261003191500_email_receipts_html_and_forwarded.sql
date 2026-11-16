-- Stored HTML part and forwarded-mail facts for email receipts
-- (docs/future-plans/email-receipts.md sections 3.9 and 4, forwarded emails).
--
-- Expand only, so the previous release keeps working against this schema during
-- a rolling deploy: every new column is nullable and the previous release never
-- writes them, which the new CHECK accepts (NULL passes).
--
--   body_html        the HTML part of the message as the sender wrote it, capped
--                    at 1,000,000 characters. It is shown only inside a sandboxed,
--                    script-less, network-less frame (the detail dialog) and is
--                    never parsed, searched or sent to a model: body_text stays the
--                    one text every parser and prompt reads.
--   forwarded_by     the mailbox From when the message was a forward of an order
--                    confirmation; from_address / from_domain / subject then hold
--                    the ORIGINAL sender and subject, so parser selection reads the
--                    shop and not the user's own address.
--   original_sent_at the date the shop sent the order, parsed best-effort from the
--                    forwarded header block. The match window is centred on
--                    COALESCE(original_sent_at, received_at): a forward arrives
--                    days after the purchase, the bank transaction does not.

ALTER TABLE email_receipts ADD COLUMN IF NOT EXISTS body_html TEXT;
ALTER TABLE email_receipts ADD COLUMN IF NOT EXISTS forwarded_by VARCHAR(320);
ALTER TABLE email_receipts ADD COLUMN IF NOT EXISTS original_sent_at TIMESTAMPTZ;

ALTER TABLE email_receipts DROP CONSTRAINT IF EXISTS ck_email_receipts_body_html_length;
ALTER TABLE email_receipts
    ADD CONSTRAINT ck_email_receipts_body_html_length
    CHECK (body_html IS NULL OR char_length(body_html) <= 1000000);
