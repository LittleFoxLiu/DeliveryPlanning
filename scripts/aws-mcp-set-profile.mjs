#!/usr/bin/env node
/**
 * Step 5 tail of the AWS Agent Toolkit setup.
 *
 * `aws configure agent-toolkit` writes an `aws-mcp` server entry into each
 * detected AI tool's MCP config, but that entry falls back to the `default`
 * AWS profile. This setup authenticates under a NAMED profile, so we must add
 *   env: { AWS_MCP_PROXY_PROFILES: "<profile>" }
 * to every generated `aws-mcp` entry — otherwise the MCP server can't find
 * credentials and fails with JSON-RPC -32602.
 *
 * Usage:  node scripts/aws-mcp-set-profile.mjs <profile-name> [extra config files...]
 *
 * Idempotent. Only touches the `aws-mcp` entry; leaves the generated
 * command/args/timeout/transport and every other server untouched. If an `env`
 * block already exists it merges (does not replace) AWS_MCP_PROXY_PROFILES.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const profile = process.argv[2];
if (!profile) {
  console.error('usage: node scripts/aws-mcp-set-profile.mjs <profile-name> [config files...]');
  process.exit(2);
}

// Common MCP config locations. Claude Code uses ~/.claude.json (+ a per-project
// key). Add more here if `aws configure agent-toolkit` reports other tools.
const candidates = [
  join(homedir(), '.claude.json'),
  join(homedir(), '.codex', 'config.toml'),          // reported, not edited by this script (TOML)
  join(process.cwd(), '.mcp.json'),
  ...process.argv.slice(3),
];

let touched = 0;

for (const file of candidates) {
  if (!existsSync(file) || !file.endsWith('.json')) continue;
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { continue; }
  let doc;
  try { doc = JSON.parse(raw); } catch {
    console.warn(`skip ${file}: not valid JSON`);
    continue;
  }

  // aws-mcp can live at the top level or under projects["<path>"].
  const scopes = [doc, ...Object.values(doc.projects ?? {})].filter((s) => s && typeof s === 'object');
  let changedThisFile = false;

  for (const scope of scopes) {
    const servers = scope.mcpServers;
    if (!servers || typeof servers !== 'object') continue;
    const entry = servers['aws-mcp'];
    if (!entry || typeof entry !== 'object') continue;

    entry.env = entry.env && typeof entry.env === 'object' ? entry.env : {};
    if (entry.env.AWS_MCP_PROXY_PROFILES === profile) {
      console.log(`ok   ${file}: aws-mcp already targets "${profile}"`);
      continue;
    }
    // preserve any other profiles the user added to the space-separated list
    const existing = String(entry.env.AWS_MCP_PROXY_PROFILES ?? '').split(/\s+/).filter(Boolean);
    entry.env.AWS_MCP_PROXY_PROFILES = [...new Set([profile, ...existing])].join(' ');
    changedThisFile = true;
    console.log(`set  ${file}: aws-mcp env AWS_MCP_PROXY_PROFILES="${entry.env.AWS_MCP_PROXY_PROFILES}"`);
  }

  if (changedThisFile) {
    writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    touched++;
  }
}

if (touched === 0) {
  console.log('\nNo `aws-mcp` entry found in any known JSON MCP config.');
  console.log('Run `aws configure agent-toolkit --yes --region us-east-1 --profile ' + profile + '` first,');
  console.log('then re-run this script. For non-JSON configs (Codex TOML, OpenCode) add the env block by hand:');
  console.log('  AWS_MCP_PROXY_PROFILES = "' + profile + '"');
} else {
  console.log(`\nUpdated ${touched} file(s). Restart your AI tool for the change to take effect.`);
  console.log(`To use another AWS account later: \`aws login --profile <name>\`, add that name to the`);
  console.log(`space-separated AWS_MCP_PROXY_PROFILES list in each config, and restart your AI tool.`);
}
