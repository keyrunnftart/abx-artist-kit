# abx-artist-kit MCP

unofficial MCP server for artists launching on [abx](https://docs.abx.io), art blocks' open protocol.
it reads only. it never signs, holds keys or sends transactions.

it doesn't wrap the abx cli (agents can run that directly). it adds what the cli doesn't:

| tool | what it does |
|---|---|
| `rebuild_token` | rebuilds any abx code token from the chain alone (code chunks + mint seed via eth_call) into one html file |
| `inspect_contract` | owner, supply, sale (price / allocation / sold), payee, royalty, 721C, script + hook locks, metadata base, plain notes |
| `lint_script` | size + chunk splits, Math.random / clock / crypto, seed use, abx.done / abx.traits, modules, urls, storage, libraries |
| `render_check` | renders N random seeds in headless chrome: time vs the ~10s renderer limit, same seed twice = same image, Math.random/fetch probe, square canvas, trait spread |
| `preflight` | checks planned abx commands for known launch pitfalls before anything is signed |
| `lessons` | launch lessons the docs don't cover, tagged with the cli version they were seen in; warns when your cli is newer |

## install

```
git clone https://github.com/keyrunnftart/abx-artist-kit
cd abx-artist-kit/mcp && npm install
claude mcp add abx-artist-kit -- node /full/path/abx-artist-kit/mcp/src/index.mjs
```

node 18+. `render_check` uses your installed chrome through playwright-core.
chains: `base` (8453) and `base-sepolia` (84532), public rpcs by default, `rpc` to use your own.

## lessons go stale

abx is pre-1.0 and changes. every lesson says which cli version it was seen in (`src/lessons.json`).
when your cli is newer, `lessons` says so. a lesson is wrong or fixed? open an issue or a PR on that file.

## test

```
npm test                                   # every tool except render, against live contracts
node test/client.mjs path/to/script.js     # over stdio like an agent, includes render_check
```

made by keyrun while shipping "nothing here moves" on base. not affiliated with art blocks. MIT.
