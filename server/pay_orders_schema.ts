// Pay-order tracking table for the third-party payment integration.
// This table is the source-of-truth for order status; the payment provider's
// callback (/api/pay/notify) is the canonical "paid" event.

export const PAY_ORDERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS pay_orders (
  id                              SERIAL PRIMARY KEY,
  account_id                      INTEGER        NOT NULL
                                      REFERENCES accounts(id)
                                      ON DELETE CASCADE,
  username                        TEXT           NOT NULL,
  local_order_id                  TEXT           NOT NULL UNIQUE,
  -- Set when we receive the gateway's order creation response (pre-payment)
  provider_trade_no               TEXT,
  amount                          NUMERIC(10,2)  NOT NULL  CHECK (amount > 0),
  -- Claudium credited on payment
  claudium_amount                 INTEGER        NOT NULL  CHECK (claudium_amount > 0),
  pay_type                        TEXT           NOT NULL,  -- 'alipay'|'wxpay'|'qqpay'
  -- pending | paid | expired | failed
  status                          TEXT           NOT NULL DEFAULT 'pending',
  created_at                      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  -- Set only when status transitions to 'paid'
  paid_at                         TIMESTAMPTZ,
  -- The trade_no from the provider that actually settled the order
  -- (may differ from provider_trade_no if the gateway retries with a new id)
  provider_trade_no_paid          TEXT
);

CREATE INDEX IF NOT EXISTS pay_orders_account_id_idx ON pay_orders(account_id);
CREATE INDEX IF NOT EXISTS pay_orders_local_order_id_idx ON pay_orders(local_order_id);
CREATE INDEX IF NOT EXISTS pay_orders_status_idx ON pay_orders(status) WHERE status = 'pending';
`;
