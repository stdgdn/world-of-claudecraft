// ─── Local Claudium (no external service required) ───────────────────────────
import {
  getClaudiumBalance,
  adjustClaudiumBalance,
  grantAccountWeaponSkins,
  type AccountCosmetics,
} from './db';

/**
 * When true, Claudium runs entirely from the local DB without any external
 * economy service. Balance, spend, and store all work offline.
 * Always true in this deployment (WOC_ECONOMY_SERVICE_URL is not configured).
 */
export const LOCAL_CLAUDIUM_ENABLED = true;

// ─── Typed game-server client for the external CLAUDIUM economy service.
//
// CLAUDIUM is a server-authoritative soft currency: ALL peg/price/balance logic
// and verification live in the economy service (a separate repo). The game NEVER
// computes any of it; this module is the game server's proxy to that service. The
// browser hits the game server, the game server hits the service over a
// secret-gated internal API.
//
// GRACEFUL DEGRADATION IS THE CONTRACT. If WOC_ECONOMY_SERVICE_URL or
// WOC_ECONOMY_INTERNAL_SECRET is unset, OR the service is unreachable / errors /
// times out, EVERY function here returns a typed "unavailable" result (balance
// null, empty skus, buy disabled) and NEVER throws up into request handling. The
// game must boot and play with the service OFF.
//
// The functions mirror the service SDK v1 surface; they do NOT recompute any
// value, they only pass through what the service returns.

import { WEAPON_SKINS } from '../src/sim/content/weapon_skins';
import { DESKTOP_WALLET_HANDOFF_TTL_MS, desktopWalletHandoffs } from './desktop_wallet_handoff';

const SERVICE_TIMEOUT_MS = 5000;
const NATIVE_CONFIRM_TIMEOUT_MS = 60_000;

/** Integer Claudium balance for an account, or null when the service is off. */
export interface ClaudiumBalanceResult {
  available: boolean;
  balance: number | null;
}

/**
 * Per-rail price. usdPerClaudium fixes the display peg (1 Claudium = 0.01 USD);
 * wocBaseUnitsPerClaudium is null when the WOC oracle is down (buy disabled on
 * the woc rail). Both fields null when the service is off.
 */
export interface ClaudiumPriceResult {
  rail: string;
  usdPerClaudium: number | null;
  wocBaseUnitsPerClaudium: string | null;
}

export interface ClaudiumNativePriceResult {
  rail: ClaudiumNativeRail;
  claudium: number | null;
  amountBase: string | null;
  discountBps: number | null;
  reason?: string;
}

export interface ClaudiumSolBalanceResult {
  owner: string;
  lamports: string | null;
}

export interface ClaudiumUsdcBalanceResult {
  owner: string;
  amountBase: string | null;
}

/** One rung of the SKU ladder. usd/claudium both come from the service. */
export interface ClaudiumSku {
  sku: string;
  usd: number;
  claudium: number;
  stripeConfigured?: boolean;
}

/** The SKU ladder, empty when the service is off. */
export interface ClaudiumSkusResult {
  available: boolean;
  skus: ClaudiumSku[];
}

export type ClaudiumRail = 'stripe' | 'sol' | 'usdc' | 'woc';
export type ClaudiumPriceRail = 'stripe' | 'woc';
export type ClaudiumNativeRail = 'sol' | 'usdc' | 'woc';

/** The stripe-rail purchase-intent leg (client uses clientSecret with Stripe.js). */
export interface ClaudiumStripeIntent {
  clientSecret: string;
  publishableKey: string;
}

/**
 * The woc-rail purchase-intent leg: the split-transfer the client must build and
 * sign via the Wallet Standard path, then confirm by posting the signature.
 */
export interface ClaudiumWocIntent {
  amountBase: string;
  burnBase: string;
  treasuryBase: string;
  treasury: string;
  memo: string;
  expiresAtMs: number;
}

export interface ClaudiumPurchaseResult {
  ok: boolean;
  purchaseId: string | null;
  rail: ClaudiumRail | null;
  claudium: number | null;
  stripe: ClaudiumStripeIntent | null;
  woc: ClaudiumWocIntent | null;
  reason: string | null;
}

export interface ClaudiumNativeRailsResult {
  available: boolean;
  rails: Record<ClaudiumNativeRail, boolean>;
}

export interface ClaudiumNativeQuoteResult {
  ok: boolean;
  reference: string | null;
  rail: ClaudiumNativeRail | null;
  claudium: number | null;
  amountBase: string | null;
  destination: string | null;
  mint: string | null;
  memo: string | null;
  quoteExpiryMs: number | null;
  transactionBase64: string | null;
  split: { burnBase: string; treasuryBase: string; treasury: string } | null;
  reason: string | null;
}

export interface ClaudiumNativeConfirmResult {
  settled: boolean;
  balance: number | null;
  reason: string | null;
}

export interface ClaudiumSpendResult {
  granted: boolean;
  balance: number | null;
  costClaudium: number | null;
  reason: string | null;
}

export interface ClaudiumHistoryEntry {
  entryId: string;
  accountId: number;
  delta: number;
  reason: string;
  ref: string;
  atMs: number;
}

export interface ClaudiumHistoryResult {
  entries: ClaudiumHistoryEntry[];
}

/** One cosmetic-store row: the item and its Claudium cost, both from the service. */
export interface ClaudiumStoreItem {
  itemId: string;
  name: string;
  kind: 'cosmetic' | 'skin' | 'item';
  costClaudium: number;
  owned: boolean;
}

/** The cosmetic store catalog, empty when the service is off. */
export interface ClaudiumStoreResult {
  available: boolean;
  items: ClaudiumStoreItem[];
}

export interface ClaudiumStripeWebhookResult {
  received: boolean;
}

function serviceUrl(): string {
  return (process.env.WOC_ECONOMY_SERVICE_URL ?? '').trim();
}

function serviceSecret(): string {
  return process.env.WOC_ECONOMY_INTERNAL_SECRET ?? '';
}

/** The service is reachable only when BOTH the URL and the secret are set. */
export function claudiumServiceConfigured(): boolean {
  return serviceUrl() !== '' && serviceSecret() !== '';
}

let loggedOnce = false;
function logFailure(err: unknown): void {
  // Dev-channel only; the request path never sees this. Log once so a persistently
  // down service does not flood the server log every request.
  if (loggedOnce) return;
  loggedOnce = true;
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[claudium] economy service unavailable: ${message}`);
}

interface ServiceRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * The one fetch wrapper. Returns the parsed JSON on a 2xx, or null on any
 * failure (unconfigured, non-2xx, network error, timeout, bad JSON). It NEVER
 * throws: every caller maps a null into its own typed unavailable result.
 */
async function callService<T>(req: ServiceRequest): Promise<T | null> {
  const base = serviceUrl();
  const secret = serviceSecret();
  if (base === '' || secret === '') return null;
  try {
    const url = new URL(req.path.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`);
    const headers: Record<string, string> = { 'x-woc-economy-secret': secret };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }
    const res = await fetch(url, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(req.timeoutMs ?? SERVICE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${req.method} ${req.path} -> ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    logFailure(err);
    return null;
  }
}

export async function claudiumStripeWebhook(
  rawBody: Buffer,
  signatureHeader: string,
): Promise<ClaudiumStripeWebhookResult> {
  const base = serviceUrl();
  if (base === '') return { received: false };
  try {
    const url = new URL('stripe/webhook', base.endsWith('/') ? base : `${base}/`);
    const body = new Uint8Array(rawBody);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': signatureHeader,
      },
      body,
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 400) throw new Error(`POST stripe/webhook -> ${res.status}`);
    const data = (await res.json()) as { received?: unknown };
    return { received: data.received === true };
  } catch (err) {
    logFailure(err);
    return { received: false };
  }
}

/**
 * GET balance/:accountId.
 * Uses local DB when LOCAL_CLAUDIUM_ENABLED; otherwise falls back to the
 * external economy service (returns null when the service is off).
 */
export async function claudiumBalance(accountId: number): Promise<ClaudiumBalanceResult> {
  if (LOCAL_CLAUDIUM_ENABLED) {
    const balance = await getClaudiumBalance(accountId);
    return { available: true, balance };
  }
  const data = await callService<{ balance: number }>({
    method: 'GET',
    path: `balance/${encodeURIComponent(String(accountId))}`,
  });
  const available = typeof data?.balance === 'number';
  return { available, balance: typeof data?.balance === 'number' ? data.balance : null };
}

/** GET price/:rail. Prices null when the service is off (buy disabled). */
export async function claudiumPrice(rail: ClaudiumPriceRail): Promise<ClaudiumPriceResult> {
  const data = await callService<{
    rail: string;
    usdPerClaudium: number;
    wocBaseUnitsPerClaudium: string | number | null;
  }>({ method: 'GET', path: `price/${encodeURIComponent(rail)}` });
  if (!data) return { rail, usdPerClaudium: null, wocBaseUnitsPerClaudium: null };
  const wocBaseUnits = data.wocBaseUnitsPerClaudium;
  return {
    rail: data.rail,
    usdPerClaudium: typeof data.usdPerClaudium === 'number' ? data.usdPerClaudium : null,
    wocBaseUnitsPerClaudium:
      typeof wocBaseUnits === 'string'
        ? wocBaseUnits
        : typeof wocBaseUnits === 'number'
          ? String(wocBaseUnits)
          : null,
  };
}

export async function claudiumNativePrice(
  rail: ClaudiumNativeRail,
  sku: string,
): Promise<ClaudiumNativePriceResult> {
  const data = await callService<{
    rail?: ClaudiumNativeRail;
    claudium?: number;
    amountBase?: string | null;
    discountBps?: number | null;
    reason?: string;
  }>({
    method: 'GET',
    path: `native/price/${encodeURIComponent(rail)}?sku=${encodeURIComponent(sku)}`,
  });
  return {
    rail: data?.rail ?? rail,
    claudium:
      typeof data?.claudium === 'number' && Number.isInteger(data.claudium) && data.claudium > 0
        ? data.claudium
        : null,
    amountBase: typeof data?.amountBase === 'string' ? data.amountBase : null,
    discountBps:
      typeof data?.discountBps === 'number' &&
      Number.isInteger(data.discountBps) &&
      data.discountBps >= 0 &&
      data.discountBps <= 9000
        ? data.discountBps
        : null,
    reason: data?.reason ?? (data ? undefined : 'unavailable'),
  };
}

export async function claudiumSolBalance(owner: string): Promise<ClaudiumSolBalanceResult> {
  const data = await callService<{ owner?: string; lamports?: string | null }>({
    method: 'GET',
    path: `native/balance/sol/${encodeURIComponent(owner)}`,
  });
  return {
    owner: data?.owner ?? owner,
    lamports: typeof data?.lamports === 'string' ? data.lamports : null,
  };
}

export async function claudiumUsdcBalance(owner: string): Promise<ClaudiumUsdcBalanceResult> {
  const data = await callService<{ owner?: string; amountBase?: string | null }>({
    method: 'GET',
    path: `native/balance/usdc/${encodeURIComponent(owner)}`,
  });
  return {
    owner: data?.owner ?? owner,
    amountBase: typeof data?.amountBase === 'string' ? data.amountBase : null,
  };
}

export async function claudiumNativeRails(): Promise<ClaudiumNativeRailsResult> {
  const data = await callService<{ rails?: Partial<Record<ClaudiumNativeRail, boolean>> }>({
    method: 'GET',
    path: 'native/rails',
  });
  const available = data !== null && typeof data.rails === 'object' && data.rails !== null;
  return {
    available,
    rails: {
      sol: data?.rails?.sol === true,
      usdc: data?.rails?.usdc === true,
      woc: data?.rails?.woc === true,
    },
  };
}

/** GET skus. Empty ladder when the service is off (stripe rail disabled). */
export async function claudiumSkus(): Promise<ClaudiumSkusResult> {
  const data = await callService<ClaudiumSku[]>({ method: 'GET', path: 'skus' });
  if (!Array.isArray(data)) return { available: false, skus: [] };
  const skus = data
    .filter(
      (s): s is ClaudiumSku =>
        typeof s?.sku === 'string' && typeof s.usd === 'number' && typeof s.claudium === 'number',
    )
    .map((s) => ({
      sku: s.sku,
      usd: s.usd,
      claudium: s.claudium,
      stripeConfigured:
        typeof (s as { stripeConfigured?: unknown }).stripeConfigured === 'boolean'
          ? (s as { stripeConfigured: boolean }).stripeConfigured
          : undefined,
    }));
  return { available: true, skus };
}

/** POST purchase. Returns ok:false with a reason when the service is off. */
export async function claudiumPurchase(input: {
  accountId: number;
  rail: 'stripe';
  sku: string;
  idempotencyKey: string;
}): Promise<ClaudiumPurchaseResult> {
  const data = await callService<{
    purchaseId?: string;
    rail?: ClaudiumRail;
    claudium?: number;
    stripe?: ClaudiumStripeIntent;
    woc?: ClaudiumWocIntent;
    reason?: string;
  }>({ method: 'POST', path: 'purchase', body: input });
  if (!data) {
    return {
      ok: false,
      purchaseId: null,
      rail: null,
      claudium: null,
      stripe: null,
      woc: null,
      reason: 'unavailable',
    };
  }
  const reason = typeof data.reason === 'string' ? data.reason : null;
  const purchaseId =
    typeof data.purchaseId === 'string' && data.purchaseId !== '' ? data.purchaseId : null;
  const rail =
    data.rail === 'stripe' || data.rail === 'sol' || data.rail === 'usdc' || data.rail === 'woc'
      ? data.rail
      : null;
  const claudium =
    typeof data.claudium === 'number' && Number.isInteger(data.claudium) && data.claudium > 0
      ? data.claudium
      : null;
  const stripe =
    typeof data.stripe?.clientSecret === 'string' &&
    data.stripe.clientSecret.trim() !== '' &&
    typeof data.stripe.publishableKey === 'string' &&
    data.stripe.publishableKey.trim() !== ''
      ? {
          clientSecret: data.stripe.clientSecret,
          publishableKey: data.stripe.publishableKey,
        }
      : null;
  const ok =
    reason === null &&
    purchaseId !== null &&
    rail === input.rail &&
    claudium !== null &&
    stripe !== null;
  if (!ok) {
    return {
      ok: false,
      purchaseId: null,
      rail: null,
      claudium: null,
      stripe: null,
      woc: null,
      reason: reason ?? 'unavailable',
    };
  }
  return {
    ok: true,
    purchaseId,
    rail,
    claudium,
    stripe,
    woc: null,
    reason: null,
  };
}

export async function claudiumNativeQuote(input: {
  accountId: number;
  rail: ClaudiumNativeRail;
  sku: string;
  payer: string;
}): Promise<ClaudiumNativeQuoteResult> {
  const data = await callService<{
    reference?: string;
    rail?: ClaudiumNativeRail;
    claudium?: number;
    amountBase?: string;
    destination?: string;
    mint?: string | null;
    memo?: string;
    quoteExpiryMs?: number;
    transactionBase64?: string;
    split?: { burnBase: string; treasuryBase: string; treasury: string };
    reason?: string;
  }>({
    method: 'POST',
    path: 'native/quote',
    body: {
      rail: input.rail,
      sku: input.sku,
      payer: input.payer,
      fulfillment: { kind: 'credit', accountId: input.accountId },
    },
  });
  const refusalReason = typeof data?.reason === 'string' ? data.reason : null;
  const creditedClaudium =
    typeof data?.claudium === 'number' && Number.isInteger(data.claudium) && data.claudium > 0
      ? data.claudium
      : null;
  if (
    !data?.reference ||
    !data.transactionBase64 ||
    creditedClaudium === null ||
    refusalReason !== null ||
    (data.rail !== undefined && data.rail !== input.rail)
  ) {
    return {
      ok: false,
      reference: null,
      rail: null,
      claudium: null,
      amountBase: null,
      destination: null,
      mint: null,
      memo: null,
      quoteExpiryMs: null,
      transactionBase64: null,
      split: null,
      reason: refusalReason ?? 'unavailable',
    };
  }
  const quoteExpiryMs =
    typeof data.quoteExpiryMs === 'number'
      ? data.quoteExpiryMs
      : Date.now() + DESKTOP_WALLET_HANDOFF_TTL_MS;
  try {
    desktopWalletHandoffs.authorizeTransaction(input.accountId, {
      reference: data.reference,
      transactionBase64: data.transactionBase64,
      expectedAddress: input.payer,
      rail: data.rail ?? input.rail,
      amountBase: data.amountBase ?? null,
      destination: data.destination ?? null,
      expiresAtMs: quoteExpiryMs,
    });
  } catch {
    return {
      ok: false,
      reference: null,
      rail: null,
      claudium: null,
      amountBase: null,
      destination: null,
      mint: null,
      memo: null,
      quoteExpiryMs: null,
      transactionBase64: null,
      split: null,
      reason: 'unavailable',
    };
  }
  return {
    ok: true,
    reference: data.reference,
    rail: data.rail ?? input.rail,
    claudium: creditedClaudium,
    amountBase: data.amountBase ?? null,
    destination: data.destination ?? null,
    mint: data.mint ?? null,
    memo: data.memo ?? null,
    quoteExpiryMs,
    transactionBase64: data.transactionBase64,
    split: data.split ?? null,
    reason: data.reason ?? null,
  };
}

export async function claudiumNativeConfirm(input: {
  accountId: number;
  reference: string;
  signature: string;
}): Promise<ClaudiumNativeConfirmResult> {
  const data = await callService<{
    settled: boolean;
    reason?: string;
    fulfillment?: { balance?: number };
  }>({
    method: 'POST',
    path: 'native/confirm',
    body: input,
    timeoutMs: NATIVE_CONFIRM_TIMEOUT_MS,
  });
  if (!data) return { settled: false, balance: null, reason: 'unavailable' };
  return {
    settled: Boolean(data.settled),
    balance: typeof data.fulfillment?.balance === 'number' ? data.fulfillment.balance : null,
    reason: data.reason ?? null,
  };
}

/**
 * POST spend. Local version when LOCAL_CLAUDIUM_ENABLED:
 * deducts balance, grants the weapon skin, returns new balance.
 * Remote version (LOCAL_CLAUDIUM_ENABLED=false) talks to the external service.
 */
export async function claudiumSpend(input: {
  accountId: number;
  itemId: string;
  kind: 'cosmetic' | 'skin' | 'item';
  expectedCostClaudium: number;
  idempotencyKey: string;
}): Promise<ClaudiumSpendResult> {
  if (LOCAL_CLAUDIUM_ENABLED) {
    // 1. Idempotency guard: skip if the account already owns this skin.
    const existing = await grantAccountWeaponSkins(input.accountId, []);
    if (existing.weaponSkinIds.includes(input.itemId)) {
      const balance = await getClaudiumBalance(input.accountId);
      return { granted: false, balance, costClaudium: input.expectedCostClaudium, reason: 'already_granted' };
    }
    // 2. Check balance.
    const balance = await getClaudiumBalance(input.accountId);
    if (balance < input.expectedCostClaudium) {
      return { granted: false, balance, costClaudium: input.expectedCostClaudium, reason: 'insufficient_balance' };
    }
    // 3. Deduct and grant.
    const newBalance = await adjustClaudiumBalance(input.accountId, -input.expectedCostClaudium);
    if (input.kind === 'skin') {
      await grantAccountWeaponSkins(input.accountId, [input.itemId]);
    }
    return { granted: true, balance: newBalance, costClaudium: input.expectedCostClaudium, reason: null };
  }
  // ── External economy-service path (unchanged) ──────────────────────────────
  const data = await callService<{
    granted: boolean;
    balance: number;
    costClaudium?: number;
    reason?: string;
  }>({ method: 'POST', path: 'spend', body: input });
  if (!data) return { granted: false, balance: null, costClaudium: null, reason: 'unavailable' };
  return {
    granted: Boolean(data.granted),
    balance: typeof data.balance === 'number' ? data.balance : null,
    costClaudium: typeof data.costClaudium === 'number' ? data.costClaudium : null,
    reason: data.reason ?? null,
  };
}

/** GET history/:accountId. Empty when the service is off. */
export async function claudiumHistory(accountId: number): Promise<ClaudiumHistoryResult> {
  const data = await callService<ClaudiumHistoryEntry[]>({
    method: 'GET',
    path: `history/${encodeURIComponent(String(accountId))}`,
  });
  if (!Array.isArray(data)) return { entries: [] };
  const entries = data.filter(
    (entry): entry is ClaudiumHistoryEntry =>
      typeof entry?.entryId === 'string' &&
      entry.accountId === accountId &&
      typeof entry.delta === 'number' &&
      typeof entry.reason === 'string' &&
      typeof entry.ref === 'string' &&
      typeof entry.atMs === 'number',
  );
  return { entries };
}

/** GET store. The cosmetic catalog, priced in Claudium by the service. Empty when off. */
/**
 * GET store/:accountId. Local version returns all weapon skins with fixed prices
 * and ownership resolved from account_weapon_cosmetics.
 */
export async function claudiumStore(accountId: number): Promise<ClaudiumStoreResult> {
  if (LOCAL_CLAUDIUM_ENABLED) {
    const cosmetics = await grantAccountWeaponSkins(accountId, []);
    const owned = new Set(cosmetics.weaponSkinIds);
    // Fixed local price table (Claudium). Change values here to adjust shop pricing.
    const PRICE_MAP: Record<string, number> = {
      // Guildmark (Uncommon)
      guildmark_arming_sword: 100, brasscap_axe: 100, tempered_flanged_mace: 100,
      guildmark_dirk: 100, brasscrown_staff: 100, lacquered_wand: 100, fletcher_s_guild_bow: 100,
      // Emberwrought (Rare)
      cinderbrand_sword: 300, emberbite_axe: 300, smoulderfall_mace: 300,
      ashspark_dagger: 300, forgeheart_staff: 300, emberwrought_wand: 300, cinderlatch_crossbow: 300,
      // Hoarfrost (Epic)
      ice_fang_sword: 800, glaciersplit_axe: 800, rimecrusher_mace: 800,
      frostbite_dagger: 800, hoarfrost_vigil_staff: 800, everwinter_wand: 800, winterbite: 800,
      // Fallen Star (Legendary)
      solheim_sword: 2000, skyrender_axe: 2000, starfall_mace: 2000,
      astravyr_dagger: 2000, cosmarch_staff: 2000, emberwish_wand: 2000,
      encore_bow: 2000, meteorlatch_crossbow: 2000,
    };
    const items: ClaudiumStoreItem[] = Object.values(WEAPON_SKINS).map((skin) => ({
      itemId: skin.id,
      name: skin.id, // i18n key resolved client-side from armory.ts
      kind: 'skin' as const,
      costClaudium: PRICE_MAP[skin.id] ?? 500,
      owned: owned.has(skin.id),
    }));
    return { available: true, items };
  }
  // ── External economy-service path (unchanged) ──────────────────────────────
  const data = await callService<ClaudiumStoreItem[]>({
    method: 'GET',
    path: `store/${encodeURIComponent(String(accountId))}`,
  });
  if (!Array.isArray(data)) return { available: false, items: [] };
  const items = data.filter(
    (i): i is ClaudiumStoreItem =>
      typeof i?.itemId === 'string' &&
      typeof i.name === 'string' &&
      typeof i.costClaudium === 'number' &&
      typeof i.owned === 'boolean' &&
      (i.kind === 'cosmetic' || i.kind === 'skin' || i.kind === 'item'),
  );
  return { available: true, items };
}
