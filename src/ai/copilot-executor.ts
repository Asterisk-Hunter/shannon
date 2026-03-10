// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

// Copilot SDK executor — alternative to claude-executor.ts using @github/copilot-sdk.
// Allows Shannon to run via GitHub Copilot (free for students / Copilot Free tier)
// instead of requiring a paid Anthropic API key.

import { fs, path } from 'zx';
import { CopilotClient, approveAll } from '@github/copilot-sdk';
import type {
  SessionConfig,
  MCPLocalServerConfig,
  SessionEvent,
} from '@github/copilot-sdk';

import { isRetryableError, PentestError } from '../services/error-handling.js';
import { isSpendingCapBehavior } from '../utils/billing-detection.js';
import { Timer } from '../utils/metrics.js';
import { formatTimestamp } from '../utils/formatting.js';
import { MCP_AGENT_MAPPING } from '../session-manager.js';
import { AuditSession } from '../audit/index.js';
import { AGENTS } from '../session-manager.js';
import type { AgentName } from '../types/index.js';

import { detectExecutionContext, formatErrorOutput, formatCompletionMessage } from './output-formatters.js';
import { createProgressManager } from './progress-manager.js';
import { createAuditLogger } from './audit-logger.js';
import type { ClaudePromptResult } from './claude-executor.js';
import type { ActivityLogger } from '../types/activity-logger.js';

// Copilot SDK model mapping for Shannon's model tiers.
// These are models available through GitHub Copilot.
const COPILOT_MODELS: Record<string, string> = {
  small: 'claude-haiku',
  medium: 'claude-sonnet',
  large: 'claude-opus',
};

function resolveCopilotModel(tier: string = 'medium'): string {
  // Allow explicit override via env var
  if (process.env.COPILOT_MODEL) {
    return process.env.COPILOT_MODEL;
  }
  return COPILOT_MODELS[tier] || COPILOT_MODELS.medium!;
}

// Build MCP server configs in the Copilot SDK format
function buildCopilotMcpServers(
  sourceDir: string,
  agentName: string | null,
  logger: ActivityLogger
): Record<string, MCPLocalServerConfig> {
  const mcpServers: Record<string, MCPLocalServerConfig> = {};

  // Shannon helper MCP server — run it as a local stdio server
  mcpServers['shannon-helper'] = {
    type: 'local',
    command: 'node',
    args: [path.resolve('mcp-server/dist/index.js'), sourceDir],
    tools: ['*'],
  };

  // Playwright MCP servers for browser-based agents
  if (agentName) {
    const promptTemplate = AGENTS[agentName as AgentName].promptTemplate;
    const playwrightMcpName = MCP_AGENT_MAPPING[promptTemplate as keyof typeof MCP_AGENT_MAPPING] || null;

    if (playwrightMcpName) {
      logger.info(`Assigned ${agentName} -> ${playwrightMcpName}`);

      const userDataDir = `/tmp/${playwrightMcpName}`;
      const isDocker = process.env.SHANNON_DOCKER === 'true';

      const mcpArgs: string[] = [
        '@playwright/mcp@latest',
        '--isolated',
        '--user-data-dir', userDataDir,
      ];

      if (isDocker) {
        mcpArgs.push('--executable-path', '/usr/bin/chromium-browser');
        mcpArgs.push('--browser', 'chromium');
      }

      const envVars: Record<string, string> = Object.fromEntries(
        Object.entries({
          ...process.env,
          PLAYWRIGHT_HEADLESS: 'true',
          ...(isDocker && { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }),
        }).filter((entry): entry is [string, string] => entry[1] !== undefined)
      );

      mcpServers[playwrightMcpName] = {
        type: 'local',
        command: 'npx',
        args: mcpArgs,
        env: envVars,
        tools: ['*'],
      };
    }
  }

  return mcpServers;
}

function outputLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

async function writeErrorLog(
  err: Error & { code?: string; status?: number },
  sourceDir: string,
  fullPrompt: string,
  duration: number
): Promise<void> {
  try {
    const errorLog = {
      timestamp: formatTimestamp(),
      agent: 'copilot-executor',
      error: {
        name: err.constructor.name,
        message: err.message,
        code: err.code,
        status: err.status,
        stack: err.stack
      },
      context: {
        sourceDir,
        prompt: fullPrompt.slice(0, 200) + '...',
        retryable: isRetryableError(err)
      },
      duration
    };
    const logPath = path.join(sourceDir, 'error.log');
    await fs.appendFile(logPath, JSON.stringify(errorLog) + '\n');
  } catch {
    // Best-effort error log writing
  }
}

// Singleton client — reused across invocations within the same worker process
let copilotClient: CopilotClient | null = null;

function getCopilotClient(): CopilotClient {
  if (!copilotClient) {
    const githubToken = process.env.COPILOT_GITHUB_TOKEN
      || process.env.GH_TOKEN
      || process.env.GITHUB_TOKEN;

    copilotClient = new CopilotClient({
      ...(githubToken && { githubToken, useLoggedInUser: false }),
    });
  }
  return copilotClient;
}

/**
 * Execute a prompt using the GitHub Copilot SDK.
 * Drop-in replacement for runClaudePrompt with the same return type.
 */
export async function runCopilotPrompt(
  prompt: string,
  sourceDir: string,
  context: string = '',
  description: string = 'Copilot analysis',
  agentName: string | null = null,
  auditSession: AuditSession | null = null,
  logger: ActivityLogger,
  modelTier: string = 'medium'
): Promise<ClaudePromptResult> {
  const timer = new Timer(`agent-${description.toLowerCase().replace(/\s+/g, '-')}`);
  const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;

  const execContext = detectExecutionContext(description);
  const progress = createProgressManager(
    { description, useCleanOutput: execContext.useCleanOutput },
    global.SHANNON_DISABLE_LOADER ?? false
  );
  const auditLogger = createAuditLogger(auditSession);

  logger.info(`Running Copilot SDK: ${description}...`);

  const mcpServers = buildCopilotMcpServers(sourceDir, agentName, logger);
  const model = resolveCopilotModel(modelTier);

  if (!execContext.useCleanOutput) {
    logger.info(`Copilot SDK Options: model=${model}, cwd=${sourceDir}, permissions=approveAll`);
  }

  let turnCount = 0;
  let result: string | null = null;
  let totalCost = 0;
  let reportedModel: string | undefined = model;

  progress.start();

  const client = getCopilotClient();

  try {
    // Build session config
    const sessionConfig: SessionConfig = {
      model,
      workingDirectory: sourceDir,
      onPermissionRequest: approveAll,
      mcpServers,
      streaming: true,
    };

    const session = await client.createSession(sessionConfig);

    // Subscribe to events for audit logging, progress, and metrics
    session.on((event: SessionEvent) => {
      switch (event.type) {
        case 'assistant.turn_start':
          turnCount++;
          break;

        case 'assistant.message': {
          const content = event.data.content;
          void auditLogger.logLlmResponse(turnCount, content);
          if (!execContext.useCleanOutput) {
            const preview = content.slice(0, 150).replace(/\n/g, ' ');
            logger.info(`[Turn ${turnCount}] ${preview}...`);
          }
          break;
        }

        case 'tool.execution_start': {
          const toolName = event.data.toolName;
          void auditLogger.logToolStart(toolName, event.data.arguments);
          if (!execContext.useCleanOutput) {
            logger.info(`[Tool] ${toolName}`);
          }
          break;
        }

        case 'tool.execution_complete': {
          void auditLogger.logToolEnd(event.data.result);
          break;
        }

        case 'assistant.usage': {
          if (event.data.cost) {
            totalCost += event.data.cost;
          }
          if (event.data.model) {
            reportedModel = event.data.model;
          }
          break;
        }

        case 'session.error': {
          logger.error(`Copilot session error: ${event.data.message}`);
          break;
        }
      }
    });

    // Send prompt and wait — generous timeout for long pentest agent runs (30 min)
    const response = await session.sendAndWait(
      { prompt: fullPrompt },
      30 * 60 * 1000
    );

    result = response?.data.content ?? null;

    // Clean up session
    await session.destroy();

    // Spending cap safeguard
    if (isSpendingCapBehavior(turnCount, totalCost, result || '')) {
      throw new PentestError(
        `Spending cap likely reached (turns=${turnCount}, cost=$0): ${result?.slice(0, 100)}`,
        'billing',
        true
      );
    }

    const duration = timer.stop();

    progress.finish(formatCompletionMessage(execContext, description, turnCount, duration));

    return {
      result,
      success: true,
      duration,
      turns: turnCount,
      cost: totalCost,
      model: reportedModel,
      partialCost: totalCost,
      apiErrorDetected: false
    };

  } catch (error) {
    const duration = timer.stop();
    const err = error as Error & { code?: string; status?: number };

    await auditLogger.logError(err, duration, turnCount);
    progress.stop();
    outputLines(formatErrorOutput(err, execContext, description, duration, sourceDir, isRetryableError(err)));
    await writeErrorLog(err, sourceDir, fullPrompt, duration);

    return {
      error: err.message,
      errorType: err.constructor.name,
      prompt: fullPrompt.slice(0, 100) + '...',
      success: false,
      duration,
      cost: totalCost,
      retryable: isRetryableError(err)
    };
  }
}
