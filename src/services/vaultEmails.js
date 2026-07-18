/**
 * Vault occasion emails — birthday, gotcha day, anniversary of passing.
 *
 * These are the emails the Story Vault date engine sends to a family that opted
 * in. They reuse emailService's brand shell (wrapHtml) and dispatcher (send),
 * so they log-and-noop without SMTP exactly like every other email in the app.
 *
 * Voice: warm and restrained, in the register of the rest of the site — short
 * sentences, a serif heading, no exclamation marks, and no overreach (we don't
 * claim to grieve the pet, only to hold the day beside the family). Every email
 * carries: one short paragraph, a single CTA to the story page, a quiet line
 * that a new verse / ornament / portrait can be added there, and the one-click
 * unsubscribe the vault route honors.
 */

const emailService = require('./emailService');

/**
 * The unsubscribe URL every vault email must carry. It's a plain GET that sets
 * opt_out=1 on the vault (see src/routes/vault.js), so it works from an email
 * client with no JavaScript.
 */
function unsubscribeUrl(vault, baseUrl) {
  return `${baseUrl}/api/vault/${vault.token}/unsubscribe`;
}

/**
 * Shared occasion card: serif heading, one short paragraph, the single
 * "Visit {name}'s page" CTA, the soft add-something line, and the quiet
 * unsubscribe footer. Every occasion renders through here so the voice and the
 * required unsubscribe link stay identical across all three.
 */
function occasionHtml(vault, baseUrl, heading, paragraph) {
  const name = vault.pet_name || 'your companion';
  const storyUrl = `${baseUrl}/story/${vault.token}`;
  const unsub = unsubscribeUrl(vault, baseUrl);

  return emailService.wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;margin-bottom:24px;">
      <h1 style="font-family:Georgia,serif;font-size:1.6rem;font-weight:400;color:#2C2C2C;text-align:center;margin:0 0 20px;">
        ${heading}
      </h1>
      <p style="color:#2C2C2C;line-height:1.7;margin:0 0 28px;text-align:center;">
        ${paragraph}
      </p>
      <div style="text-align:center;margin-bottom:20px;">
        <a href="${storyUrl}"
           style="display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:1rem;">
          Visit ${name}'s page
        </a>
      </div>
      <p style="text-align:center;color:#9B9590;font-size:0.9rem;line-height:1.6;margin:0 0 24px;">
        Whenever it feels right, a new verse, an ornament, or a portrait can be added to ${name}'s page.
      </p>
      <p style="text-align:center;color:#9B9590;font-size:0.8rem;line-height:1.6;margin:24px 0 0;padding-top:20px;border-top:1px solid #E8E4DF;">
        If these remembrances are more painful than sweet, we understand &ndash;
        <a href="${unsub}" style="color:#9B9590;">no more emails</a>.
      </p>
    </div>
  `);
}

/** Birthday email. */
async function sendBirthdayEmail(vault, baseUrl) {
  const name = vault.pet_name || 'your companion';
  const html = occasionHtml(
    vault, baseUrl,
    `${name}'s birthday`,
    `Today is ${name}'s birthday. However you choose to hold the day, we wanted to mark it quietly alongside you.`
  );
  return emailService.send(vault.email, `${name}'s birthday`, html);
}

/** Gotcha day (adoption anniversary) email. */
async function sendGotchaEmail(vault, baseUrl) {
  const name = vault.pet_name || 'your companion';
  const html = occasionHtml(
    vault, baseUrl,
    `The day ${name} came home`,
    `Today is ${name}'s gotcha day &ndash; the day they first came home to you. A small anniversary, and a good one to sit with.`
  );
  return emailService.send(vault.email, `The day ${name} came home`, html);
}

/**
 * Anniversary-of-passing email. When we know the year of passing we name the
 * span ("It has been N years since {name} crossed"); otherwise we keep it
 * neutral. The wording stays gentle and avoids claiming a grief that is theirs.
 */
async function sendAnniversaryEmail(vault, baseUrl) {
  const name = vault.pet_name || 'your companion';
  const years = vault.passing_year
    ? new Date().getFullYear() - Number(vault.passing_year)
    : null;
  const span = years && years > 0
    ? `It has been ${years} ${years === 1 ? 'year' : 'years'} since ${name} crossed.`
    : `Today marks another year since ${name} crossed.`;
  const html = occasionHtml(
    vault, baseUrl,
    `Remembering ${name}`,
    `${span} We are keeping the day quietly, and thinking of you.`
  );
  return emailService.send(vault.email, `Remembering ${name}`, html);
}

module.exports = {
  sendBirthdayEmail,
  sendGotchaEmail,
  sendAnniversaryEmail,
};
