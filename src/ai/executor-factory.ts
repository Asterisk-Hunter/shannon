// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

// Executor dispatcher — selects between Claude SDK and Copilot SDK at runtime
// based on environment configuration.

import type { AuditSession } from '../audit/index.js';
import type { ActivityLogger } from '../types/activity-logger.js';
import type { ModelTier } from './models.js';
import type { ClaudePromptResult } from './claude-executor.js';

export type ProviderType = 'claude' | 'copilot';

/**
 * Detect which provider to use based on environment variables.
 *
 * Priority:
 * 1. Explicit SHANNON_PROVIDER=copilot|claude
 * 2. If COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN is set and no Anthropic key → copilot
 * 3. Default → claude
 */
export function detectProvider(): ProviderType {
  const explicit = process.env.SHANNON_PROVIDER?.toLowerCase();
  if (explicit === 'copilot') return 'copilot';
  if (explicit === 'claude') return 'claude';

  // Auto-detect: if a GitHub token is present and no Anthropic credentials, use Copilot
  const hasGithubToken = !!(
    process.env.COPILOT_GITHUB_TOKEN
    || process.env.GH_TOKEN
    || process.env.GITHUB_TOKEN
  );
  // Treat placeholder keys (set by CLI for non-Anthropic modes) as non-Anthropic
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const isPlaceholder = anthropicKey === 'copilot-mode' || anthropicKey === 'router-mode';
  const hasAnthropicCreds = !!(
    (anthropicKey && !isPlaceholder)
    || process.env.CLAUDE_CODE_OAUTH_TOKEN
  );

  if (hasGithubToken && !hasAnthropicCreds) {
    return 'copilot';
  }

  return 'claude';
}

/**
 * Run a prompt using the active provider. Same interface as runClaudePrompt.
 */
export async function runAgentPrompt(
  prompt: string,
  sourceDir: string,
  context: string,
  description: string,
  agentName: string | null,
  auditSession: AuditSession | null,
  logger: ActivityLogger,
  modelTier: ModelTier = 'medium'
): Promise<ClaudePromptResult> {
  const provider = detectProvider();

  if (provider === 'copilot') {
    // Dynamic import so the Copilot SDK is only loaded when needed
    const { runCopilotPrompt } = await import('./copilot-executor.js');
    return runCopilotPrompt(
      prompt, sourceDir, context, description,
      agentName, auditSession, logger, modelTier
    );
  }

  // Default: Claude SDK
  const { runClaudePrompt } = await import('./claude-executor.js');
  return runClaudePrompt(
    prompt, sourceDir, context, description,
    agentName, auditSession, logger, modelTier
  );
}
