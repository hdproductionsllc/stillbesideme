/**
 * Saved designs: "Email me my design", and the way back into it.
 *
 *   POST /api/designs             save (or update) this visitor's design, and
 *                                 email them the link when they ask for it
 *   GET  /api/designs/:token      the saved design, for the designer to restore
 *   GET  /d/:token/photo          their pet's photo, for the email to show
 *   GET  /d/:token/stop           "stop emails about this design" (confirm page)
 *   POST /d/:token/stop           ...and the switch itself
 *
 * Why a design needs to exist on the server at all: the designer keeps its
 * state in sessionStorage (one tab) and the photo record in the server session
 * (one browser). A link emailed to someone who then opens it on their phone
 * would find neither. A saved design carries both, so restoring it rebuilds the
 * designer exactly AND re-attaches the photo to the new session, which is what
 * lets the proof render and checkout go through on the new device.
 *
 * A session remembers which design it is building (req.session.designTokens,
 * per template), so every later save from the same visitor, including the
 * quiet one the proof step makes, updates one row instead of scattering copies.
 *
 * The token is the only key. It is a v4 UUID, never returned by POST (the
 * visitor gets it by email, which is the point), and GET never returns the
 * email address stored against it.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const storage = require('../services/storage');

const router = express.Router();

const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');
const UPLOADS_ROOT = path.resolve(storage.resolve(''));

// The designer's state is a few KB (fields, poem versions, colors, ratios).
// Anything near this ceiling is not a design.
const MAX_STATE_BYTES = 256 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_ORDER_STATUSES = ['draft', 'pending_payment'];

// Saves happen on every proof and when the tab is hidden, so the general
// ceiling is generous. Sending an email is the part that could be abused (to
// mail strangers), so requests carrying an address get a much tighter one.
const saveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: 'Too many saves. Please give it a minute and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many emails requested. Please try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !(req.body && req.body.email),
});

function remindersEnabled() {
  return process.env.DESIGN_REMINDERS_ENABLED === 'true';
}

function baseUrl() {
  return process.env.BASE_URL || 'http://localhost:3001';
}

/** A design row that has not expired, or null. */
function findLive(db, token) {
  if (!token || !TOKEN_RE.test(token)) return null;
  return db.get(
    `SELECT * FROM saved_designs WHERE token = ? AND expires_at > datetime('now')`,
    [token]
  );
}

function templateExists(templateId) {
  return /^[a-z0-9-]{1,60}$/.test(templateId)
    && fs.existsSync(path.join(TEMPLATES_DIR, `${templateId}.json`));
}

/** The pet's name as the designer holds it, for the email subject. */
function petNameFrom(state) {
  const fields = (state && state.fields) || {};
  return String(fields.petName || fields.name || '').trim().slice(0, 80);
}

/** The photo record the email shows: the main photo, else the first one. */
function primaryPhoto(photos) {
  if (!photos || typeof photos !== 'object') return null;
  return photos.main || Object.values(photos)[0] || null;
}

/** Absolute path of an upload, or null if it would escape the uploads folder. */
function safeUploadPath(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') return null;
  const abs = path.resolve(storage.resolve(relativePath));
  if (!abs.startsWith(UPLOADS_ROOT + path.sep)) return null;
  return abs;
}

/**
 * The design's photo records whose files are still on disk, or null.
 *
 * The session is only a cache of these. A session write can lose a race with
 * the page's other requests (a reopened page fires many at once), so anything
 * that needs the photos of a reopened design, the proof step included, asks
 * for them by token here rather than trusting the session to have kept them.
 */
function photosForDesign(db, token, templateId) {
  const row = findLive(db, token);
  if (!row || (templateId && row.template_id !== templateId)) return null;
  const live = {};
  for (const [slotId, p] of Object.entries(safeParse(row.photos_json) || {})) {
    const abs = p && safeUploadPath(p.originalPath);
    if (abs && fs.existsSync(abs)) live[slotId] = p;
  }
  return Object.keys(live).length ? live : null;
}

/** Links an email about this design carries. */
function linksFor(row) {
  const base = baseUrl();
  const hasPhoto = !!primaryPhoto(safeParse(row.photos_json));
  return {
    resumeUrl: `${base}/customize/${row.template_id}?design=${row.token}`,
    photoUrl: hasPhoto ? `${base}/d/${row.token}/photo` : null,
    stopUrl: `${base}/d/${row.token}/stop`,
  };
}

function safeParse(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch (e) { return null; }
}

/**
 * POST /api/designs
 *
 * Body: { templateId, state, email?, orderId?, designToken? }
 *   state       — the designer's own saved state, exactly as it keeps it
 *   email       — present only when the visitor asked for the design by email
 *   orderId     — present when the proof step saves quietly, to link the draft
 *   designToken — present on a page reopened from a saved-design link
 *
 * Returns: { saved: true, emailed: boolean }
 */
router.post('/api/designs', saveLimiter, emailLimiter, async (req, res) => {
  const db = req.app.locals.db;
  const { templateId, state, orderId } = req.body || {};

  if (!templateExists(String(templateId || ''))) {
    return res.status(400).json({ error: 'Unknown design.' });
  }
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.templateId !== templateId) {
    return res.status(400).json({ error: 'Nothing to save yet.' });
  }
  const stateJson = JSON.stringify(state);
  if (Buffer.byteLength(stateJson) > MAX_STATE_BYTES) {
    return res.status(413).json({ error: 'That design is too large to save.' });
  }

  let email = null;
  if (req.body.email != null && req.body.email !== '') {
    email = String(req.body.email).trim().toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
  }

  // The photo records live in the session; a design saved from a session that
  // holds none (a restored design before any new upload) keeps what it had.
  const sessionPhotos = req.session && req.session.photos && Object.keys(req.session.photos).length
    ? JSON.stringify(req.session.photos)
    : null;

  // Only an open order that this very session is building may be linked.
  let linkOrderId = null;
  if (orderId) {
    const order = db.get(
      `SELECT id FROM orders WHERE id = ? AND session_id = ? AND status IN (${OPEN_ORDER_STATUSES.map(() => '?').join(',')})`,
      [String(orderId), req.sessionID, ...OPEN_ORDER_STATUSES]
    );
    if (order) linkOrderId = order.id;
  }

  try {
    // The design this visitor is building: the one their session remembers,
    // or the one the page says it was reopened from (the session may have
    // lost the note; the token itself is the proof of ownership).
    if (!req.session.designTokens) req.session.designTokens = {};
    let row = findLive(db, req.session.designTokens[templateId]);
    if (!row && req.body.designToken) {
      const linked = findLive(db, String(req.body.designToken));
      if (linked && linked.template_id === templateId) {
        row = linked;
        req.session.designTokens[templateId] = linked.token;
      }
    }

    if (row) {
      db.run(
        `UPDATE saved_designs SET
           state_json = ?,
           photos_json = COALESCE(?, photos_json),
           pet_name = ?,
           order_id = COALESCE(?, order_id),
           updated_at = datetime('now'),
           expires_at = datetime('now', '+90 days')
         WHERE id = ?`,
        [stateJson, sessionPhotos, petNameFrom(state), linkOrderId, row.id]
      );
    } else {
      const token = uuidv4();
      db.run(
        `INSERT INTO saved_designs (token, template_id, pet_name, state_json, photos_json, order_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [token, templateId, petNameFrom(state), stateJson, sessionPhotos, linkOrderId]
      );
      req.session.designTokens[templateId] = token;
    }
    row = findLive(db, req.session.designTokens[templateId]);

    // Email only when asked, and only once per address: a second press of the
    // button with the same address, or the quiet saves that follow, send
    // nothing. A different address is a new request and gets its own email.
    let emailed = false;
    if (email && (email !== row.email || !row.saved_email_sent_at)) {
      // The email says either "one reminder follows" or "we won't email you
      // again", depending on the switch at this moment, and that promise is
      // recorded on the row: a design saved while reminders were off never
      // gets one, however the switch is set later. Asking again is fresh
      // consent, so it lifts an earlier "stop". It does NOT clear
      // reminder_sent_at: one reminder per design, ever.
      const remindersOn = remindersEnabled();
      db.run(
        `UPDATE saved_designs SET email = ?, reminders_off = ?, saved_email_sent_at = NULL
          WHERE id = ?`,
        [email, remindersOn ? 0 : 1, row.id]
      );
      const emailService = require('../services/emailService');
      const result = await emailService.sendDesignSaved(email, {
        petName: row.pet_name,
        remindersOn,
        ...linksFor(row),
      });
      // A no-SMTP preview resolves without a messageId: not a send, not logged.
      if (result && result.messageId) {
        db.run(`UPDATE saved_designs SET saved_email_sent_at = datetime('now') WHERE id = ?`, [row.id]);
        emailed = true;
      }
    } else if (email && email === row.email) {
      emailed = true;   // already sent to this address; say so, send nothing
    }

    res.json({ saved: true, emailed });
  } catch (err) {
    console.error('Saved design error:', err.message);
    res.status(500).json({ error: 'We couldn’t save your design just now. Please try again.' });
  }
});

/**
 * GET /api/designs/:token
 *
 * Returns { templateId, state } and attaches the design's photos to THIS
 * session, so the proof and checkout work on whatever device opened the link.
 * 410 for an expired design, 404 for one that never existed.
 */
router.get('/api/designs/:token', (req, res) => {
  const db = req.app.locals.db;
  const token = String(req.params.token || '');
  const row = findLive(db, token);

  if (!row) {
    const expired = TOKEN_RE.test(token)
      && db.get('SELECT 1 FROM saved_designs WHERE token = ?', [token]);
    return res.status(expired ? 410 : 404).json({
      error: expired
        ? 'This saved design has expired. We keep designs for 90 days.'
        : 'We couldn’t find that saved design.',
      code: expired ? 'expired' : 'not_found',
    });
  }

  const state = safeParse(row.state_json);
  if (!state) return res.status(404).json({ error: 'We couldn’t find that saved design.', code: 'not_found' });

  // Re-attach only photos whose files are still on disk. A missing file leaves
  // the upload zone open in the designer rather than a broken proof later.
  const live = photosForDesign(db, row.token);
  if (live) req.session.photos = live;

  if (!req.session.designTokens) req.session.designTokens = {};
  req.session.designTokens[row.template_id] = row.token;

  res.set('Cache-Control', 'no-store');
  res.json({ templateId: row.template_id, state });
});

/** GET /d/:token/photo — the pet's photo (thumbnail) for the email. */
router.get('/d/:token/photo', (req, res) => {
  const row = findLive(req.app.locals.db, String(req.params.token || ''));
  const photo = row && primaryPhoto(safeParse(row.photos_json));
  const abs = photo && safeUploadPath(photo.thumbnailPath || photo.originalPath);
  if (!abs || !fs.existsSync(abs)) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400');
  res.set('X-Robots-Tag', 'noindex, nofollow, noimageindex');
  res.sendFile(abs);
});

function stopPage(title, body, form) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} | Still Beside Me</title>
<style>
  body{margin:0;background:#FAF8F5;font-family:system-ui,-apple-system,sans-serif;color:#2C2C2C}
  main{max-width:480px;margin:12vh auto;padding:32px 24px;background:#fff;border-radius:12px;text-align:center}
  h1{font-family:Georgia,serif;font-weight:400;font-size:1.5rem;margin:0 0 16px}
  p{line-height:1.6;margin:0 0 20px}
  button{background:#8B9D83;color:#fff;border:0;border-radius:8px;padding:12px 32px;font-size:1rem;font-weight:600;cursor:pointer}
  a{color:#6F8268}
</style></head><body><main>
<h1>${title}</h1><p>${body}</p>${form || ''}
<p><a href="/">Still Beside Me</a></p>
</main></body></html>`;
}

/**
 * GET shows a button rather than acting: mail scanners follow every link in
 * an email, and a GET that switched reminders off would be pressed by them.
 */
router.get('/d/:token/stop', (req, res) => {
  const token = String(req.params.token || '');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  if (!TOKEN_RE.test(token)) return res.status(404).send(stopPage('Link not found', 'We couldn’t find that design.'));
  res.send(stopPage(
    'Stop emails about this design?',
    'We won’t send you anything more about it. Your design stays saved, and the link in your email still opens it.',
    `<form method="POST" action="/d/${token}/stop"><button type="submit">Stop emails</button></form>`
  ));
});

router.post('/d/:token/stop', (req, res) => {
  const token = String(req.params.token || '');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  if (TOKEN_RE.test(token)) {
    req.app.locals.db.run('UPDATE saved_designs SET reminders_off = 1 WHERE token = ?', [token]);
  }
  res.send(stopPage('Done', 'We won’t email you about this design again.'));
});

module.exports = router;
module.exports.linksFor = linksFor;
module.exports.photosForDesign = photosForDesign;
