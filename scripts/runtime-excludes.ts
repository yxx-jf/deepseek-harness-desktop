/** Workspace packages never needed in the packaged desktop Host runtime. */

/** Product packages excluded from the desktop runtime manifest and staging fingerprint. */
export const RUNTIME_EXCLUDED_PACKAGES = new Set([
  // The desktop shell itself and its deploy root.
  '@deepseek-ai/dsh-desktop',
  // Examples, demos and test infrastructure.
  '@deepseek-ai/dsh-acp-demo',
  '@deepseek-ai/dsh-acp-snapshot',
  '@deepseek-ai/dsh-agent-loop-testkit',
  '@deepseek-ai/dsh-agent-spine-demo',
  '@deepseek-ai/dsh-client-test-runtime',
  '@deepseek-ai/dsh-llm-mock-server',
  '@deepseek-ai/dsh-llm-replay',
  '@deepseek-ai/dsh-loader-smoke',
  // Python SDK and its JSON-RPC runtime.
  '@deepseek-ai/dsh-sdk-client',
  '@deepseek-ai/dsh-sdk-jsonrpc-demo',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-sdk-protocol',
  // E2B POC sandbox.
  '@deepseek-ai/dsh-e2b',
  '@deepseek-ai/dsh-fs-e2b',
  '@deepseek-ai/dsh-subprocess-e2b',
  // Optional external subagent backends that ship large SDKs.
  '@deepseek-ai/dsh-subagent-acp',
  '@deepseek-ai/dsh-subagent-claude-code',
  '@deepseek-ai/dsh-subagent-codex',
  '@deepseek-ai/dsh-subagent-dsh-sdk',
  // Claude Code / Codex hook bridges.
  '@deepseek-ai/dsh-hook-protocol',
  '@deepseek-ai/dsh-hooks-claude-code',
  '@deepseek-ai/dsh-hooks-codex',
  // ACP automation server.
  '@deepseek-ai/dsh-acp',
  // LSP capability.
  '@deepseek-ai/dsh-lsp',
  '@deepseek-ai/dsh-lsp-stdio',
  '@deepseek-ai/dsh-tool-lsp',
  // Optional web search providers beyond the default DeepSeek provider.
  '@deepseek-ai/dsh-web-fetch-http',
  '@deepseek-ai/dsh-web-search-exa',
  '@deepseek-ai/dsh-web-search-perplexity',
  // Build-time type graph generator.
  '@deepseek-ai/dsh-typert-generator',
  // Test fixtures.
  '@fixture/client',
  '@fixture/domain',
  '@fixture/host',
  '@fixture/remote',
  '@fixture/remote-workspace',
  '@fixture/workspace',
  '@fixture/write',
])
