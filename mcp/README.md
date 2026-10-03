# abx-artist-kit MCP

unofficial MCP server for artists launching on [abx](https://docs.abx.io), art blocks' open protocol.
it reads only. it never signs, holds keys or sends transactions.

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

## install

```
git clone https://github.com/keyrunnftart/abx-artist-kit
cd abx-artist-kit/mcp && npm install
claude mcp add abx-artist-kit -- node /full/path/abx-artist-kit/mcp/src/index.mjs
```

node 18+. `render_check` uses your installed chrome through playwright-core.
chains: `base` (8453) and `base-sepolia` (84532), public rpcs by default, `rpc` to use your own.

## p5 and other libraries on base

abx only knows art blocks' library registry on ethereum and sepolia. on base, `--dep p5@1.9.0` makes abx's live view load p5 from a cdn.
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
the base 721C validator and library registry, and rebuilds a live token. if anything changed it opens an issue with the changelog.
a lesson is wrong or fixed? open an issue or a PR on that file.

## test

```
npm test                                   # every tool except render, against live contracts
node test/client.mjs path/to/script.js     # over stdio like an agent, includes render_check
node test/deps.mjs                         # p5 from the on-chain registry; seeded vs unseeded sketch
node scripts/abx-watch.mjs                 # the weekly check, locally
```

made by keyrun while shipping "nothing here moves" on base. not affiliated with art blocks. MIT.
