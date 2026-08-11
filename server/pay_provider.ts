// ─── Payment Provider Abstraction ───────────────────────────────────────────
//
// Currently implemented for: 虎皮椒 V1 (https://pay.hupijiao.cn)
// All provider-specific logic lives here. To add another provider, implement
// PayProvider here and register it in pay_routes.ts.
//
// Protocol summary (虎皮椒 V1 / MD5):
//   1. Client  → POST /api/pay/create   → game server creates local order
//   2. Client  ← { qrcode_url, pay_url }              ← game server returns payment link
//   3. Client  → browser/QR → user pays via Alipay/WeChat
//   4. 虎皮椒 → POST /api/pay/notify   → your server (needs public HTTPS)
//   5. Game server → UPDATE accounts SET claudium_balance += N  (after verified notify)
//   6. 虎皮椒 → HTTP → /api/pay/return  (sync redirect, informational only)
//
// Environment variables (add to .env):
//   PAY_APP_ID       — 商户 AppID (虎皮椒后台 → 我的信息 → APPID)
//   PAY_APP_KEY      — V1 接口密钥（MD5签名用，后台显示的 AppSecret）
//   PAY_API_BASE     — 支付平台 API 基础 URL（默认 https://pay.hupijiao.cn）
//   PAY_NOTIFY_URL   — 异步回调地址（公网 HTTPS，例 https://yourdomain.com/api/pay/notify）
//   PAY_RETURN_URL   — 支付成功跳转地址（前端页面）
//   PAY_SITE_NAME    — 网站名称（默认 World of ClaudeCraft）
//
// Signature algorithm (MD5, key ASCII-sort, no sign field):
//   sign = MD5(key1=value1&key2=value2&...&key=YOUR_APP_KEY).toUpperCase()
//
// Docs: https://pay.hupijiao.cn/doc/

import * as crypto from 'node:crypto';

// ─── Env config ───────────────────────────────────────────────────────────────
export interface PayConfig {
  enabled: boolean;
  /** 商户 AppID */
  appId: string;
  /** 商户密钥（V1/MD5 签名用） */
  appKey: string;
  /** 支付平台 API 基础 URL */
  apiBase: string;
  /** 本游戏服务器对外可访问的 HTTPS 回调地址（支付平台通知） */
  notifyUrl: string;
  /** 支付成功后浏览器跳转地址 */
  returnUrl: string;
  /** 默认网站名称 */
  siteName: string;
}

function loadPayConfig(): PayConfig {
  return {
    enabled: !!(
      process.env.PAY_APP_ID &&
      process.env.PAY_APP_KEY &&
      process.env.PAY_API_BASE
    ),
    appId: process.env.PAY_APP_ID ?? '',
    appKey: process.env.PAY_APP_KEY ?? '',
    apiBase: process.env.PAY_API_BASE ?? 'https://pay.hupijiao.cn',
    notifyUrl: process.env.PAY_NOTIFY_URL ?? '',
    returnUrl: process.env.PAY_RETURN_URL ?? '',
    siteName: process.env.PAY_SITE_NAME ?? 'World of ClaudeCraft',
  };
}

export const payConfig = loadPayConfig();

// ─── Sign ────────────────────────────────────────────────────────────────────
/**
 * 虎皮椒 V1 MD5 签名。
 * 参数按 key 的 ASCII 升序排列，拼成 key1=value1&key2=value2&...&key=APPKEY，
 * 然后 MD5 并转大写。
 */
export function signPayload(params: Record<string, string | number>): string {
  const cfg = payConfig;
  if (!cfg.appKey) return '';
  const sorted = Object.keys(params)
    .filter((k) => params[k] !== '' && params[k] !== undefined && k !== 'sign')
    .sort();
  const raw = sorted.map((k) => `${k}=${params[k]}`).join('&') + `&key=${cfg.appKey}`;
  return crypto.createHash('md5').update(raw, 'utf8').digest('hex').toUpperCase();
}

// ─── Types ───────────────────────────────────────────────────────────────────
export type PayType = 'alipay' | 'wxpay';

export interface CreateOrderParams {
  accountId: number;
  username: string;
  amount: number; // 人民币元 (1 = ¥1)
  payType: PayType;
  /** 自定义附加参数，回调时透传回（用于识别账号） */
  attach?: string;
}

export interface CreateOrderResult {
  ok: boolean;
  error?: string;
  /** 平台订单号 */
  tradeNo?: string;
  /** 商户本地订单号 */
  outTradeNo?: string;
  /** 支付宝专用支付链接 (alipays://...) */
  payUrl?: string;
  /** 二维码图片 URL */
  qrcode?: string;
  /** 过期时间 Unix 秒 */
  expireAt?: number;
}

export interface NotifyParams {
  /** 平台订单号 */
  trade_no: string;
  /** 商户本地订单号 */
  out_trade_no: string;
  /**
   * 支付状态：
   *   '1'  = 支付成功
   *   '0'  = 未支付（可忽略）
   *   '-1' = 支付失败（可忽略）
   */
  status: string;
  /** 实际支付金额（元） */
  money: string;
  /** 附加参数 */
  attach?: string;
  /** 签名字符串 */
  sign: string;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
/** POST JSON to URL and parse response */
function postJson<T>(url: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? require('node:https') : require('node:http');
    const u = new URL(url);
    const bodyStr = JSON.stringify(body);
    const opts: import('node:http').RequestOptions = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'User-Agent': 'WOC-Payment/1.0',
      },
    };
    const req = mod.request(opts, (res: import('node:http').IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(raw) as T);
        } catch {
          reject(new Error(`Invalid JSON from payment provider: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Payment provider request timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

// ─── Create order ───────────────────────────────────────────────────────────
interface HupijiaoCreateResponse {
  /** 1=成功，0=失败 */
  code: number;
  /** 仅 code=0 时返回 */
  message?: string;
  /** 平台订单号 */
  trade_order_id?: string;
  /** 商户本地订单号 */
  order_id?: string;
  /** 支付宝/微信支付 URL（扫码跳转） */
  url?: string;
  /** 二维码图片 URL */
  qrcode_url?: string;
}

/**
 * 调用虎皮椒 V1 API 创建支付订单。
 * POST https://pay.hupijiao.cn/payment/do.html
 * 参数放在 body JSON 里，签名独立放在 sign 字段。
 */
export async function createPayOrder(
  params: CreateOrderParams,
): Promise<CreateOrderResult> {
  const cfg = payConfig;
  if (!cfg.enabled) {
    return { ok: false, error: 'Payment system not configured on server.' };
  }

  if (params.amount < 1) {
    return { ok: false, error: 'Minimum recharge amount is ¥1.' };
  }

  // 本地订单号：WOC_时间戳_随机4位
  const localOrderId = `WOC_${Date.now()}_${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
  const EXPIRE_SECONDS = 3600;
  const expireAt = Math.floor(Date.now() / 1000) + EXPIRE_SECONDS;
  const timestamp = Math.floor(Date.now() / 1000);

  // 虎皮椒 V1 type: alipay / wxpay
  const typeMap: Record<PayType, string> = { alipay: 'alipay', wxpay: 'wechat' };

  const payload: Record<string, string | number> = {
    version: '1.1',
    appid: cfg.appId,
    trade_order_id: localOrderId,
    total_fee: params.amount,
    title: `Claudium 充值 · ${params.amount}元`,
    time: timestamp,
    notify_url: cfg.notifyUrl,
    return_url: cfg.returnUrl,
    // attach 透传，回调时原样返回
    attach: params.attach ?? `uid=${params.accountId}`,
    type: typeMap[params.payType],
  };

  payload.sign = signPayload(payload);

  try {
    const resp = await postJson<HupijiaoCreateResponse>(
      `${cfg.apiBase}/payment/do.html`,
      payload,
    );

    if (resp.code !== 1) {
      return { ok: false, error: resp.message ?? 'Payment gateway error.' };
    }

    return {
      ok: true,
      tradeNo: resp.trade_order_id,
      outTradeNo: resp.order_id ?? localOrderId,
      payUrl: resp.url,
      qrcode: resp.qrcode_url,
      expireAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Payment gateway unreachable: ${msg}` };
  }
}

// ─── Verify notify signature ─────────────────────────────────────────────────
/**
 * 验证虎皮椒回调签名。
 * 平台发的 sign 是 MD5(其余参数按key排序+key=APPKEY) 的大写。
 */
export function verifyNotifySign(params: NotifyParams): boolean {
  const cfg = payConfig;
  if (!cfg.appKey) return false;
  const { sign: _providedSign, ...rest } = params;
  const providedSign = (_providedSign as string ?? '').toUpperCase();
  const computed = signPayload(rest as Record<string, string | number>);
  return computed === providedSign;
}

// ─── Parse local order ID ────────────────────────────────────────────────────
/**
 * 解析本地订单号，格式: WOC_<timestamp>_<random4>
 */
export function parseLocalOrderId(outTradeNo: string): {
  timestamp: number;
  random: string;
} | null {
  const parts = outTradeNo.split('_');
  if (parts.length !== 3 || parts[0] !== 'WOC') return null;
  const ts = Number(parts[1]);
  if (isNaN(ts)) return null;
  return { timestamp: ts, random: parts[2] };
}
