// Foxfire — a fresh-launch sniper for the pump.fun paper sprint.
// Protocol: agent-fun/replay/v2. The harness sends a hello, then one batch
// per slot, and this bot answers each batch with its orders for that slot.
// Orders decided on slot s fill at slot s + latency (2 slots).
//
// Idea, in one paragraph: most pump.fun coins die within minutes, so the
// bot never chases a coin that is already old or already pumped. It watches
// every newborn curve for its first minute of life and only buys when real
// buyers are piling in together — many distinct buyers, buy volume several
// times sell volume, price up a little but not yet parabolic — then it
// exits fast: a modest take-profit, a tight stop, a trailing stop once the
// trade is working, and a hard time stop so no position is left to bleed.
// One small fixed stake per coin, at most five open positions, one shot per
// mint, so the book spreads across many coins and no single rug can sink it.
//
// Everything here is deterministic: no clock, no environment, no unseeded
// randomness. The same hello + batches always produce the same orders.

import { runBot } from "./vendor/agentfun-bot.ts";
import type { Batch, BotState } from "./vendor/agentfun-bot.ts";

// ------------------------------------------------------------------ tuning
// All sizes in lamports unless noted. 1 SOL = 1_000_000_000 lamports.
const STAKE_LAMPORTS = 40_000_000n; // 0.04 SOL per coin
const MIN_STAKE_LAMPORTS = 20_000_000n; // never buy less than 0.02 SOL
const MAX_OPEN = 5; // harness cap; also enforced by the harness
const MAX_NEW_BUYS_PER_BATCH = 2; // spread entries; never chase a whole batch

// Entry window, in slots after the coin is created (a slot is ~0.4 s).
const MIN_AGE_SLOTS = 15; // let the first flurry of trades print first
const MAX_AGE_SLOTS = 240; // older than ~100 s is no longer a fresh launch
const MIN_REAL_SOL_LAMPORTS = 2_000_000_000n; // real reserve >= 2 SOL, so
// the 100 bps per-order cap still allows a >= 0.02 SOL buy.

// What "real buyers are piling in" means, measured over the coin's life so far.
const MIN_BUY_TRADES = 10; // at least ten buy prints
const MIN_DISTINCT_BUYERS = 8; // at least eight different wallets buying
const MIN_BUY_VOLUME_LAMPORTS = 3_000_000_000n; // >= 3 SOL bought
const MIN_BUY_SELL_RATIO = 3.0; // buy volume >= 3x sell volume
const MIN_RISE = 1.12; // price up >= 12% from its first print
const MAX_RISE = 1.45; // ... but up more than 45% is chasing the top
const MAX_PULLBACK_FROM_PEAK = 0.95; // skip coins already dumping off a peak

// Exits, as multiples of the entry price. v2: exits are much faster than
// v1's — pump.fun moves happen in the first minutes, and a coin that has not
// paid within ~3 minutes is usually just decaying into fees.
// v3: the stop is a touch tighter, and the sell slippage is much wider —
// v2's worst losses (-27%) were sells rejected on 8% slippage while the
// coin dumped through the stop; an exit that does not fill is no exit.
const TAKE_PROFIT = 1.2; // sell the whole position at +20%
const STOP_LOSS = 0.93; // sell the whole position at -7%
const TRAIL_ARM = 1.1; // trailing stop arms once the trade is +10%
const TRAIL_GIVEBACK = 0.94; // ... then sell if it falls 6% off its peak
const MAX_HOLD_SLOTS = 450; // hard time stop: ~3 minutes, then sell

const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 2000; // exits must fill even in a fast dump

// ------------------------------------------------------------------ helpers
function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken <= 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

// ------------------------------------------------------------------ per-coin tape
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
}

// What we remember about a position we opened.
interface OpenTrade {
  mint: string;
  entryPrice: number; // price (quote per token) when the buy was decided
  entrySlot: number; // slot the buy was decided on
  peakPrice: number; // highest price seen since entry
}

const tapes = new Map<string, CoinTape>();
const trades = new Map<string, OpenTrade>(); // mint -> open trade record
const pendingBuys = new Map<string, string>(); // client_id -> mint
const deadMints = new Set<string>(); // mints already traded once: one shot only
let lastSlot = -1;

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
      const price = priceOf(
        BigInt(event.virtual_quote_reserves),
        BigInt(event.virtual_token_reserves),
      );
      if (price > 0) {
        if (tape.firstPrice === 0) tape.firstPrice = price;
        if (price > tape.peakPrice) tape.peakPrice = price;
      }
      const amount = BigInt(event.sol_amount);
      if (event.is_buy) {
        tape.buyTrades += 1;
        tape.buyVolume += amount;
        tape.buyers.add(event.user);
      } else {
        tape.sellTrades += 1;
        tape.sellVolume += amount;
      }
      tape.seen = true;
    } else {
      // CompleteEvent: the curve migrated; the harness closes any position
      // in it for us, so drop the tape and the trade record.
      tapes.delete(event.mint);
      trades.delete(event.mint);
      deadMints.add(event.mint);
    }
  }
}

// Reconcile our own books with the fills the harness reports for this batch:
// a buy that was rejected or failed never opens a position, so drop its
// trade record (the mint stays dead — one shot per mint — but a stale record
// must not linger as if a position existed).
function reconcileFills(batch: Batch): void {
  for (const fill of batch.fills) {
    const mint = pendingBuys.get(fill.client_id);
    if (mint === undefined) continue;
    pendingBuys.delete(fill.client_id);
    if (fill.side === "buy" && fill.status !== "filled") {
      trades.delete(mint);
    }
  }
}

// Decide the sells for this batch: take-profit, stop-loss, trailing stop and
// time stop, all read off the harness's own account (tokens actually held)
// and the latest curve price. Returns sell orders, most urgent first.
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
  for (const [mint, holding] of state.positions) {
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
    const shouldSell =
      price >= entryPrice * TAKE_PROFIT ||
      price <= entryPrice * STOP_LOSS ||
      (peak >= entryPrice * TRAIL_ARM && price <= peak * TRAIL_GIVEBACK) ||
      state.slot - entrySlot >= MAX_HOLD_SLOTS;
    if (shouldSell) {
      sells.push({
        side: "sell",
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      trades.delete(mint);
      deadMints.add(mint);
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
    let stake = STAKE_LAMPORTS < cap ? STAKE_LAMPORTS : cap;
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
    lastSlot = state.slot;
    observeEvents(batch);
    reconcileFills(batch);
    const sells = decideSells(state);
    const buys = decideBuys(state);
    const orders = [...sells, ...buys];
    // Give every buy an explicit client id here (the shim would assign one,
    // but then the fill could not be traced back to its mint). Sells keep
    // the shim's ids: their fills need no bookkeeping.
    for (const order of orders) {
      if (order.side === "buy") {
        const id = state.clientId();
        (order as { client_id?: string }).client_id = id;
        pendingBuys.set(id, order.mint);
      }
    }
    pruneTapes(state.slot);
    return orders;
  },

  onDone(_state: BotState): void {
    // The harness flattens every position at the end of the replay; there
    // is nothing left for the bot to do, and no reply is sent after done.
  },
});
