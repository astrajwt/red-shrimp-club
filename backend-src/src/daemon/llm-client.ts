// Red Shrimp Lab — LLM Client
// Unified provider abstraction for Claude / Kimi / Codex (OpenAI-compatible)
//
// Key features:
//   - Provider routing by model name prefix
//   - 429 rate-limit: exponential backoff (3s → 6s → 12s → ... → max 60s)
//   - Timeout: 120s per request
//   - Per-run token usage reporting back to DB

import Anthropic from '@anthropic-ai/sdk'
import { query } from '../db/client.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CompletionRequest {
  prompt: string
  model?: string            // defaults to CLAUDE_DEFAULT_MODEL
  systemPrompt?: string
  agentId?: string
  runId?: string
  maxTokens?: number
  temperature?: number
}

export interface CompletionResponse {
  text: string
  tokensUsed: number
  model: string
  provider: Provider
}

type Provider = 'anthropic' | 'moonshot' | 'moonshot' | 'openai' | 'zhipu' | 'dashscope'

// ─── Provider config ──────────────────────────────────────────────────────────

const CLAUDE_DEFAULT_MODEL  = 'claude-sonnet-4-6'
const OPENAI_DEFAULT_MODEL  = 'gpt-4o'

// Backoff config
const BACKOFF_BASE_MS  = 3_000
const BACKOFF_MAX_MS   = 60_000
const BACKOFF_RETRIES  = 6

// ─── Resolve provider from model string ──────────────────────────────────────

function resolveProvider(model: string): Provider {
  if (model.startsWith('claude'))     return 'anthropic'
  if (model.startsWith('moonshot'))   return 'moonshot'
  if (model.startsWith('glm'))        return 'zhipu'
  if (model.startsWith('qwen') || model.startsWith('codeplan')) return 'dashscope'
  return 'openai'  // gpt-*, o1-*, codex-*
}

// ─── Provider-specific base URLs and API key env vars ──────────────────────

const PROVIDER_CONFIG: Record<string, { baseURL: string; envKey: string }> = {
  moonshot:   { baseURL: 'https://api.moonshot.cn/v1',                envKey: 'MOONSHOT_API_KEY' },
  openai:     { baseURL: 'https://api.openai.com/v1',                envKey: 'OPENAI_API_KEY' },
  zhipu:      { baseURL: 'https://open.bigmodel.cn/api/paas/v4',     envKey: 'ZHIPU_API_KEY' },
  dashscope:  { baseURL: 'https://coding.dashscope.aliyuncs.com/v1', envKey: 'DASHSCOPE_API_KEY' },
}

// ─── Exponential backoff retry ───────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0
  let delay = BACKOFF_BASE_MS

  while (true) {
    try {
      return await fn()
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status

      // Rate limited (429) or server overload (529) — retry with backoff
      if ((status === 429 || status === 529) && attempt < BACKOFF_RETRIES) {
        // Respect Retry-After header if present
        const retryAfter = err?.headers?.['retry-after']
        const waitMs = retryAfter
          ? Number(retryAfter) * 1000
          : Math.min(delay, BACKOFF_MAX_MS)

        console.warn(`[llm] ${status} rate limit — retrying in ${waitMs}ms (attempt ${attempt + 1}/${BACKOFF_RETRIES})`)
        await sleep(waitMs)

        delay = Math.min(delay * 2, BACKOFF_MAX_MS)
        attempt++
        continue
      }

      throw err
    }
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── LLM Client class ─────────────────────────────────────────────────────────

class LLMClient {
  private anthropic: Anthropic

  constructor() {
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 120_000,
    })
  }

  // ── Streaming entry point (yields text chunks) ─────────────────────────────

  async *streamComplete(req: CompletionRequest): AsyncGenerator<string> {
    const model = req.model ?? CLAUDE_DEFAULT_MODEL
    const provider = resolveProvider(model)

    switch (provider) {
      case 'anthropic':
        yield* this.streamClaude(model, req)
        break
      case 'moonshot':
      case 'openai':
      case 'zhipu':
      case 'dashscope':
        yield* this.streamOpenAICompat(model, req, provider)
        break
    }
  }

  // ── Main entry point ───────────────────────────────────────────────────────

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const model = req.model ?? CLAUDE_DEFAULT_MODEL
    const provider = resolveProvider(model)

    let result: CompletionResponse

    switch (provider) {
      case 'anthropic':
        result = await withRetry(() => this.callClaude(model, req))
        break
      case 'moonshot':
      case 'openai':
      case 'zhipu':
      case 'dashscope':
        result = await withRetry(() => this.callOpenAICompat(model, req, provider))
        break
    }

    // Persist token usage to the run record if runId provided
    if (req.runId) {
      await this.updateRunTokens(req.runId, result!.tokensUsed)
    }

    return result!
  }

  // ── Claude (Anthropic SDK) ─────────────────────────────────────────────────

  private async callClaude(
    model: string,
    req: CompletionRequest
  ): Promise<CompletionResponse> {
    const msg = await this.anthropic.messages.create({
      model,
      max_tokens: req.maxTokens ?? 8192,
      system:     req.systemPrompt,
      messages: [{ role: 'user', content: req.prompt }],
    })

    const text = msg.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('')

    return {
      text,
      tokensUsed: msg.usage.input_tokens + msg.usage.output_tokens,
      model,
      provider: 'anthropic',
    }
  }

  // ── OpenAI-compatible (Moonshot / OpenAI) ─────────────────────────────────
  // Both use the same chat completions interface; differentiated by base URL.

  private async callOpenAICompat(
    model: string,
    req: CompletionRequest,
    provider: 'moonshot' | 'openai' | 'zhipu' | 'dashscope'
  ): Promise<CompletionResponse> {
    const cfg = PROVIDER_CONFIG[provider]
    const baseURL = process.env[`${provider.toUpperCase()}_BASE_URL`] ?? cfg.baseURL
    const apiKey = process.env[cfg.envKey]!

    const messages: Array<{ role: string; content: string }> = []
    if (req.systemPrompt) {
      messages.push({ role: 'system', content: req.systemPrompt })
    }
    messages.push({ role: 'user', content: req.prompt })

    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens:  req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0.7,
      }),
      signal: AbortSignal.timeout(120_000),
    })

    if (!res.ok) {
      const err: any = new Error(`HTTP ${res.status}`)
      err.status = res.status
      err.headers = Object.fromEntries(res.headers.entries())
      throw err
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>
      usage: { prompt_tokens: number; completion_tokens: number }
    }

    return {
      text:       data.choices[0]?.message?.content ?? '',
      tokensUsed: data.usage.prompt_tokens + data.usage.completion_tokens,
      model,
      provider,
    }
  }

  // ── Claude streaming ──────────────────────────────────────────────────────

  private async *streamClaude(
    model: string,
    req: CompletionRequest
  ): AsyncGenerator<string> {
    const stream = this.anthropic.messages.stream({
      model,
      max_tokens: req.maxTokens ?? 8192,
      system:     req.systemPrompt,
      messages: [{ role: 'user', content: req.prompt }],
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text
      }
    }
  }

  // ── OpenAI-compatible streaming ──────────────────────────────────────────

  private async *streamOpenAICompat(
    model: string,
    req: CompletionRequest,
    provider: 'moonshot' | 'openai' | 'zhipu' | 'dashscope'
  ): AsyncGenerator<string> {
    const cfg = PROVIDER_CONFIG[provider]
    const baseURL = process.env[`${provider.toUpperCase()}_BASE_URL`] ?? cfg.baseURL
    const apiKey = process.env[cfg.envKey]!

    const messages: Array<{ role: string; content: string }> = []
    if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt })
    messages.push({ role: 'user', content: req.prompt })

    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0.7,
        stream: true,
      }),
      signal: AbortSignal.timeout(120_000),
    })

    if (!res.ok || !res.body) {
      const err: any = new Error(`HTTP ${res.status}`)
      err.status = res.status
      throw err
    }

    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') return
        try {
          const json = JSON.parse(data)
          const delta = json.choices?.[0]?.delta?.content
          if (delta) yield delta
        } catch { /* skip */ }
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async updateRunTokens(runId: string, tokensUsed: number) {
    await query(
      `UPDATE agent_runs
       SET tokens_used = tokens_used + $1
       WHERE id = $2`,
      [tokensUsed, runId]
    ).catch(err => console.error('[llm] Failed to update run tokens:', err.message))
  }

  // ── Model listing ──────────────────────────────────────────────────────────
  // Returns available models grouped by provider — used by SettingsPage

  availableModels() {
    return {
      anthropic: [
        { id: 'claude-opus-4-6',           label: 'Claude Opus 4.6',    tier: 'premium'  },
        { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6',  tier: 'standard' },
        { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5',   tier: 'fast'     },
      ],
      moonshot: [
        { id: 'kimi-code/kimi-for-coding', label: 'Kimi Code',  tier: 'standard' },
        { id: 'kimi-k2-5',                 label: 'Kimi K2.5',  tier: 'standard' },
      ],
      openai: [
        { id: 'gpt-5.4',            label: 'GPT-5.4',              tier: 'premium'  },
        { id: 'gpt-5.3-codex',      label: 'GPT-5.3 Codex',       tier: 'standard' },
        { id: 'gpt-5.2-codex',      label: 'GPT-5.2 Codex',       tier: 'standard' },
        { id: 'gpt-5.2',            label: 'GPT-5.2',              tier: 'standard' },
        { id: 'gpt-5.1-codex-max',  label: 'GPT-5.1 Codex Max',   tier: 'premium'  },
        { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini',  tier: 'fast'     },
      ],
      zhipu: [
        { id: 'glm-5',   label: 'GLM-5 (744B MoE)',  tier: 'premium'  },
        { id: 'glm-4.7', label: 'GLM-4.7',            tier: 'standard' },
      ],
      dashscope: [
        { id: 'qwen3.5',        label: 'Qwen 3.5',         tier: 'premium'  },
        { id: 'qwen-coder-plus', label: 'Qwen Coder Plus', tier: 'standard' },
      ],
    }
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const llmClient = new LLMClient()
