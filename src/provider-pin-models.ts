/**
 * Which models a group runs, for building its provider pin.
 *
 * The group's own model lives in `container_configs`; its subagents declare
 * their own in `groups/<folder>/.claude/agents/*.md` frontmatter. Both belong
 * in the union — a model missing from `provider.only` is a 404 for whichever
 * subagent uses it.
 */
import fs from 'fs';
import path from 'path';

import { getAllContainerConfigs } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { log } from './log.js';

/** Only `vendor/model` ids reach the gateway; harness aliases (`sonnet`) do not. */
function isGatewayModel(value: string): boolean {
  return value.includes('/');
}

/** Models declared by a group's subagent files. `groupDir` is the group folder. */
export function subagentModels(groupDir: string): string[] {
  const agentsDir = path.join(groupDir, '.claude', 'agents');
  let entries: string[];
  try {
    entries = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const models = new Set<string>();
  for (const file of entries) {
    try {
      const text = fs.readFileSync(path.join(agentsDir, file), 'utf-8');
      // Frontmatter only: a `model:` line in the prose below is documentation,
      // not configuration.
      const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      if (!match) continue;
      const model = /^model:\s*(\S+)\s*$/m.exec(match[1])?.[1];
      if (model && isGatewayModel(model)) models.add(model);
    } catch (err) {
      log.debug('Skipping unreadable subagent file', { file, err });
    }
  }
  return [...models].sort();
}

/** Every model this group runs: its own plus its subagents'. */
export function modelsForGroup(agentGroupId: string): string[] {
  const models = new Set<string>();
  const config = getAllContainerConfigs().find((c) => c.agent_group_id === agentGroupId);
  if (config?.model && isGatewayModel(config.model)) models.add(config.model);
  const group = getAgentGroup(agentGroupId);
  if (group) {
    try {
      for (const model of subagentModels(resolveGroupFolderPath(group.folder))) models.add(model);
    } catch (err) {
      log.debug('Skipping subagent scan for group', { agentGroupId, err });
    }
  }
  return [...models].sort();
}

/** Every model any group runs — what the daily refresh needs to cover. */
export function allModelsInUse(): string[] {
  const models = new Set<string>();
  for (const config of getAllContainerConfigs()) {
    for (const model of modelsForGroup(config.agent_group_id)) models.add(model);
  }
  return [...models].sort();
}
