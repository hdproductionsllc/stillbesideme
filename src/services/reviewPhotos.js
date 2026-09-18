/**
 * Customer review photos: the piece, hung, in the customer's own home.
 *
 * One job in, one job out. `store()` takes whatever a phone produced and
 * leaves a single well-behaved JPEG on the uploads volume; `absolutePath()`
 * turns the stored relative path back into a file for the serving routes.
 *
 * Why the image is rebuilt rather than saved as sent:
 *
 *   - rotate(): phones record orientation as a tag rather than turning the
 *     pixels, and a sideways frame on a wall is worse than no photo.
 *   - resize(): the page needs at most 1600px on the long edge; a 12MB HEIC
 *     is not something to serve to every visitor of the reviews section.
 *   - metadata stripped: sharp drops EXIF on output unless told to keep it.
 *     A photo of a living room carries the GPS position of that living room,
 *     and we publish it next to the customer's first name. Keeping that would
 *     be indefensible.
 *
 * Files are keyed by order id because there is exactly one review per order
 * (UNIQUE index on customer_reviews.order_id), so the name cannot collide and a
 * re-submission after a refused insert simply overwrites its own leftover.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Same default server.js uses, so a bare `node server.js` and the Railway
// volume both land in the one place photos already live.
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
const SUBDIR = 'reviews';
const MAX_EDGE = 1600;

/** Guard: a stored path must stay inside the reviews folder. */
function absolutePath(photoPath) {
  if (!photoPath) return null;
  const abs = path.resolve(UPLOADS_DIR, photoPath);
  const root = path.resolve(UPLOADS_DIR, SUBDIR) + path.sep;
  return abs.startsWith(root) ? abs : null;
}

/**
 * Normalise and persist. Throws if the buffer is not an image sharp can read;
 * the route turns that into a kind 400 rather than saving half a review.
 *
 * @param {string} orderId
 * @param {Buffer} inputBuffer  raw upload
 * @returns {Promise<string>}   path relative to UPLOADS_DIR, for the DB column
 */
async function store(orderId, inputBuffer) {
  const relative = path.posix.join(SUBDIR, `${orderId}.jpg`);
  const dest = path.join(UPLOADS_DIR, SUBDIR, `${orderId}.jpg`);

  const jpeg = await sharp(inputBuffer)
    .rotate()
    .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, jpeg);
  return relative;
}

/** Best effort removal, for a submit that was refused after the file landed. */
function remove(photoPath) {
  const abs = absolutePath(photoPath);
  if (!abs) return;
  try { fs.unlinkSync(abs); } catch (err) { /* already gone is fine */ }
}

module.exports = { store, remove, absolutePath, UPLOADS_DIR, MAX_EDGE };
