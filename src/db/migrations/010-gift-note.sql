-- Gift note card + recipient-facing tribute page.
--
-- gift_token: a THIRD capability token, deliberately separate from proof_token
-- and admin_token. proof_token grants proof-approval and print-file download
-- and its status page exposes the order total, the buyer's masked email, and
-- the buyer's shipping city/state — none of which a gift recipient may see
-- (they would learn what their friend paid). gift_token grants read-only
-- access to a stripped tribute projection and nothing else. It is printed as
-- a QR code on the note card and texted by the sender, so it travels further
-- than either existing token and must carry less authority.
--
-- note_file_url: the rendered A4 note card, hosted under /output like
-- print_file_url and uv_file_url, and fetched anonymously by Luma as a
-- `printouts` entry. The note TEXT itself stays in fields_json.giftNote —
-- it has no query, index, or lifecycle needs of its own.
ALTER TABLE orders ADD COLUMN gift_token TEXT;
ALTER TABLE orders ADD COLUMN note_file_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_gift_token ON orders(gift_token);
