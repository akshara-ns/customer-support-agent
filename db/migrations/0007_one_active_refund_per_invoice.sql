-- 0007: at most one active (pending or succeeded) refund per customer invoice, enforced by the
-- database. Before this, two concurrent requests with different idempotency keys (different amounts,
-- sessions, or chat + voice at once) could both succeed (review finding R2).

-- Retire stale pending requests on invoices that already have a succeeded refund
-- (e.g. a failed attempt in one session, then a refund in another). Completing them later
-- would refund the invoice twice.
UPDATE actions a
SET status = 'rejected',
    result = jsonb_build_object('code', 'ALREADY_REFUNDED', 'message', 'Retired by migration 0007: another refund on this invoice succeeded.', 'retryable', false),
    completed_at = now()
WHERE a.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM actions s
    WHERE s.customer_id = a.customer_id AND s.invoice_id = a.invoice_id AND s.status = 'succeeded'
  );

CREATE UNIQUE INDEX actions_one_active_refund_per_invoice
  ON actions (customer_id, invoice_id)
  WHERE status IN ('pending', 'succeeded');
