#!/usr/bin/env node
// abx-artist-kit MCP .. unofficial helper for artists launching on ABX (Art Blocks' open protocol).
// read-only: it never signs, never holds keys, never sends transactions.

// run by hand in a terminal (not by an MCP client): print how to add it instead of waiting silently on stdin
const ARGS = process.argv.slice(2);
if (ARGS.includes('--version') || ARGS.includes('-v')) { console.log('abx-artist-kit 0.4.2'); process.exit(0); }
if (ARGS.includes('--help') || ARGS.includes('-h') || process.stdin.isTTY) {
  console.log(`abx-artist-kit 0.4.2 .. unofficial MCP for artists launching on abx (read-only, never signs)

this is an MCP server: your agent starts it, you don't run it by hand.

claude code:
  claude mcp add abx-artist-kit -- npx -y abx-artist-kit

any other MCP client (claude desktop, cursor, ...), add to its mcp config:
  { "mcpServers": { "abx-artist-kit": { "command": "npx", "args": ["-y", "abx-artist-kit"] } } }

render tools (render_check, edition_preview, export_token) use your installed chrome.
docs: https://github.com/keyrunnftart/abx-artist-kit`);
  process.exit(0);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { rebuildToken, inspectContract, lintScript, renderCheck, preflight, lessons } from './tools.mjs';
import { listLibraries } from './deps.mjs';
import { CHAIN_KEYS } from './chain.mjs';
import { deployCost, editionPreview, mintCheck, collectors, waveStatus, exportToken, marketplaceCheck } from './launch.mjs';

const server = new McpServer({ name: 'abx-artist-kit', version: '0.4.2' });

const chain = z.enum(CHAIN_KEYS).default('base').describe('abx chain: base (8453), ethereum (1), arbitrum (42161), robinhood (4663), or a testnet: base-sepolia, sepolia, arbitrum-sepolia, robinhood-testnet');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe('ABX contract address');
const rpc = z.string().url().optional().describe('optional RPC URL; defaults to the public RPCs abx ships for that chain');

const wrap = (fn) => async (args) => {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await fn(args), null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] };
  }
};

server.registerTool('rebuild_token', {
  title: 'Rebuild a token from the chain',
  description: "Rebuilds an ABX code token from the contract alone: reads the artist code (script chunks), the token's mint seed and its libraries (on-chain data contracts, or Art Blocks' registry on Ethereum), wraps them like ABX's generator and writes a standalone HTML file. No ABX servers. Says which parts, if any, still come from a CDN.",
  inputSchema: { contract: address, tokenId: z.number().int().min(0), chain, rpc, outDir: z.string().optional().describe('folder for the HTML (default: current dir)') },
}, wrap(rebuildToken));

server.registerTool('inspect_contract', {
  title: 'Inspect an ABX contract',
  description: 'Read-only snapshot of an ABX contract: owner, supply/max, paused, minter sale (price, allocation, sold), payee, royalty, 721C validator, script lock, param hooks, metadata base. Adds plain-language notes on what collectors should know.',
  inputSchema: { contract: address, chain, rpc },
}, wrap(inspectContract));

server.registerTool('lint_script', {
  title: 'Lint an ABX script',
  description: 'Static checks on a generative script before upload: size and chunk splits, Math.random/clock/crypto randomness, abx.tokenData/seed use, abx.done()/abx.traits(), ES modules, network/external URLs, storage, likely libraries.',
  inputSchema: { path: z.string().describe('path to the .js file that will be uploaded') },
}, wrap(lintScript));

server.registerTool('render_check', {
  title: 'Render random seeds',
  description: 'Renders the script for N random seeds in headless Chrome the way ABX wraps it: times each render against the hosted renderer\'s ~10s limit, renders one seed twice to prove determinism, counts Math.random/fetch calls, checks square canvas, and tallies trait distribution. Needs Chrome + playwright-core.',
  inputSchema: {
    path: z.string(),
    seeds: z.number().int().min(1).max(200).default(10),
    size: z.number().int().min(200).max(2160).default(1000).describe('viewport px; ABX thumbnails are 1000'),
    timeoutSec: z.number().int().min(5).max(120).default(20),
    chromePath: z.string().optional(),
    dependencies: z.array(z.string()).default([]).describe('libraries in --dep order, e.g. ["p5@1.9.0"] or a 0x data-contract address'),
    chain: z.enum(CHAIN_KEYS).default('base').describe('chain for 0x data-contract dependencies'),
  },
}, wrap(renderCheck));

server.registerTool('preflight', {
  title: 'Preflight a deploy plan',
  description: 'Checks planned abx CLI commands (deploy, attach, set-admin, lock-script, ...) against known launch pitfalls before anything is signed: 721C on Base mainnet, collection image override, on-chain URI without traits, sponsor without handover, missing payee/max/minter, royalty, script lock.',
  inputSchema: {
    commands: z.string().describe('the commands you plan to run, one per line'),
    chain: z.enum(CHAIN_KEYS).optional(),
    cliVersion: z.string().optional().describe('your abx-cli version (abx --version); some pitfalls are fixed in newer versions'),
  },
}, wrap(preflight));

server.registerTool('list_libraries', {
  title: 'On-chain libraries',
  description: "Lists the libraries in Art Blocks' dependency registry on Ethereum (p5, three, tone, ...) and which ones are stored fully on-chain, with notes on what that means for an ABX project on Base.",
  inputSchema: {},
}, wrap(listLibraries));

server.registerTool('lessons', {
  title: 'ABX launch lessons',
  description: 'Lessons from real ABX launches that the docs don\'t cover, each tagged with the CLI version it was seen in. Detects the installed abx-cli and warns when it is newer, since a lesson may already be fixed.',
  inputSchema: {
    topic: z.string().optional().describe('metadata, deploy, render, script, marketplace, infra, signing, trust, or a lesson id'),
    projectDir: z.string().optional().describe('folder where @artblocks/abx-cli is installed'),
  },
}, wrap(lessons));

// ---------- launch tools (from running "nothing here moves" on abx) ----------
const wallet = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe('wallet address');

server.registerTool('deploy_cost', {
  title: 'What the launch costs, per chain',
  description: "Estimates deploy + code-upload cost for a script on each abx chain at live gas prices, using abx cli 0.6.0's own dry-run gas model, plus the L1 data fee rollups charge for the bytes (which abx's figure leaves out). Shows ETH and USD side by side so you can pick a chain before signing anything.",
  inputSchema: {
    path: z.string().optional().describe('the .js you will upload'), bytes: z.number().int().positive().optional().describe('or just its size in bytes'),
    chains: z.array(z.enum(CHAIN_KEYS)).default(['base', 'ethereum', 'arbitrum', 'robinhood']),
    dependencies: z.number().int().min(0).default(0), schemas: z.number().int().min(0).default(0), mints: z.number().int().min(0).default(0).describe('reserve mints at deploy'),
  },
}, wrap(deployCost));

server.registerTool('edition_preview', {
  title: 'Preview the edition before deploy',
  description: 'Renders 10-400 fixed seeds of the script in Chrome the way abx wraps it and saves a contact sheet PNG (each thumb captioned with a trait) plus trait odds, rare values (<5%) and unique trait combos. Shows whether rares are really rare and gives launch visuals.',
  inputSchema: {
    path: z.string(), seeds: z.number().int().min(1).max(400).default(100), thumb: z.number().int().min(80).max(400).default(180),
    size: z.number().int().min(200).max(2160).default(600).describe('render viewport px'), cols: z.number().int().min(1).max(30).optional(),
    labelTrait: z.string().optional().describe('trait shown under each thumb (default: the first trait with 2-12 values)'),
    dependencies: z.array(z.string()).default([]), chain: z.enum(CHAIN_KEYS).default('base'), outDir: z.string().optional(), chromePath: z.string().optional(),
  },
}, wrap(editionPreview));

server.registerTool('mint_check', {
  title: "Why can't this wallet mint?",
  description: 'Simulates a mint from any wallet on the live abx minter without signing: sale configured, wave allocation, paused, max supply, balance vs price + network fee (incl. L1 fee), and the exact revert reason in plain words. For helping collectors during a drop.',
  inputSchema: { contract: address, wallet, chain, rpc },
}, wrap(mintCheck));

server.registerTool('collectors', {
  title: 'Who minted what',
  description: 'Every mint of an abx collection from chain logs (no API keys): minter per token, wallets ranked by mints, owner reserves flagged, verified ENS names, traits per token from tokenURI, and optional rare pulls per wallet (e.g. rareTrait "Mode", rareValues ["Void","Mono"]). For rewards, thank-you posts, airdrops. First run scans from the deploy block (1-3 min on public rpcs; pass fromBlock to skip the search).',
  inputSchema: {
    contract: address, chain, fromBlock: z.number().int().min(0).optional(), names: z.boolean().default(true), traits: z.boolean().default(true),
    rareTrait: z.string().optional(), rareValues: z.array(z.string()).default([]), rpc,
  },
}, wrap(collectors));

server.registerTool('wave_status', {
  title: 'Where the sale stands',
  description: 'Live sale state for an abx collection: price, wave allocation, sold, left in the wave, supply, paused, mints in the last 24 h, last mint time; when a wave is sold out, the sell-out time and (with breakHours) when your next wave may open.',
  inputSchema: { contract: address, chain, breakHours: z.number().min(0).max(720).optional().describe('your own rule: hours between sell-out and the next wave'), rpc },
}, wrap(waveStatus));

server.registerTool('export_token', {
  title: 'Print-size render from chain',
  description: 'Rebuilds a token from chain data alone (like rebuild_token) and renders it at any width up to 8192 px, saving the canvas pixels as PNG (8K print files, collector rewards). Passes ?w= for pieces that read it.',
  inputSchema: { contract: address, tokenId: z.number().int().min(0), chain, width: z.number().int().min(256).max(8192).default(4096), outDir: z.string().optional(), chromePath: z.string().optional(), rpc },
}, wrap(exportToken));

server.registerTool('marketplace_check', {
  title: 'Does OpenSea show the right thing?',
  description: "Compares each token's own metadata (tokenURI image + traits, what abx serves) with OpenSea's copy: placeholder image, missing or different traits. Gives the OpenSea item link; with an OPENSEA_API_KEY it reads OpenSea directly, and with refresh: true asks OpenSea to refresh stale tokens (the only write, and only when you ask).",
  inputSchema: { contract: address, tokenIds: z.array(z.number().int().min(0)).max(30).default([0]), chain, openseaKey: z.string().optional(), refresh: z.boolean().default(false), rpc },
}, wrap(marketplaceCheck));

await server.connect(new StdioServerTransport());
