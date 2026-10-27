#!/usr/bin/env node
import { runHook, HookAgent } from './runner.js';
import { install, uninstall } from './setup.js';

const args = process.argv.slice(2);
const [command, ...rest] = args;

const VALID_INSTALL_AGENTS = ['claude', 'codex', 'copilot', 'all'];

function parseAgent(tokens: string[]): string {
  const idx = tokens.indexOf('--agent');
  if (idx !== -1) return tokens[idx + 1] ?? 'all';
  return tokens[0] && !tokens[0].startsWith('--') ? tokens[0] : 'all';
}

function validateInstallAgent(agent: string): void {
  if (!VALID_INSTALL_AGENTS.includes(agent)) {
    console.error(`Unknown agent "${agent}". Use: claude, codex, copilot, or all.`);
    process.exit(1);
  }
}

function parseUninstallFlag(tokens: string[]): boolean {
  return tokens.includes('--uninstall');
}

async function main(): Promise<void> {
  switch (command) {
    case 'run': {
      const agentIdx = args.indexOf('--agent');
      const agent = agentIdx !== -1 ? args[agentIdx + 1] : rest[0];
      if (agent !== 'claude' && agent !== 'codex') {
        console.error('Usage: kumiq run --agent <claude|codex>');
        process.exit(1);
      }
      await runHook(agent as HookAgent);
      break;
    }
    case 'uninstall': {
      const agent = parseAgent(rest);
      validateInstallAgent(agent);
      await uninstall(agent, console.log);
      break;
    }
    case 'install': {
      const agent = parseAgent(rest);
      validateInstallAgent(agent);
      await install(agent, console.log, process.argv[1]!);
      break;
    }
    case undefined: {
      // bare invocation: install all (legacy: support --uninstall flag for back-compat)
      if (parseUninstallFlag(rest)) {
        const agent = parseAgent(rest.filter(a => a !== '--uninstall'));
        validateInstallAgent(agent);
        await uninstall(agent, console.log);
      } else {
        const agent = parseAgent(rest);
        validateInstallAgent(agent);
        await install(agent, console.log, process.argv[1]!);
      }
      break;
    }
    default:
      console.error(`Unknown command "${command}". Commands: install, uninstall, run`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
