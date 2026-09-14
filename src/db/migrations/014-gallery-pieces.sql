-- Real customer pieces shown in the public gallery.
--
-- The homepage gallery has always been demo work: pieces rendered from invented
-- pets in scripts/generate-frame-mockups.js, committed as static JPEGs under
-- public/images/tributes/. Those stay exactly as they are.
--
-- A piece we actually made and shipped is different in kind, and the difference
-- is why this lives in the database instead of in the repo.
--
-- 1. It is somebody's dead pet. Terms of Service section 5 promises that if a
--    customer asks us to stop showing their tribute, we take it down. A JPEG
--    and a poem committed to a PUBLIC git repository cannot be taken down:
--    removing them from the working tree leaves them in history, on every fork
--    and every clone, permanently. Set gallery_slug to NULL and the piece is
--    gone from the site in one write, which is a promise we can actually keep.
--
-- 2. Publishing becomes data, not a deploy. The next real piece worth showing
--    is one UPDATE, with no commit, no build and no Vercel minute.
--
-- gallery_slug doubles as the flag and the public filename: non-NULL means
-- published, and the image is served from OUTPUT_DIR/gallery/<slug>.jpg on the
-- Railway volume. One column rather than a separate status, because a piece
-- with no slug has no URL and therefore cannot be shown, which is the same
-- thing "unpublished" means.
--
-- Nothing here duplicates order content. The name, dates and poem all come from
-- the order row itself, so a piece on the wall and a piece in the gallery can
-- never drift apart.

ALTER TABLE orders ADD COLUMN gallery_slug TEXT;
ALTER TABLE orders ADD COLUMN gallery_published_at TEXT;

-- Slugs are public URLs, so two orders must never claim the same one. The
-- index is partial by construction: SQLite treats NULLs as distinct, so every
-- unpublished order coexists happily while published slugs stay unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_gallery_slug ON orders(gallery_slug);
