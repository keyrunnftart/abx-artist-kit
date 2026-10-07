# abx-artist-kit MCP

unofficial MCP server for artists launching on [abx](https://docs.abx.io), art blocks' open protocol.
it reads only. it never signs, holds keys or sends transactions. the one exception is opt-in: `marketplace_check` with `refresh: true` asks opensea's api to refresh stale tokens.

it doesn't wrap the abx cli (agents can run that directly). it adds what the cli doesn't:

| tool | what it does |
|---|---|
| `rebuild_token` | rebuilds any abx code token from the chain alone (code chunks + mint seed + libraries) into one html file, and says which parts, if any, still come from a CDN |
| `inspect_contract` | owner, supply, sale (price / allocation / sold), payee, royalty, 721C, script + hook locks, metadata base, plain notes |
| `lint_script` | size + chunk splits, Math.random / clock / crypto, seed use, abx.done / abx.traits, modules, urls, storage, libraries |
| `render_check` | renders N random seeds in headless chrome, with your libraries (e.g. `["p5@1.0.0"]`): time vs the ~10s renderer limit, same seed twice = same image, Math.random/fetch probe, square canvas, trait spread |
| `preflight` | checks planned abx commands for known launch pitfalls before anything is signed |
| `list_libraries` | the libraries in art blocks' registry (p5, three, tone, …) and which versions are stored fully on-chain |
| `lessons` | launch lessons the docs don't cover, tagged with the cli version they were seen in; warns when your cli is newer |
| `deploy_cost` | what deploy + code upload costs on each abx chain at live gas, abx's own gas model plus the L1 data fee rollups add, in ETH and USD, and whether abx pays it for you (`--sponsor`, base only) |
| `edition_preview` | renders 10-400 fixed seeds into a contact sheet PNG with trait odds, rare values and unique combos .. see the edition before you deploy |
| `mint_check` | simulates a mint from any wallet on the live minter (no signing): sold out, paused, balance vs price + fee, the revert reason in plain words |
| `collectors` | every mint from chain logs: minters ranked, owner reserves flagged, verified ens names, traits, rare pulls per wallet .. for rewards and thank-yous |
| `wave_status` | price, wave allocation, sold, left, mints in the last 24 h, last mint, sell-out time and when your next wave may open |
| `export_token` | rebuilds a token from chain and renders it up to 8192 px as a PNG (print files, rewards) |
| `marketplace_check` | compares each token's own metadata with OpenSea's copy (placeholder image, missing traits), refreshes only if you ask |

## install

```
git clone https://github.com/keyrunnftart/abx-artist-kit
cd abx-artist-kit/mcp && npm install
claude mcp add abx-artist-kit -- node /full/path/abx-artist-kit/mcp/src/index.mjs
```

node 18+. `render_check` uses your installed chrome through playwright-core.
chains: every network abx 0.6.0 ships, with abx's own public rpcs by default (`rpc` to use your own):

| production (abx beta) | testnet |
|---|---|
| `base` 8453 | `base-sepolia` 84532 |
| `ethereum` 1 (abx 0.5.0+) | `sepolia` 11155111 |
| `arbitrum` 42161 | `arbitrum-sepolia` 421614 |
| `robinhood` 4663 | `robinhood-testnet` 46630 |

`preflight` knows what differs per chain: `--721c recommended` resolves on ethereum, sepolia, base and base-sepolia only,
ethereum needs cli 0.5.0+ and costs far more gas to store code, only ethereum + sepolia have art blocks' library registry,
and `--sponsor` (abx pays the gas) only exists on base and base-sepolia, everywhere else your wallet pays.

## p5 and other libraries

abx only knows art blocks' library registry on ethereum and sepolia. there, `--dep p5@1.0.0` is served from chain.
on base, arbitrum and robinhood, `--dep p5@1.9.0` makes abx's live view load p5 from a cdn.
only some versions are stored on-chain (`list_libraries`): p5@1.0.0, three@0.124.0, cannon-es@0.20.0 as of oct 2026.
pick one of those and `rebuild_token` pulls the library bytes from ethereum, so the piece can still be rebuilt from chain data alone.
zero-dependency vanilla js is the simplest fully on-chain path.

checked on 4 oct 2026 with a p5 test project on base sepolia ([`0xa751…179F`](https://sepolia.basescan.org/address/0xa751722C9268cd5e660b04BD162852463D57179F), `--dep p5@1.0.0`):
abx's live view loads p5 from jsdelivr; `rebuild_token` pulled the same p5 from ethereum (623 kB) and the code + seed from base,
and drew the same image and traits as abx's render ([`test/fixtures/p5_compare.jpg`](test/fixtures/p5_compare.jpg): left rebuilt, right abx).

## lessons go stale

abx is pre-1.0 and changes. every lesson says which cli version it was seen in (`src/lessons.json`).
when your cli is newer, `lessons` says so, and each lesson shows `fixed in x.y.z` once abx fixes it.
every monday a github action (`abx watch`) installs the latest abx, checks the contract functions, the page abx builds around a script,
the chain list, where abx knows a 721C validator and a library registry, and rebuilds a live token. if anything changed it opens an issue with the changelog.
a lesson is wrong or fixed? open an issue or a PR on that file.

## test

```
npm test                                   # every tool except render, against live contracts
node test/client.mjs path/to/script.js     # over stdio like an agent, includes render_check
node test/deps.mjs                         # p5 from the on-chain registry; seeded vs unseeded sketch
node test/launch.mjs path/to/script.js out # the launch tools over stdio against "nothing here moves" (ALL=1 adds collectors)
node scripts/abx-watch.mjs                 # the weekly check, locally
```

made by keyrun while shipping "nothing here moves" on base. not affiliated with art blocks. MIT.
