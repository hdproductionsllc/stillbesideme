/**
 * Storage — date-organized file storage for customer uploads.
 * uploads/2026/02/19/{uuid}.ext
 */

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'uploads');

/** Get today's storage directory, creating it if needed */
function getDayDir() {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dir = path.join(UPLOADS_ROOT, year, month, day);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Generate a unique filename preserving extension */
function generateFilename(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  return `${uuidv4()}${ext}`;
}

/** Store a buffer to the date-organized directory. Returns { filename, relativePath, absolutePath } */
function storeFile(buffer, originalName) {
  const dir = getDayDir();
  const filename = generateFilename(originalName);
  const absolutePath = path.join(dir, filename);
  fs.writeFileSync(absolutePath, buffer);

  // Relative path from uploads root (for URL serving)
  const relativePath = path.relative(UPLOADS_ROOT, absolutePath).replace(/\\/g, '/');

  return { filename, relativePath, absolutePath };
}

/** Store a thumbnail alongside the original */
function storeThumbnail(buffer, originalFilename) {
  const dir = path.dirname(
    path.join(UPLOADS_ROOT, ...getDayDir().split(path.sep).slice(-3))
  );
  // Actually store in same day directory
  const dayDir = getDayDir();
  const ext = '.jpg'; // thumbnails always JPEG
  const baseName = path.basename(originalFilename, path.extname(originalFilename));
  const thumbName = `${baseName}-thumb${ext}`;
  const absolutePath = path.join(dayDir, thumbName);
  fs.writeFileSync(absolutePath, buffer);

  const relativePath = path.relative(UPLOADS_ROOT, absolutePath).replace(/\\/g, '/');
  return { filename: thumbName, relativePath, absolutePath };
}

/** Resolve a relative upload path to absolute */
function resolve(relativePath) {
  return path.join(UPLOADS_ROOT, relativePath);
}

/** Get the URL path for a relative upload path */
function toUrl(relativePath) {
  return `/uploads/${relativePath}`;
}

module.exports = { storeFile, storeThumbnail, resolve, toUrl, generateFilename };
