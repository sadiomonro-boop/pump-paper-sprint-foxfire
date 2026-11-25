# pump-paper-sprint-foxfire

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/sadiomonro-boop/pump-paper-sprint-foxfire/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/sadiomonro-boop/pump-paper-sprint-foxfire/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Foxfire is a paper-trading bot for the make.fun "Pump.fun Paper Sprint: Any Bot Can Win" bounty. It replays pump.fun bonding curves and snipes fresh launches: it buys only newborn coins whose first minute shows real, broad buying (many distinct buyers, buy volume several times sell volume, price up a little but not parabolic), with a small fixed stake per coin, and exits fast on take-profit, stop-loss, trailing stop or a hard time stop. No real money, no network, fully deterministic.

Strategy at a glance: 0.015 SOL per coin, at most 5 open positions, one shot per mint; entry only 15–240 slots after creation with ≥8 buy trades, ≥8 distinct buyers, ≥3 SOL bought and buy volume ≥3× sell volume, price +12% to +45% off its first print, real reserve ≥2 SOL, no pullback >5% off peak; exits at +20% take-profit, −5% stop-loss, trailing stop after +10% (sell on 6% giveback), or a 450-slot time stop. Buys are sized at 0.9× the 100 bps per-order cap with 1000 bps slippage; sells use 2000 bps slippage so exits fill in a fast dump. Entry price is recomputed from the buy fill, and a sell's trade record is deleted only when its fill confirms.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout: the harness sends a `hello`, then one `batch` per slot, and the bot answers each batch with its `orders`. It needs Node 22.18 or later (the grader runs Node 22.23.4) and nothing to install.

---

<sub>Entered on [make.fun](https://make.fun/?ref=plucky-panda-24&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
