/**
 * Test email wiring against the configured SMTP provider.
 *
 * Usage:
 *   node scripts/test-email.js you@example.com
 *
 * Sends the three CUSTOMER emails (order confirmation, proof ready, approval
 * confirmation) to the supplied address, PLUS the two ADMIN emails (the
 * "review needed" gate email and the "order stalled" alert) to ADMIN_EMAIL,
 * using fake order data — so you can confirm:
 *   - SMTP credentials are valid
 *   - Domain is verified (no spam folder)
 *   - From address, subject lines, and body HTML render correctly
 *   - You actually receive the admin "Review needed" email that every paid
 *     order depends on (nothing ships until you click approve in it)
 */

require('dotenv').config();

const emailService = require('../src/services/emailService');

const to = process.argv[2];
if (!to || !to.includes('@')) {
  console.error('Usage: node scripts/test-email.js you@example.com');
  process.exit(1);
}

// Deliberately fake data — "Order 00000000" so a smoke test is never
// mistaken for a real order.
const fakeOrder = {
  orderId: '00000000-1111-2222-3333-444455556666',
  templateName: 'pet-tribute',
  sku: 'framed-11x14',
  totalCents: 9700,
};

const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
const statusPageUrl = `${baseUrl}/order/test-token-not-real`;
const approvalPageUrl = `${baseUrl}/proof/test-token-not-real`;
const proofImageUrl = `${baseUrl}/img/sample-proof.jpg`;

// The admin "review needed" email reads real DB-shaped fields off the order
// (snake_case), so shape a matching object here.
const reviewOrder = {
  id: fakeOrder.orderId,
  email: to,
  total_cents: fakeOrder.totalCents,
  poem_text: 'You were the best of us, from your first clumsy steps\nto the quiet last ones — and you are still beside me.',
  fields_json: JSON.stringify({
    petName: 'Banjo',
    petType: 'Dog',
    breed: 'Golden Retriever',
    birthDate: '2014',
    passDate: '2026',
    personality: 'Goofy, loyal, obsessed with tennis balls',
    familyName: 'The Hamilton family',
  }),
};
const reviewUrl = `${baseUrl}/admin/review/test-token-not-real`;

(async () => {
  console.log(`SMTP_HOST:   ${process.env.SMTP_HOST || '(not set — emails will only be logged, not sent)'}`);
  console.log(`ADMIN_EMAIL: ${process.env.ADMIN_EMAIL || '(not set — the two ADMIN emails below will be SKIPPED)'}`);
  console.log(`\nSending 3 customer emails to: ${to}`);
  console.log(`Sending 2 admin emails to:    ${process.env.ADMIN_EMAIL || '(skipped)'}\n`);

  try {
    console.log('1/5 [customer] Order confirmation…');
    await emailService.sendOrderConfirmation(to, fakeOrder, statusPageUrl);

    console.log('2/5 [customer] Proof ready…');
    await emailService.sendProofEmail(to, fakeOrder, proofImageUrl, approvalPageUrl, statusPageUrl);

    console.log('3/5 [customer] Approval confirmation…');
    await emailService.sendApprovalConfirmation(to, fakeOrder, statusPageUrl);

    console.log('4/5 [admin] Review needed (the approval gate email)…');
    await emailService.sendReviewRequest(reviewOrder, { reviewUrl, proofImageUrl });

    console.log('5/5 [admin] Order stalled alert…');
    await emailService.sendAdminAlert(
      'Order 00000000 stalled: proof generation failed (TEST)',
      'This is a smoke-test alert. On a real order this fires only if proof ' +
      'generation fails, so a paid order is never silently stuck.\n\n' +
      `Review page: ${reviewUrl}`
    );

    console.log(`\nDone. Customer inbox: ${to} → 3 emails.`);
    if (process.env.ADMIN_EMAIL) {
      console.log(`Admin inbox: ${process.env.ADMIN_EMAIL} → 2 emails, including "Review needed — Order 00000000".`);
      console.log('→ If you get the "Review needed" one, the approval alert you rely on works.');
    } else {
      console.log('ADMIN_EMAIL was not set, so the 2 admin emails were skipped. Set it and re-run to test the approval alert.');
    }
    console.log('Also check spam: if anything lands there, the DKIM record probably isn\'t verified yet.');
    process.exit(0);
  } catch (err) {
    console.error('\nFailed:', err.message);
    if (err.code === 'EAUTH') {
      console.error('  → Authentication failed. Check SMTP_USER and SMTP_PASS in .env.');
    } else if (err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT') {
      console.error('  → Could not reach SMTP server. Check SMTP_HOST and SMTP_PORT.');
    }
    process.exit(1);
  }
})();
