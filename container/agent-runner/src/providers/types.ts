import type { MemorySessionHookRegistration } from '../memory/session-hook.js';

export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /** Register shared memory through the provider's native session-start mechanism. */
  registerMemorySessionHook(hook: MemorySessionHookRegistration): void;

  /**
   * Optional. Called by the poll-loop after each completed exchange (a
   * result, a wrapping retry, or an error). Providers whose harness keeps no
   * on-disk transcript implement this to persist exchanges themselves (e.g.
   * markdown into the agent's `conversations/` dir); providers that persist
   * and archive their own transcript (e.g. the Claude Agent SDK's `.jsonl`)
   * omit it. Best-effort: the loop catches and logs anything it throws. The
   * implementation lives with the provider, never in the runner.
   */
  onExchangeComplete?(exchange: ProviderExchange): void;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;

  /**
   * Optional pre-resume maintenance. Given the stored continuation token,
   * decide whether its backing transcript has grown too large or too old to
   * resume cheaply. Return a non-null reason string to tell the caller to drop
   * the continuation and start a fresh session (the provider archives any
   * recoverable summary first); return null to keep resuming.
   *
   * Guards the cold-resume failure mode: a long-lived hub session accumulates
   * days of history — including base64 image blocks the agent Read — and the
   * SDK reloads the whole .jsonl on every resume. Past a threshold the first
   * turn alone can exceed the host's idle ceiling, so the container is killed
   * before it ever replies. Providers without an on-disk transcript omit this.
   */
  maybeRotateContinuation?(continuation: string, cwd: string): string | null;
}

/** One prompt/result round-trip, as reported to `onExchangeComplete`. */
export interface ProviderExchange {
  /** The user prompt this exchange answers (never an internal retry nudge). */
  prompt: string;
  result: string | null;
  /** Continuation/thread id in effect for the exchange, if any. */
  continuation?: string;
  status: 'completed' | 'undelivered' | 'error';
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  /**
   * Model alias (`sonnet`, `opus`, `haiku`) or full model ID. Passed through
   * to the underlying SDK. If omitted, the SDK default is used.
   */
  model?: string;
  /**
   * Reasoning effort (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`). Passed
   * through to the underlying SDK. If omitted, the SDK default is used.
   */
  effort?: string;
  /**
   * Days before a chat transcript is rotated out of the resume path. A
   * transcript is re-sent on every turn, so its age is a direct cost lever:
   * the same trivial reply measured ~26.5k prompt tokens in a fresh session
   * and ~72k in a warm one. Undefined keeps the provider's own default.
   */
  transcriptRotateDays?: number;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * Withhold this server from the main thread. Its tool schemas then cost
   * nothing on ordinary turns, and it is reachable only through a subagent
   * that claims it by name in its `.claude/agents/*.md` frontmatter.
   */
  subagentOnly?: boolean;
}

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  /**
   * A completed turn. `isError` is set when the underlying SDK flagged the
   * turn as an error (e.g. a non-retryable Anthropic 403 billing_error). The
   * poll-loop uses it to surface the result text to the user instead of
   * dropping it as un-wrapped scratchpad, and to skip the re-wrap nudge.
   *
   * `modelUsage` is the SDK's per-model token/cost breakdown for this turn,
   * aggregated across the main model and any subagents invoked during it.
   * Optional — only providers backed by an SDK that reports it populate this.
   */
  | {
      type: 'result';
      text: string | null;
      isError?: boolean;
      modelUsage?: Record<
        string,
        {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens: number;
          cacheCreationInputTokens: number;
          costUSD: number;
        }
      >;
    }
  | { type: 'error'; message: string; retryable: boolean; classification?: string; resetsAt?: number }
  | { type: 'progress'; message: string }
  /**
   * A subagent (SDK `Task` tool) was invoked. `model` is the resolved model
   * alias/id the subagent runs on ('inherit' if the provider couldn't
   * resolve one). Optional — only providers backed by an SDK with native
   * subagent support emit this; others simply never yield it.
   */
  | { type: 'subagent'; subagentType: string; model: string; description?: string }
  /**
   * A tool the agent invoked, and what it got back. These exist so the
   * container log records what the agent actually *did*, independently of
   * what it later says it did.
   *
   * The motivating incident: an agent reported shell output that did not
   * match what the command produced -- a file's contents reconstructed from
   * context, and an EXIT=1 for a command that exited 0. With only the
   * agent's own account in the log, "ran it and misreported" was
   * indistinguishable from "never ran it".
   *
   * `summary` is the command itself for Bash, and a compact rendering of the
   * input for anything else. `preview` is bounded -- these go to a log, not
   * to the agent.
   */
  | { type: 'tool'; name: string; summary: string }
  | { type: 'tool_result'; isError: boolean; preview: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' };
