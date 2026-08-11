// ─── Payment Routes ───────────────────────────────────────────────────────────
//
// Handles the game-server side of third-party payment integration.
//
// Routes:
//   POST /api/pay/create   — Authenticated. Creates a local order, forwards
//                            to the payment provider, returns QR / pay URL.
//   POST /api/pay/notify   — Public (provider calls it). Validates signature,
//                            marks order paid, credits Claudium balance.
//   GET  /api/pay/return   — Public (sync redirect). Informational only, redirects
//                            the user's browser back to the game.
//
// Environment variables (add to .env):
//   PAY_APP_ID       — 商户 AppID / pid
//   PAY_APP_KEY      — 商户密钥
//   PAY_API_BASE     — 支付平台 API 基础 URL（默认 https://pay.vansdesign.cn）
//   PAY_NOTIFY_URL   — 异步回调地址（公网 HTTPS）
//   PAY_RETURN_URL   — 支付成功跳转地址（游戏前端页面）
//   PAY_SITE_NAME    — 网站名称（默认 World of ClaudeCraft）
//
// Claudium-to-CNY conversion rate is set here as CLAUDIUM_PER_YUAN.
// Change this to match your pricing.

import * as http from 'node:http';
import {
  type NotifyParams,
  type PayType,
  createPayOrder,
  payConfig,
  parseLocalOrderId,
  verifyNotifySign,
} from './pay_provider';
import { adjustClaudiumBalance, pool } from './db';
import { json } from './http_util';

// Lightweight account lookup (mirrors the pattern used across the server).
async function findAccountById(
  accountId: number,
): Promise<{ id: number; username: string } | null> {
  const res = await pool.query(
    'SELECT id, username FROM accounts WHERE id = $1',
    [accountId],
  );
  return res.rows[0] ?? null;
}

// ─── Constants ───────────────────────────────────────────────────────────────
/** How many Claudium per ¥1 (¥1 = 100 Claudium) */
export const CLAUDIUM_PER_YUAN = 100;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function paramStr(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return '';
}
function paramNum(body: Record<string, unknown>, key: string): number {
  const v = body[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v) || 0;
  return 0;
}

// ─── POST /api/pay/create ───────────────────────────────────────────────────
/**
 * Body: { amount: number (¥1-5000), payType: "alipay"|"wxpay"|"qqpay" }
 * Requires bearer token (accountId resolved from token).
 *
 * Returns:
 *   { ok: true,  tradeNo, outTradeNo, payUrl, qrcode?, expireAt }
 *   { ok: false, error: string }
 */
export async function handlePayCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  accountId: number,
): Promise<void> {
  const account = await findAccountById(accountId);
  if (!account) return json(res, 401, { ok: false, error: 'not authenticated' });
  const username = account.username;
  const cfg = payConfig;
  if (!cfg.enabled) {
    return json(res, 503, { ok: false, error: 'Payment system is not enabled.' });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { ok: false, error: 'Invalid request body.' });
  }

  const amount = paramNum(body, 'amount');
  if (amount < 1 || amount > 5000) {
    return json(res, 400, { ok: false, error: 'Amount must be between ¥1 and ¥5000.' });
  }

  const payTypeRaw = paramStr(body, 'payType');
  const validPayTypes: PayType[] = ['alipay', 'wxpay'];
  if (!validPayTypes.includes(payTypeRaw as PayType)) {
    return json(res, 400, { ok: false, error: 'Invalid payType. Use: alipay | wxpay | qqpay' });
  }
  const payType = payTypeRaw as PayType;

  const attach = `uid=${accountId}`;

  const result = await createPayOrder({
    accountId,
    username,
    amount,
    payType,
    attach,
  });

  if (!result.ok) {
    return json(res, 502, { ok: false, error: result.error ?? 'Failed to create payment order.' });
  }

  // Record local order asynchronously (best-effort; notify is the source of truth)
  recordLocalOrder({
    accountId,
    username,
    localOrderId: result.outTradeNo!,
    providerTradeNo: result.tradeNo,
    amount,
    payType,
    claudiumAmount: Math.round(amount * CLAUDIUM_PER_YUAN),
  }).catch((err) =>
    console.error('[pay_routes] Failed to record local order:', err),
  );

  return json(res, 200, {
    ok: true,
    tradeNo: result.tradeNo,
    outTradeNo: result.outTradeNo,
    payUrl: result.payUrl,
    qrcode: result.qrcode,
    expireAt: result.expireAt,
  });
}

// ─── POST /api/pay/notify ───────────────────────────────────────────────────
/**
 * Callback from the payment provider (unauthenticated — validated by signature).
 *
 * vansdesign / 易支付 standard notify parameters:
 *   trade_no    — 平台订单号
 *   out_trade_no — 本地订单号
 *   status       — '1' = paid, '0' = not paid, '-1' = failed
 *   money        — 实际支付金额（元）
 *   attach       — 透传的自定义参数
 *   sign         — MD5 signature
 *
 * After verifying sign + status=1, credits Claudium to the account and returns
 * "success" (plain text) so the provider stops retrying.
 */
export async function handlePayNotify(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBody(req);
  } catch {
    res.statusCode = 400;
    res.end('Invalid body');
    return;
  }

  const params: NotifyParams = {
    trade_no: paramStr(body, 'trade_no'),
    out_trade_no: paramStr(body, 'out_trade_no'),
    status: paramStr(body, 'status'),
    money: paramStr(body, 'money'),
    attach: paramStr(body, 'attach'),
    sign: paramStr(body, 'sign'),
  };

  // ── Signature verification ──
  if (!verifyNotifySign(params)) {
    console.error('[pay_routes] Notify signature mismatch:', params);
    res.statusCode = 403;
    res.end('sign error');
    return;
  }

  // ── Status check: only process successful payments ──
  if (params.status !== '1') {
    // Not paid yet — tell provider to keep retrying
    res.statusCode = 200;
    res.end('success');
    return;
  }

  // ── Parse local order ──
  const parsed = parseLocalOrderId(params.out_trade_no);
  if (!parsed) {
    console.error('[pay_routes] Unknown order format:', params.out_trade_no);
    res.statusCode = 200;
    res.end('success'); // Return 200 so provider doesn't retry forever
    return;
  }

  // ── Idempotency: check if already processed ──
  const existing = await findLocalOrder(params.out_trade_no);
  if (!existing) {
    // No local record — try to recover from attach=uid=<id>
    const attachMatch = params.attach?.match(/uid=(\d+)/);
    if (!attachMatch) {
      console.error('[pay_routes] No local order and no uid in attach:', params);
      res.statusCode = 200;
      res.end('success');
      return;
    }
    const accountId = parseInt(attachMatch[1], 10);
    const paidAmount = parseFloat(params.money);
    if (isNaN(accountId) || isNaN(paidAmount) || paidAmount <= 0) {
      console.error('[pay_routes] Invalid params in notify:', params);
      res.statusCode = 200;
      res.end('success');
      return;
    }
    await creditAccount(accountId, paidAmount, params.trade_no, params.out_trade_no);
  } else if (existing.status === 'paid') {
    // Already credited — idempotent success
    res.statusCode = 200;
    res.end('success');
    return;
  } else {
    // Unpaid — process it
    await creditLocalOrder(existing, params.trade_no);
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('success');
}

// ─── GET /api/pay/return ────────────────────────────────────────────────────
/**
 * Synchronous redirect after payment (user is redirected back to the game).
 * Informational only — the actual balance update happened in notify.
 */
export async function handlePayReturn(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }
  const cfg = payConfig;
  // Redirect to return URL or the game home
  const returnTo = cfg.returnUrl || '/';
  res.statusCode = 302;
  res.setHeader('Location', returnTo);
  res.end();
}

// ─── Internal: local order management ──────────────────────────────────────
//
// We use the same PostgreSQL pool as the rest of the game server.
// Schema: CREATE TABLE IF NOT EXISTS pay_orders (...)

// The table is created by ensureSchema (pay_orders added to the core SCHEMA string
// in db.ts). These functions are thin wrappers around direct pg queries using the
// same pool as the game server.

interface LocalOrder {
  id: number;
  account_id: number;
  username: string;
  local_order_id: string;
  provider_trade_no: string | null;
  amount: number; // ¥
  claudium_amount: number;
  pay_type: string;
  status: 'pending' | 'paid' | 'expired' | 'failed';
  created_at: Date;
  paid_at: Date | null;
  provider_trade_no_paid: string | null;
}

async function getPool() {
  // Import lazily to avoid circular dependency issues with the db module
  const { pool } = await import('./db');
  return pool;
}

async function recordLocalOrder(order: {
  accountId: number;
  username: string;
  localOrderId: string;
  providerTradeNo?: string;
  amount: number;
  payType: PayType;
  claudiumAmount: number;
}): Promise<void> {
  const p = await getPool();
  await p.query(
    `INSERT INTO pay_orders
       (account_id, username, local_order_id, provider_trade_no, amount, claudium_amount, pay_type, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
     ON CONFLICT (local_order_id) DO NOTHING`,
    [
      order.accountId,
      order.username,
      order.localOrderId,
      order.providerTradeNo ?? null,
      order.amount,
      order.claudiumAmount,
      order.payType,
    ],
  );
}

async function findLocalOrder(localOrderId: string): Promise<LocalOrder | null> {
  const p = await getPool();
  const { rows } = await p.query<LocalOrder>(
    `SELECT * FROM pay_orders WHERE local_order_id = $1 LIMIT 1`,
    [localOrderId],
  );
  return rows[0] ?? null;
}

async function creditLocalOrder(
  order: LocalOrder,
  providerTradeNo: string,
): Promise<void> {
  const p = await getPool();
  await p.query(
    `UPDATE pay_orders
       SET status='paid', paid_at=NOW(), provider_trade_no_paid=$1
       WHERE id=$2 AND status='pending'`,
    [providerTradeNo, order.id],
  );
  await adjustClaudiumBalance(order.account_id, order.claudium_amount);
  console.log(
    `[pay_routes] Credited ${order.claudium_amount} Claudium to account ${order.account_id} ` +
      `(${order.username}) for order ${order.local_order_id}`,
  );
}

async function creditAccount(
  accountId: number,
  paidAmount: number,
  providerTradeNo: string,
  localOrderId: string,
): Promise<void> {
  const p = await getPool();
  const claudiumAmount = Math.round(paidAmount * CLAUDIUM_PER_YUAN);
  await p.query(
    `INSERT INTO pay_orders
       (account_id, username, local_order_id, provider_trade_no, amount, claudium_amount, pay_type, status, paid_at, provider_trade_no_paid)
     VALUES ($1,'unknown',$2,$3,$4,$5,'unknown','paid',NOW(),$3)
     ON CONFLICT (local_order_id) DO NOTHING`,
    [accountId, localOrderId, providerTradeNo, paidAmount, claudiumAmount],
  );
  await adjustClaudiumBalance(accountId, claudiumAmount);
  console.log(
    `[pay_routes] Credited ${claudiumAmount} Claudium (recovery) to account ${accountId} ` +
      `from order ${localOrderId}`,
  );
}

// ─── JSON body helper (same pattern as http_util but reads full object) ────────
function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
