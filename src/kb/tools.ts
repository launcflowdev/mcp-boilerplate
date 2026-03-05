// B1 KB Access Layer — MCP Tool Registration
// Registers kb_fetch and kb_list on the existing MCP agent.
// Health check runs on first tool registration.

import { z } from 'zod';
import { kbFetch, kbList } from './access';
import { healthCheck } from './provider';
import { VALID_TAXONOMY } from './types';
import type { BoilerplateMCP } from '../index';

// Register both KB tools on the MCP agent
export function registerKbTools(agent: BoilerplateMCP) {
  const env = agent.env;

  // Validate required env vars exist
  if (!env.GITHUB_PAT) {
    console.error('[B1] GITHUB_PAT not configured — KB tools will not register');
    return;
  }

  const config = {
    pat: env.GITHUB_PAT,
    owner: env.KB_REPO_OWNER || 'launcflowdev',
    repo: env.KB_REPO_NAME || 'fleet-knowledge',
  };

  // §3.3 — Health check on startup
  // Run async health check — log result but don't block registration
  healthCheck(config).then(result => {
    if (result.healthy) {
      console.log(`[B1] ${result.message}`);
    } else {
      console.error(`[B1] HEALTH CHECK FAILED: ${result.message}`);
    }
  });

  // Tool 1: kb_fetch — §2.3
  agent.server.tool(
    'kb_fetch',
    'Fetch a document from the Fleet Knowledge Base. Returns full content with authority record and provenance. Path must start with a valid taxonomy directory: ' + VALID_TAXONOMY.join(', '),
    {
      path: z.string().describe(
        'Path to the document within the knowledge base. Must start with a valid taxonomy root: ' +
        VALID_TAXONOMY.join(', ') +
        '. Example: "doctrine/fleet-behavioral-standards.md"'
      ),
    },
    async ({ path }) => {
      const result = await kbFetch(config, path);

      if (!result.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: true,
                errorType: result.error.errorType,
                message: result.error.message,
                path: result.error.path,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: result.data.content,
          },
          {
            type: 'text' as const,
            text: '\n\n---\n' + JSON.stringify({
              authorityRecord: result.data.authorityRecord,
              provenance: result.data.provenance,
            }, null, 2),
          },
        ],
      };
    }
  );

  // Tool 2: kb_list — §2.3
  agent.server.tool(
    'kb_list',
    'List documents in a Fleet Knowledge Base directory. Returns file paths with provenance. Directory must be a valid taxonomy root: ' + VALID_TAXONOMY.join(', '),
    {
      directory: z.string().describe(
        'Directory path to list. Must start with a valid taxonomy root: ' +
        VALID_TAXONOMY.join(', ') +
        '. Example: "doctrine" or "officers"'
      ),
    },
    async ({ directory }) => {
      const result = await kbList(config, directory);

      if (!result.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: true,
                errorType: result.error.errorType,
                message: result.error.message,
                path: result.error.path,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              directory: result.data.directory,
              paths: result.data.paths,
              provenance: result.data.provenance,
            }, null, 2),
          },
        ],
      };
    }
  );

  console.log('[B1] KB tools registered: kb_fetch, kb_list');
}
