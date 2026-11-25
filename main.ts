// Foxfire v5 — a fresh-launch sniper for the pump.fun paper sprint.
// Protocol: agent-fun/replay/v2. The harness sends a hello, then one batch
// per slot, and this bot answers each batch with its orders for that slot.
// Orders decided on slot s fill at slot s + latency (2 slots).
//
// v5 (shipped): the critic-round-1 fixes on top of the v3 sniper —
// fill-aware sell bookkeeping (a trade record is deleted only on a
// confirmed sell fill, sells in flight are never re-issued, a rejected
// buy no longer burns its mint), entry price recomputed from the buy fill,
// buys sized at 0.9x the per-order cap — plus the one measured breadth
// change that survived the joint dev+stress test: entry needs only >= 8
// buy prints (was 10), a -5% stop (was -7%), 1000 bps buy slippage
// (was 500), and a smaller 0.015 SOL stake, which together give 44
// distinct mints on dev (min 20) with a stress median no worse than v3.
// Every other measured experiment (TP +40%, recency filter, creator /
// big-sell exits, wider rise cap, longer age window, shorter hold,
// tighter -3% stop, +15% take-profit) was REJECTED on dev and is left off;
// see BUILD-REPORT.json for the full experiment table.
//
// Everything here is deterministic: no clock, no environment, no unseeded
// randomness. The same hello + batches always produce the same orders.

import { runBot } from "./vendor/agentfun-bot.ts";
import type { Batch, BotState } from "./vendor/agentfun-bot.ts";

// ------------------------------------------------------------------ tuning
// All sizes in lamports unless noted. 1 SOL = 1_000_000_000 lamports.
const STAKE_LAMPORTS = 15_000_000n; // D2 smaller stake: 0.015 SOL per coin (was 0.02)
const MIN_STAKE_LAMPORTS = 15_000_000n; // D2: never buy less than 0.015 SOL
const MAX_OPEN = 5; // harness cap; also enforced by the harness
const MAX_NEW_BUYS_PER_BATCH = 2; // spread entries; never chase a whole batch
const SIZE_HEADROOM_NUM = 9n; // buy at 0.9x the 100 bps order cap (S6)
const SIZE_HEADROOM_DEN = 10n;

// Entry window, in slots after the coin is created (a slot is ~0.4 s).
const MIN_AGE_SLOTS = 15; // let the first flurry of trades print first
const MAX_AGE_SLOTS = 240; // B1 age 480: REJECTED (dev -0.0579, 37 mints) — back to 240
const MIN_REAL_SOL_LAMPORTS = 2_000_000_000n; // real reserve >= 2 SOL, so
// the 100 bps per-order cap still allows a >= 0.02 SOL buy.

// What "real buyers are piling in" means, measured over the coin's life so far.
const MIN_BUY_TRADES = 8; // C1: buy-trades axis alone (was 10)
const MIN_DISTINCT_BUYERS = 8; // strict restored
const MIN_BUY_VOLUME_LAMPORTS = 3_000_000_000n; // strict restored
const MIN_BUY_SELL_RATIO = 3.0; // strict restored
const MIN_RISE = 1.12; // B3 rise 1.08: IDENTICAL under strict filters — back to 1.12
const MAX_RISE = 1.45; // B2 rise 2.0: REJECTED (dev -0.234, 96 mints) — back to 1.45
const MAX_PULLBACK_FROM_PEAK = 0.95; // skip coins already dumping off a peak

// Recency filter (S4, measured experiment): the buying must be happening
// NOW, not just at some point in the coin's life so far.
const RECENCY_ON = false; // E3 recency: REJECTED (dev -0.0395 vs -0.0220, mints 51 vs 62)
const RECENCY_SLOTS = 60; // trailing window, in slots
const RECENCY_MIN_BUY_VOLUME = 1_000_000_000n; // >= 1 SOL bought recently
const RECENCY_MIN_BUYERS = 3; // >= 3 distinct recent buyers
const RECENCY_MAX_STALE_SLOTS = 15; // at least one buy in the last 15 slots

// Fee filter (S8, measured): dev data shows NO dispersion — 126,770 of
// 128,058 dev trades carry protocol 95 + creator 30 bps (combined 125),
// 31 carry 95 + 0. The 250 bps cap below therefore never binds on dev;
// it is kept as a guard against a high-fee coin in the final window.
const MAX_COMBINED_FEE_BPS = 250;

// Exits, as multiples of the entry price. v2: exits are much faster than
// v1's — pump.fun moves happen in the first minutes, and a coin that has not
// paid within ~3 minutes is usually just decaying into fees.
// v3: the stop is a touch tighter, and the sell slippage is much wider —
// v2's worst losses (-27%) were sells rejected on 8% slippage while the
// coin dumped through the stop; an exit that does not fill is no exit.
const TAKE_PROFIT = 1.2; // D3 TP 1.15: REJECTED (dev -0.0134 vs -0.0083) — back to +20%
const STOP_LOSS = 0.95; // E10 stop -3%: REJECTED (dev -0.0529) — keep -5%
const TRAIL_ARM = 1.1; // trailing stop arms once the trade is +10%
const TRAIL_GIVEBACK = 0.94; // ... then sell if it falls 6% off its peak
const MAX_HOLD_SLOTS = 450; // E8 hold 300: REJECTED (dev -0.0228 vs -0.0187) — keep 450

// Creator / big-sell exit (S2 experiment): exit when the curve creator
// sells while we hold, or a single sell of >= 1 SOL prints while we hold.
const CREATOR_EXIT_ON = false; // E4 creator-sell exit: REJECTED (dev -0.0413 vs -0.0220)
const BIG_SELL_EXIT_ON = false; // E4 big-sell exit: REJECTED (same run as creator exit)
const BIG_SELL_LAMPORTS = 1_000_000_000n; // >= 1 SOL in one sell print

const BUY_SLIPPAGE_BPS = 1000; // E9 wider buy slippage experiment (was 500)
const SELL_SLIPPAGE_BPS = 2000; // exits must fill even in a fast dump

// ------------------------------------------------------------------ helpers
function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken <= 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

// ------------------------------------------------------------------ per-coin tape
interface RecentBuy {
  slot: number;
  amount: bigint;
  user: string;
}

interface CoinTape {
  mint: string;
  createdSlot: number;
  firstPrice: number;
  peakPrice: number;
  buyTrades: number;
  sellTrades: number;
  buyVolume: bigint; // lamports of SOL bought
  sellVolume: bigint; // lamports of SOL sold
  buyers: Set<string>;
  seen: boolean;
  creator: string; // curve creator, from CreateEvent / TradeEvent
  creatorSellSlot: number; // latest slot the creator sold, -1 if never
  bigSellSlot: number; // latest slot a >= 1 SOL sell printed, -1 if never
  feeBps: number; // latest combined protocol + creator fee, bps
  recentBuys: RecentBuy[]; // buy prints, pruned to the recency window
}

// What we remember about a position we opened.
interface OpenTrade {
  mint: string;
  entryPrice: number; // price (quote per token) actually paid, from the fill
  entrySlot: number; // slot the buy fill landed on
  peakPrice: number; // highest price seen since entry
}

const tapes = new Map<string, CoinTape>();
const trades = new Map<string, OpenTrade>(); // mint -> open trade record
const pendingBuys = new Map<string, string>(); // client_id -> mint
const pendingSells = new Map<string, string>(); // client_id -> mint
const deadMints = new Set<string>(); // mints already traded once: one shot only

// Reject / fail counters by side and reason, reported to stderr at onDone
// (the grade-local report only gives a total rejected count).
const rejectCounts = new Map<string, number>();
function countReject(side: string, status: string, reason: string | null): void {
  const key = `${side}:${status}:${reason ?? "none"}`;
  rejectCounts.set(key, (rejectCounts.get(key) ?? 0) + 1);
}

function tapeFor(mint: string, slot: number): CoinTape {
  let tape = tapes.get(mint);
  if (tape === undefined) {
    tape = {
      mint,
      createdSlot: slot,
      firstPrice: 0,
      peakPrice: 0,
      buyTrades: 0,
      sellTrades: 0,
      buyVolume: 0n,
      sellVolume: 0n,
      buyers: new Set<string>(),
      seen: false,
      creator: "",
      creatorSellSlot: -1,
      bigSellSlot: -1,
      feeBps: 0,
      recentBuys: [],
    };
    tapes.set(mint, tape);
  }
  return tape;
}

// Fold one batch of chain events into the tapes. The harness hands us the
// events in chain order; a trade's reserves are post-trade, so the price we
// record for a mint is the price after that trade printed.
function observeEvents(batch: Batch): void {
  for (const event of batch.events) {
    if (event.event === "CreateEvent") {
      const tape = tapeFor(event.mint, event.slot);
      tape.createdSlot = event.slot;
      tape.creator = event.creator;
      const price = priceOf(
        BigInt(event.virtual_quote_reserves),
        BigInt(event.virtual_token_reserves),
      );
      if (price > 0) {
        if (tape.firstPrice === 0) tape.firstPrice = price;
        if (price > tape.peakPrice) tape.peakPrice = price;
      }
    } else if (event.event === "TradeEvent") {
      const tape = tapeFor(event.mint, event.slot);
      if (tape.creator === "") tape.creator = event.creator;
      const price = priceOf(
        BigInt(event.virtual_quote_reserves),
        BigInt(event.virtual_token_reserves),
      );
      if (price > 0) {
        if (tape.firstPrice === 0) tape.firstPrice = price;
        if (price > tape.peakPrice) tape.peakPrice = price;
      }
      tape.feeBps =
        Number(event.fee_basis_points) + Number(event.creator_fee_basis_points);
      const amount = BigInt(event.sol_amount);
      if (event.is_buy) {
        tape.buyTrades += 1;
        tape.buyVolume += amount;
        tape.buyers.add(event.user);
        tape.recentBuys.push({ slot: event.slot, amount, user: event.user });
        if (tape.recentBuys.length > 400) {
          const cutoff = event.slot - RECENCY_SLOTS;
          tape.recentBuys = tape.recentBuys.filter((b) => b.slot >= cutoff);
        }
      } else {
        tape.sellTrades += 1;
        tape.sellVolume += amount;
        if (event.user !== "" && event.user === tape.creator) {
          tape.creatorSellSlot = event.slot;
        }
        if (amount >= BIG_SELL_LAMPORTS) tape.bigSellSlot = event.slot;
      }
      tape.seen = true;
    } else {
      // CompleteEvent: the curve migrated; the harness closes any position
      // in it for us, so drop the tape and the trade record.
      tapes.delete(event.mint);
      trades.delete(event.mint);
      for (const [id, mint] of pendingSells) {
        if (mint === event.mint) pendingSells.delete(id);
      }
      for (const [id, mint] of pendingBuys) {
        if (mint === event.mint) pendingBuys.delete(id);
      }
      deadMints.add(event.mint);
    }
  }
}

// Reconcile our own books with the fills the harness reports for this batch.
// Buys: a filled buy (re)sets the entry from the fill itself — quote paid
// per token received, at the fill slot — so TP/SL/trailing are measured
// against a price the bot actually got, not the decision-time curve price
// (S3). A rejected/failed buy never opens a position: drop its trade record
// AND release the mint, so a burned-by-rejection mint can be tried again
// instead of being dead forever (S6). Sells: the trade record is deleted
// and the mint marked dead ONLY when the sell fill reports filled, or when
// a harness close (_complete_ / _flatten_ / _writeoff_) closes the position
// (S1). A rejected/failed sell keeps the record so the exit re-arms next
// batch instead of leaving a zombie position with no stop.
function reconcileFills(batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.client_id.startsWith("_")) {
      // Harness close: the position is gone whatever the fill says.
      if (fill.side === "sell") {
        trades.delete(fill.mint);
        deadMints.add(fill.mint);
        for (const [id, mint] of pendingSells) {
          if (mint === fill.mint) pendingSells.delete(id);
        }
      }
      continue;
    }
    if (fill.status !== "filled") countReject(fill.side, fill.status, fill.reason);
    const buyMint = pendingBuys.get(fill.client_id);
    if (buyMint !== undefined) {
      pendingBuys.delete(fill.client_id);
      if (fill.side === "buy") {
        if (fill.status === "filled") {
          const trade = trades.get(buyMint);
          const quote = BigInt(fill.quote_lamports);
          const tokens = BigInt(fill.token_amount);
          if (trade !== undefined && quote > 0n && tokens > 0n) {
            trade.entryPrice = Number(quote) / Number(tokens);
            trade.peakPrice = trade.entryPrice;
            trade.entrySlot = fill.slot;
          }
        } else {
          trades.delete(buyMint);
          deadMints.delete(buyMint);
        }
      }
      continue;
    }
    const sellMint = pendingSells.get(fill.client_id);
    if (sellMint !== undefined) {
      pendingSells.delete(fill.client_id);
      if (fill.side === "sell" && fill.status === "filled") {
        trades.delete(sellMint);
        deadMints.add(sellMint);
      }
      // Rejected/failed sell: keep the trade record — the exit re-arms
      // next batch (S1). The mint stays out of deadMints until it fills.
      continue;
    }
  }
}

// Decide the sells for this batch: take-profit, stop-loss, trailing stop,
// time stop, plus (when enabled) creator-sell and big-sell exits. All read
// off the harness's own account (tokens actually held) and the latest curve
// price. Returns sell orders, most urgent first. A mint with a sell already
// in flight is skipped (S5) — the pending fill, not a duplicate order,
// decides the exit.
function decideSells(state: BotState): Array<{
  side: "sell";
  mint: string;
  token_amount: bigint;
  max_slippage_bps: number;
}> {
  const sells: Array<{
    side: "sell";
    mint: string;
    token_amount: bigint;
    max_slippage_bps: number;
  }> = [];
  const inFlightSells = new Set<string>(pendingSells.values());
  for (const [mint, holding] of state.positions) {
    if (inFlightSells.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const price = priceOf(
      curve.virtual_quote_reserves,
      curve.virtual_token_reserves,
    );
    if (price <= 0) continue;
    const trade = trades.get(mint);
    // No trade record (should not happen — every position came from our own
    // buy): fall back to the harness cost basis as the entry price.
    const entryPrice =
      trade !== undefined
        ? trade.entryPrice
        : Number(holding.cost_lamports) / Number(holding.token_amount);
    if (trade !== undefined && price > trade.peakPrice) {
      trade.peakPrice = price;
    }
    const peak = trade !== undefined ? trade.peakPrice : price;
    const entrySlot = trade !== undefined ? trade.entrySlot : state.slot;
    const tape = tapes.get(mint);
    const creatorSold =
      CREATOR_EXIT_ON &&
      trade !== undefined &&
      tape !== undefined &&
      tape.creatorSellSlot >= trade.entrySlot;
    const bigSold =
      BIG_SELL_EXIT_ON &&
      trade !== undefined &&
      tape !== undefined &&
      tape.bigSellSlot >= trade.entrySlot;
    const shouldSell =
      price >= entryPrice * TAKE_PROFIT ||
      price <= entryPrice * STOP_LOSS ||
      (peak >= entryPrice * TRAIL_ARM && price <= peak * TRAIL_GIVEBACK) ||
      state.slot - entrySlot >= MAX_HOLD_SLOTS ||
      creatorSold ||
      bigSold;
    if (shouldSell) {
      sells.push({
        side: "sell",
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      // Do NOT delete the trade record here (S1): it is deleted only when
      // the sell fill reports filled, in reconcileFills.
    }
  }
  return sells;
}

// Decide the buys for this batch: scan the fresh tapes for coins passing
// every filter, strongest buy volume first, mint address as the tiebreak so
// the choice is identical on every replay. Returns buy orders.
function decideBuys(state: BotState): Array<{
  side: "buy";
  mint: string;
  quote_lamports: bigint;
  max_slippage_bps: number;
}> {
  const buys: Array<{
    side: "buy";
    mint: string;
    quote_lamports: bigint;
    max_slippage_bps: number;
  }> = [];
  if (state.committedPositionCount() >= MAX_OPEN) return buys;
  const freeCash = state.freeCashLamports();
  if (freeCash < MIN_STAKE_LAMPORTS + state.txFeeLamports()) return buys;

  const candidates: Array<{ mint: string; buyVolume: bigint }> = [];
  for (const tape of tapes.values()) {
    if (deadMints.has(tape.mint)) continue;
    if (trades.has(tape.mint)) continue;
    if (state.positions.has(tape.mint)) continue;
    // A buy already in flight for this mint must not be re-issued: the
    // pendingBuys map is keyed by client_id, so check its values.
    let buyInFlight = false;
    for (const m of pendingBuys.values()) {
      if (m === tape.mint) { buyInFlight = true; break; }
    }
    if (buyInFlight) continue;
    const age = state.slot - tape.createdSlot;
    if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) continue;
    if (tape.buyTrades < MIN_BUY_TRADES) continue;
    if (tape.buyers.size < MIN_DISTINCT_BUYERS) continue;
    if (tape.buyVolume < MIN_BUY_VOLUME_LAMPORTS) continue;
    if (tape.sellVolume > 0n) {
      // buy volume must dominate sell volume by the required ratio:
      // buyVolume * 10 >= ratio * 10 * sellVolume, in integers.
      if (tape.buyVolume * 10n < BigInt(Math.round(MIN_BUY_SELL_RATIO * 10)) * tape.sellVolume) continue;
    }
    if (RECENCY_ON) {
      const cutoff = state.slot - RECENCY_SLOTS;
      let recentVolume = 0n;
      const recentBuyers = new Set<string>();
      let lastBuySlot = -1;
      for (const b of tape.recentBuys) {
        if (b.slot < cutoff) continue;
        recentVolume += b.amount;
        recentBuyers.add(b.user);
        if (b.slot > lastBuySlot) lastBuySlot = b.slot;
      }
      if (recentVolume < RECENCY_MIN_BUY_VOLUME) continue;
      if (recentBuyers.size < RECENCY_MIN_BUYERS) continue;
      if (state.slot - lastBuySlot > RECENCY_MAX_STALE_SLOTS) continue;
    }
    if (tape.feeBps > MAX_COMBINED_FEE_BPS) continue;
    const curve = state.curves.get(tape.mint);
    if (curve === undefined || curve.complete) continue;
    if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) continue;
    const price = priceOf(
      curve.virtual_quote_reserves,
      curve.virtual_token_reserves,
    );
    if (price <= 0 || tape.firstPrice <= 0) continue;
    const rise = price / tape.firstPrice;
    if (rise < MIN_RISE || rise > MAX_RISE) continue;
    if (price < tape.peakPrice * MAX_PULLBACK_FROM_PEAK) continue;
    candidates.push({ mint: tape.mint, buyVolume: tape.buyVolume });
  }
  // Strongest tape first; mint string breaks ties deterministically.
  candidates.sort((a, b) => {
    if (a.buyVolume !== b.buyVolume) return a.buyVolume > b.buyVolume ? -1 : 1;
    return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
  });

  let slotsLeft = MAX_OPEN - state.committedPositionCount();
  let cashLeft = freeCash;
  for (const candidate of candidates) {
    if (buys.length >= MAX_NEW_BUYS_PER_BATCH) break;
    if (slotsLeft <= 0) break;
    const cap = state.maxBuyLamports(candidate.mint);
    // Size with headroom under the 100 bps cap (S6): the real reserve can
    // fall between decision and fill (+2 slots), turning a full-cap buy
    // into a max_order_size rejection that used to burn the mint.
    const headroomCap = (cap * SIZE_HEADROOM_NUM) / SIZE_HEADROOM_DEN;
    let stake = STAKE_LAMPORTS < headroomCap ? STAKE_LAMPORTS : headroomCap;
    if (stake < MIN_STAKE_LAMPORTS) continue;
    const txFee = state.txFeeLamports();
    if (cashLeft < stake + txFee) {
      stake = cashLeft - txFee;
      if (stake < MIN_STAKE_LAMPORTS) break;
    }
    const curve = state.curves.get(candidate.mint);
    if (curve === undefined) continue;
    const price = priceOf(
      curve.virtual_quote_reserves,
      curve.virtual_token_reserves,
    );
    if (price <= 0) continue;
    buys.push({
      side: "buy",
      mint: candidate.mint,
      quote_lamports: stake,
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    });
    trades.set(candidate.mint, {
      mint: candidate.mint,
      entryPrice: price,
      entrySlot: state.slot,
      peakPrice: price,
    });
    deadMints.add(candidate.mint);
    cashLeft -= stake + txFee;
    slotsLeft -= 1;
  }
  return buys;
}

// Drop tapes that can no longer produce an entry, so the book stays small
// and the bot stays fast over a six-hour replay.
function pruneTapes(slot: number): void {
  if (tapes.size < 2000) return;
  for (const [mint, tape] of tapes) {
    if (slot - tape.createdSlot > MAX_AGE_SLOTS + 200 && !trades.has(mint)) {
      tapes.delete(mint);
    }
  }
}

// ------------------------------------------------------------------ the bot
await runBot({
  onHello(_state: BotState): void {
    // Nothing to precompute: every parameter is fixed above, and the hello
    // only tells us the capital, caps and fees the harness enforces.
  },

  onBatch(state: BotState, batch: Batch) {
    observeEvents(batch);
    reconcileFills(batch);
    const sells = decideSells(state);
    const buys = decideBuys(state);
    const orders = [...sells, ...buys];
    // Give every order an explicit client id here (the shim would assign
    // one, but then the fill could not be traced back to its mint). Both
    // buys and sells are tracked, so sell fills can be reconciled (S1/S5).
    for (const order of orders) {
      const id = state.clientId();
      (order as { client_id?: string }).client_id = id;
      if (order.side === "buy") pendingBuys.set(id, order.mint);
      else pendingSells.set(id, order.mint);
    }
    pruneTapes(state.slot);
    return orders;
  },

  onDone(_state: BotState): void {
    // The harness flattens every position at the end of the replay; there
    // is nothing left for the bot to do, and no reply is sent after done.
    // Report the reject split to stderr (diagnostics only, never stdout).
    const parts: string[] = [];
    for (const [key, count] of rejectCounts) parts.push(`${key}=${count}`);
    console.error(`foxfire rejects: ${parts.length > 0 ? parts.join(" ") : "none"}`);
  },
});
