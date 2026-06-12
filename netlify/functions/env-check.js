'use strict';
// TEMPORARY — delete after check
exports.handler = async function() {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      STRIPE_CAPGEN_WEBHOOK_SECRET:  !!process.env.STRIPE_CAPGEN_WEBHOOK_SECRET,
      STRIPE_WEBHOOK_SECRET_TEST:    !!process.env.STRIPE_WEBHOOK_SECRET_TEST,
      test_secret_prefix: process.env.STRIPE_WEBHOOK_SECRET_TEST
        ? process.env.STRIPE_WEBHOOK_SECRET_TEST.slice(0, 10) + '...'
        : 'NOT SET',
    }),
  };
};
