/**
 * Test email wiring against the configured SMTP provider.
 *
 * Usage:
 *   node scripts/test-email.js you@example.com
 *
 * Sends all three transactional emails (order confirmation, proof ready,
 * approval confirmation) to the supplied address using fake order data,
 * so you can confirm:
 *   - SMTP credentials are valid
 *   - Domain is verified (no spam folder)
 *   - From address, subject lines, and body HTML render correctly
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

(async () => {
  console.log(`SMTP_HOST: ${process.env.SMTP_HOST || '(not set — emails will only be logged, not sent)'}`);
  console.log(`Sending three test emails to: ${to}\n`);

  try {
    console.log('1/3 Order confirmation…');
    await emailService.sendOrderConfirmation(to, fakeOrder, statusPageUrl);

    console.log('2/3 Proof ready…');
    await emailService.sendProofEmail(to, fakeOrder, proofImageUrl, approvalPageUrl, statusPageUrl);

    console.log('3/3 Approval confirmation…');
    await emailService.sendApprovalConfirmation(to, fakeOrder, statusPageUrl);

    console.log('\nDone. Check the inbox at', to, '— you should see three emails within a minute.');
    console.log('Also check spam: if they land there, the DKIM record probably isn\'t verified yet.');
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
