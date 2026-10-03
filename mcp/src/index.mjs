#!/usr/bin/env node
// abx-artist-kit MCP .. unofficial helper for artists launching on ABX (Art Blocks' open protocol).
// read-only: it never signs, never holds keys, never sends transactions.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { rebuildToken, inspectContract, lintScript, renderCheck, preflight, lessons } from './tools.mjs';
import { listLibraries } from './deps.mjs';

const server = new McpServer({ name: 'abx-artist-kit', version: '0.2.0' });

const chain = z.enum(['base', 'base-sepolia']).default('base').describe('base (mainnet, 8453) or base-sepolia (84532)');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe('ABX contract address');
const rpc = z.string().url().optional().describe('optional RPC URL; defaults to public Base RPCs');

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
    chain: z.enum(['base', 'base-sepolia']).default('base').describe('chain for 0x data-contract dependencies'),
  },
}, wrap(renderCheck));

server.registerTool('preflight', {
  title: 'Preflight a deploy plan',
  description: 'Checks planned abx CLI commands (deploy, attach, set-admin, lock-script, ...) against known launch pitfalls before anything is signed: 721C on Base mainnet, collection image override, on-chain URI without traits, sponsor without handover, missing payee/max/minter, royalty, script lock.',
  inputSchema: {
    commands: z.string().describe('the commands you plan to run, one per line'),
    chain: z.enum(['base', 'base-sepolia']).optional(),
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

await server.connect(new StdioServerTransport());
