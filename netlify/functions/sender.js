'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// sender.js — RETIRED (Change Order 1, Section 1, effective 2026-06-10)
//
// STANDING RULE: No send function in this codebase may ever read the
// `contractors` table or the `email_batch` table as a recipient source.
// Cold outreach to non-opted-in contacts is permanently prohibited.
//
// This file is kept for copy reference only. It will never be invoked.
// ─────────────────────────────────────────────────────────────────────────────

exports.handler = async function() {
  return {
    statusCode: 410,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error: 'RETIRED',
      message: 'Cold outreach path permanently retired (Change Order 1, Section 1). This function will not execute.',
    }),
  };
};
