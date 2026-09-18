-- A photo of the piece where it hangs.
--
-- The single most convincing thing a stranger can see is not a star or a
-- sentence but somebody's own frame on somebody's own wall. So the review form
-- asks for one. It is optional: a rating without a photo is still a review.
--
-- The column holds a path relative to the uploads volume, written only after
-- the image has been normalised (rotated upright, resized, and stripped of
-- every byte of metadata, because a phone photo of a living room carries the
-- GPS position of that living room). The file is never served from a public
-- folder; a gated route hands it out only while the review is published with
-- consent, so an unpublished photo is unreachable from outside.

ALTER TABLE customer_reviews ADD COLUMN photo_path TEXT;
