# nothing here moves .. rebuild from chain

"nothing here moves" by keyrun is an on-chain op-art series on Base, built on [ABX](https://docs.abx.io).
This script rebuilds any token from the contract alone. No ABX server, no keyrun server, no libraries.

```
node rebuild.mjs 2        # writes nhm_2.html .. open it in a browser
node rebuild.mjs 2 --rpc https://your-base-rpc
```

Needs Node 18+. Nothing to install.

It reads these from `0xB13971551bd3C14A0F793571347dDCdfB08902ba` on Base (chain 8453) with plain `eth_call`:

- the artist code: `scriptChunk(i)`. 21,863 bytes, 1 chunk, locked forever
- the token's mint seed: `tokenParam(id, "seed")`
- every other input the contract stores: `tokenParamKeys` / `contractParamKeys`. There are none, the seed is the only one

Then it wraps code + seed the same way ABX's generator does and writes one HTML file.
The code uses no libraries and loads no URLs. Traits print to the browser console.

Checked on 4 Oct 2026: tokens #2 and #10 rebuilt here match all 11 traits served by ABX's resolver,
and #2 is visually identical to ABX's thumbnail (`compare_2.jpg`: left = rebuilt from chain, right = ABX render).

What is off-chain, same as Art Blocks: the thumbnail image and the metadata JSON (served by resolver.abx.io).
Both can be recomputed from what's on-chain.

MIT
