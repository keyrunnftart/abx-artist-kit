// read-only chain access for ABX SeriesCode contracts .. plain eth_call, no keys, no ABX servers.

export const CHAINS = {
  // production (abx beta networks)
  base: { id: 8453, rpcs: ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org'], explorer: 'https://basescan.org' },
  ethereum: { id: 1, rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'], explorer: 'https://etherscan.io' },
  arbitrum: { id: 42161, rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'], explorer: 'https://arbiscan.io' },
  robinhood: { id: 4663, rpcs: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'], explorer: 'https://robinhoodchain.blockscout.com' },
  // testnets
  'base-sepolia': { id: 84532, rpcs: ['https://base-sepolia-rpc.publicnode.com', 'https://sepolia.base.org'], explorer: 'https://sepolia.basescan.org' },
  sepolia: { id: 11155111, rpcs: ['https://ethereum-sepolia-rpc.publicnode.com'], explorer: 'https://sepolia.etherscan.io' },
  'arbitrum-sepolia': { id: 421614, rpcs: ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com'], explorer: 'https://sepolia.arbiscan.io' },
  'robinhood-testnet': { id: 46630, rpcs: ['https://rpc.testnet.chain.robinhood.com', 'https://robinhood-sepolia-rpc.publicnode.com'], explorer: 'https://explorer.testnet.chain.robinhood.com' },
};
export const CHAIN_KEYS = Object.keys(CHAINS);

// Art Blocks DependencyRegistryV0 .. ABX resolves name@version libraries through it on Ethereum (1) and
// Sepolia (11155111) only. Base, Arbitrum and Robinhood have none (checked on CLI 0.6.0).
export const AB_DEPENDENCY_REGISTRY = { 1: '0x37861f95882ACDba2cCD84F5bFc4598e2ECDDdAF', 11155111: '0x5Fcc415BCFb164C5F826B5305274749BeB684e9b' };
export const hasDependencyRegistry = (chain) => !!AB_DEPENDENCY_REGISTRY[CHAINS[chain]?.id];

// ABX's recommended 721C validator (OpenSea's StrictAuthorizedTransferSecurityRegistry) .. known for these chains only
// (CLI 0.6.0). On arbitrum / robinhood `--721c recommended` has no answer, so pass an address or leave 721C off.
export const RECOMMENDED_721C = { 1: '0xA000027A9B2802E1ddf7000061001e5c005A0000', 11155111: '0xA000027A9B2802E1ddf7000061001e5c005A0000',
  8453: '0xA000027A9B2802E1ddf7000061001e5c005A0000', 84532: '0xA000027A9B2802E1ddf7000061001e5c005A0000' };

// selectors from the ABX SDK seriesCodeAbi (CLI 0.2.0)
export const SEL = {
  name: '0x06fdde03', symbol: '0x95d89b41', owner: '0x8da5cb5b', paused: '0x5c975abb',
  totalSupply: '0x18160ddd', maxInvocations: '0x6cbdef61', minter: '0x07546172', primaryPayee: '0xd8b4f8ac',
  getTransferValidator: '0x098144d4', royaltyInfo: '0x2a55205a', maxRoyaltyBps: '0xb18f004a',
  scriptChunkCount: '0x92d9906f', scriptChunk: '0x6aaf7607', scriptLocked: '0x7d0b7ae4',
  dependencyCount: '0xd90f5df2', dependenciesLocked: '0xea58f971',
  paramHooks: '0x3c59f1bb', paramHooksLocked: '0x6c59f759',
  tokenURIBase: '0x261220a3', tokenURILocked: '0xac998f45', tokenURIRenderer: '0xd50bac33',
  contractParamKeys: '0x55580cca', tokenParamKeys: '0xe1b79381', tokenParam: '0x6bd39222',
  tokenURI: '0xc87b56dd', minterSales: '0xc6b9f06a',
  dependencyByIndex: '0xcfc59afd', dependencyRegistry: '0x20ac0944',
  // on the registry contract
  getDependencyDetails: '0x25ffb376', getDependencyScript: '0x518cb3df',
};

export const word = (n) => BigInt(n).toString(16).padStart(64, '0');
export const key32 = (s) => Buffer.from(s).toString('hex').padEnd(64, '0');
export const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const words = (hex) => hex.replace(/^0x/, '').match(/.{64}/g) ?? [];
export const asAddr = (w) => '0x' + w.slice(24);
export const asUint = (w) => BigInt('0x' + w);
export const asBool = (w) => BigInt('0x' + w) === 1n;
export const ZERO = '0x0000000000000000000000000000000000000000';

export function chainOf(name = 'base') {
  const c = CHAINS[name];
  if (!c) throw new Error(`unknown chain "${name}" .. use one of ${Object.keys(CHAINS).join(', ')}`);
  return c;
}

async function rpcRequest(chain, method, params, rpc) {
  const urls = rpc ? [rpc] : chainOf(chain).rpcs;
  let last;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'abx-artist-kit' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await res.json();
      if (j.result !== undefined) return j.result;
      last = j.error?.message ?? JSON.stringify(j);
      if (/revert/i.test(last)) throw Object.assign(new Error(last), { revert: true });
    } catch (e) {
      if (e.revert) throw e;
      last = e.message;
    }
  }
  throw new Error(`${method} failed on every RPC: ${last}`);
}

export const ethCall = (chain, to, data, rpc) => rpcRequest(chain, 'eth_call', [{ to, data }, 'latest'], rpc);
export const getCode = (chain, address, rpc) => rpcRequest(chain, 'eth_getCode', [address, 'latest'], rpc);

// returns null instead of throwing when the function reverts or doesn't exist
export async function tryCall(chain, to, data, rpc) {
  try {
    const r = await ethCall(chain, to, data, rpc);
    return r === '0x' ? null : r;
  } catch (e) {
    if (e.revert) return null;
    throw e;
  }
}

export function decodeBytes(hex) {
  const h = hex.replace(/^0x/, '');
  const off = Number(BigInt('0x' + h.slice(0, 64))) * 2;
  const len = Number(BigInt('0x' + h.slice(off, off + 64)));
  return Buffer.from(h.slice(off + 64, off + 64 + len * 2), 'hex');
}
export const decodeString = (hex) => decodeBytes(hex).toString('utf8');

export function decodeKeys(hex) {
  const w = words(hex);
  const n = Number(asUint(w[1]));
  return w.slice(2, 2 + n).map((k) => Buffer.from(k, 'hex').toString().replace(/\0+$/, ''));
}

export async function readScript(chain, contract, rpc) {
  const count = Number(asUint(words(await ethCall(chain, contract, SEL.scriptChunkCount, rpc))[0]));
  const chunks = [];
  for (let i = 0; i < count; i++) chunks.push(decodeBytes(await ethCall(chain, contract, SEL.scriptChunk + word(i), rpc)));
  return { count, script: chunks.map((c) => c.toString('utf8')).join('\n') }; // ABX joins chunks with a newline
}

export async function readSeed(chain, contract, tokenId, rpc) {
  const [value, isHash, isSet] = words(await ethCall(chain, contract, SEL.tokenParam + word(tokenId) + key32('seed'), rpc));
  if (!asBool(isSet)) return null;
  return { seed: '0x' + value, isHash: asBool(isHash) };
}

// string at a head slot of an ABI-encoded tuple
function tupleString(hex, slot) {
  const h = hex.replace(/^0x/, '');
  const off = Number(BigInt('0x' + h.slice(slot * 64, slot * 64 + 64))) * 2;
  const len = Number(BigInt('0x' + h.slice(off, off + 64)));
  return Buffer.from(h.slice(off + 64, off + 64 + len * 2), 'hex').toString('utf8');
}

export async function readDependencies(chain, contract, rpc) {
  const n = await tryCall(chain, contract, SEL.dependencyCount, rpc);
  const count = n ? Number(asUint(words(n)[0])) : 0;
  const list = [];
  for (let i = 0; i < count; i++) {
    const [res, ref] = words(await ethCall(chain, contract, SEL.dependencyByIndex + word(i), rpc));
    const onchain = Number(asUint(res)) === 1;
    list.push({ index: i, resolution: onchain ? 'onchain' : 'registry', ref: '0x' + ref,
      name: onchain ? '0x' + ref.slice(0, 40) : Buffer.from(ref, 'hex').toString().replace(/\0+$/, '') });
  }
  const reg = count ? await tryCall(chain, contract, SEL.dependencyRegistry, rpc) : null;
  return { list, registry: reg ? asAddr(words(reg)[0]) : null };
}

export async function registryDetails(chain, registry, nameAtVersion, rpc) {
  const ref = Buffer.from(nameAtVersion).toString('hex').padEnd(64, '0');
  const r = await tryCall(chain, registry, SEL.getDependencyDetails + ref, rpc);
  if (!r) return null;
  const w = words(r);
  const d = { license: tupleString(r, 1), cdn: tupleString(r, 2), repo: tupleString(r, 4), website: tupleString(r, 6),
    availableOnChain: asBool(w[7]), scriptCount: Number(asUint(w[8])) };
  const exists = d.license || d.cdn || d.repo || d.website || d.availableOnChain || d.scriptCount > 0;
  return exists ? d : null;
}

export async function registryScript(chain, registry, nameAtVersion, count, rpc) {
  const ref = Buffer.from(nameAtVersion).toString('hex').padEnd(64, '0');
  const parts = [];
  for (let i = 0; i < count; i++) parts.push(decodeString(await ethCall(chain, registry, SEL.getDependencyScript + ref + word(i), rpc)));
  return parts.join(''); // base64 of gzip, like ABX expects
}
