# pump-paper-sprint-foxfire

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/sadiomonro-boop/pump-paper-sprint-foxfire/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/sadiomonro-boop/pump-paper-sprint-foxfire/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Foxfire is a paper-trading bot for the make.fun "Pump.fun Paper Sprint: Any Bot Can Win" bounty. It replays pump.fun bonding curves and snipes fresh launches: it buys only newborn coins whose first minute shows real, broad buying (many distinct buyers, buy volume several times sell volume, price up a little but not parabolic), with a small fixed stake per coin, and exits fast on take-profit, stop-loss, trailing stop or a hard time stop. No real money, no network, fully deterministic.

Strategy at a glance: 0.04 SOL per coin, at most 5 open positions, one shot per mint; entry only 15–400 slots after creation with ≥6 buy trades, ≥5 distinct buyers, ≥1.5 SOL bought and buy volume ≥2.5× sell volume; exits at +30% take-profit, −12% stop-loss, trailing stop after +15%, or a 1200-slot time stop.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout: the harness sends a `hello`, then one `batch` per slot, and the bot answers each batch with its `orders`. It needs Node 22.18 or later (the grader runs Node 22.23.4) and nothing to install.

---

<sub>Entered on [make.fun](https://make.fun/?ref=plucky-panda-24&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
