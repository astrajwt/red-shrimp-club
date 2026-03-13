/**
 * 红虾俱乐部 — LLM 统一客户端
 *
 * 文件位置: backend-src/src/daemon/llm-client.ts
 * 核心功能:
 *   1. 多 LLM 提供商统一抽象: Claude (Anthropic) / Kimi (Moonshot) / GPT (OpenAI)
 *   2. 根据模型名前缀自动路由到对应提供商
 *   3. 429/529 限流自动重试: 指数退避 (3s → 6s → 12s → ... → 60s 上限)
 *   4. 每次请求 120s 超时保护
 *   5. 按 run 记录累计 token 用量到数据库
 *
 * 设计说明:
 *   - Anthropic 使用官方 SDK（支持流式，但此处用同步 messages.create）
 *   - Moonshot / OpenAI 共用 OpenAI 兼容接口，仅 baseURL 和 apiKey 不同
 *   - 重试逻辑优先使用 Retry-After 响应头
 */

import Anthropic from '@anthropic-ai/sdk'
import { query } from '../db/client.js'

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** LLM 补全请求参数 */
export interface CompletionRequest {
  prompt: string              // 用户提示词
  model?: string              // 模型 ID，不指定则使用默认 Claude 模型
  systemPrompt?: string       // 系统提示词（设定角色/行为）
  agentId?: string            // 关联的 Agent UUID
  runId?: string              // 关联的 run UUID，用于 token 用量追踪
  maxTokens?: number          // 最大输出 token 数
  temperature?: number        // 温度参数（0~1，越高越随机）
}

/** LLM 补全响应 */
export interface CompletionResponse {
  text: string                // 生成的文本
  tokensUsed: number          // 消耗的总 token 数（输入+输出）
  model: string               // 实际使用的模型 ID
  provider: Provider          // 提供商标识
}

/** 支持的 LLM 提供商 */
type Provider = 'anthropic' | 'moonshot' | 'openai'

// ─── 提供商默认配置 ──────────────────────────────────────────────────────────

const CLAUDE_DEFAULT_MODEL  = 'claude-sonnet-4-6'
const KIMI_DEFAULT_MODEL    = 'moonshot-v1-8k'
const OPENAI_DEFAULT_MODEL  = 'gpt-4o'

/** 退避重试参数 */
const BACKOFF_BASE_MS  = 3_000    // 初始等待 3 秒
const BACKOFF_MAX_MS   = 60_000   // 最大等待 60 秒
const BACKOFF_RETRIES  = 6        // 最多重试 6 次

// ─── 根据模型名前缀识别提供商 ────────────────────────────────────────────────

/**
 * 通过模型 ID 前缀判断所属提供商
 * @param model 模型 ID，如 "claude-sonnet-4-6", "moonshot-v1-8k", "gpt-4o"
 * @returns 提供商标识
 */
function resolveProvider(model: string): Provider {
  if (model.startsWith('claude'))     return 'anthropic'
  if (model.startsWith('moonshot'))   return 'moonshot'
  return 'openai'  // gpt-*, o1-*, codex-* 等
}

// ─── 指数退避重试包装器 ────────────────────────────────────────────────────

/**
 * 带指数退避的重试包装器
 * 仅对 429 (限流) 和 529 (过载) 错误进行重试
 * 如果响应包含 Retry-After 头，优先使用该值作为等待时间
 *
 * @param fn 需要重试的异步函数
 * @returns fn 的返回值
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0
  let delay = BACKOFF_BASE_MS

  while (true) {
    try {
      return await fn()
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status

      // 仅对限流 (429) 和服务器过载 (529) 进行重试
      if ((status === 429 || status === 529) && attempt < BACKOFF_RETRIES) {
        // 优先使用 Retry-After 响应头
        const retryAfter = err?.headers?.['retry-after']
        const waitMs = retryAfter
          ? Number(retryAfter) * 1000
          : Math.min(delay, BACKOFF_MAX_MS)

        console.warn(`[llm] ${status} rate limit — retrying in ${waitMs}ms (attempt ${attempt + 1}/${BACKOFF_RETRIES})`)
        await sleep(waitMs)

        // 退避时间翻倍，但不超过上限
        delay = Math.min(delay * 2, BACKOFF_MAX_MS)
        attempt++
        continue
      }

      throw err
    }
  }
}

/** 延迟辅助函数 */
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── LLM 客户端类 ─────────────────────────────────────────────────────────────

/**
 * LLM 统一客户端
 * 职责: 封装多提供商的 LLM 调用差异，提供统一的 complete() 接口
 * 全局单例，由 llmClient 导出
 */
class LLMClient {
  /** Anthropic 官方 SDK 实例 */
  private anthropic: Anthropic

  constructor() {
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 120_000,  // 120 秒超时
    })
  }

  // ── 统一入口 ──────────────────────────────────────────────────

  /**
   * 发送 LLM 补全请求
   * @param req 请求参数
   * @returns 补全响应（含生成文本和 token 用量）
   *
   * 流程: 解析模型 → 路由到对应提供商 → 带重试调用 → 持久化 token 用量
   */
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const model = req.model ?? CLAUDE_DEFAULT_MODEL
    const provider = resolveProvider(model)

    let result: CompletionResponse

    switch (provider) {
      case 'anthropic':
        result = await withRetry(() => this.callClaude(model, req))
        break
      case 'moonshot':
        result = await withRetry(() => this.callOpenAICompat(model, req, 'moonshot'))
        break
      case 'openai':
        result = await withRetry(() => this.callOpenAICompat(model, req, 'openai'))
        break
    }

    // 如果关联了 run，将 token 用量累加到数据库
    if (req.runId) {
      await this.updateRunTokens(req.runId, result!.tokensUsed)
    }

    return result!
  }

  // ── Anthropic Claude 调用（使用官方 SDK） ──────────────────────

  /**
   * 调用 Anthropic Claude API
   * @param model 模型 ID (如 claude-sonnet-4-6)
   * @param req   请求参数
   * @returns 标准化的补全响应
   */
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

    // 从响应内容块中提取文本部分
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

  // ── OpenAI 兼容接口调用（Moonshot / OpenAI） ──────────────────

  /**
   * 调用 OpenAI 兼容的 chat completions 接口
   * Moonshot (Kimi) 和 OpenAI 共用同一接口格式，仅 baseURL 和 apiKey 不同
   *
   * @param model    模型 ID
   * @param req      请求参数
   * @param provider 提供商标识（决定 baseURL 和 apiKey）
   * @returns 标准化的补全响应
   */
  private async callOpenAICompat(
    model: string,
    req: CompletionRequest,
    provider: 'moonshot' | 'openai'
  ): Promise<CompletionResponse> {
    const baseURL =
      provider === 'moonshot'
        ? 'https://api.moonshot.cn/v1'
        : 'https://api.openai.com/v1'

    const apiKey =
      provider === 'moonshot'
        ? process.env.MOONSHOT_API_KEY!
        : process.env.OPENAI_API_KEY!

    // 构建消息数组（可选系统提示 + 用户提示）
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
      signal: AbortSignal.timeout(120_000),  // 120 秒超时
    })

    // 非 2xx 响应转换为 Error 对象（保留 status 和 headers 供重试逻辑使用）
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

  // ── 辅助方法 ──────────────────────────────────────────────────

  /**
   * 累加 token 用量到 agent_runs 记录
   * 使用 += 而非 = ，因为一个 run 可能包含多次 LLM 调用
   */
  private async updateRunTokens(runId: string, tokensUsed: number) {
    await query(
      `UPDATE agent_runs
       SET tokens_used = tokens_used + $1
       WHERE id = $2`,
      [tokensUsed, runId]
    ).catch(err => console.error('[llm] Failed to update run tokens:', err.message))
  }

  // ── 模型列表 ──────────────────────────────────────────────────

  /**
   * 返回按提供商分组的可用模型列表
   * 前端设置页面用于展示模型选择下拉框
   * tier 字段用于 UI 中的标签显示（premium/standard/fast）
   */
  availableModels() {
    return {
      anthropic: [
        { id: 'claude-opus-4-6',           label: 'Claude Opus 4.6',    tier: 'premium'  },
        { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6',  tier: 'standard' },
        { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5',   tier: 'fast'     },
      ],
      moonshot: [
        { id: 'moonshot-v1-8k',   label: 'Kimi (8K)',   tier: 'fast'     },
        { id: 'moonshot-v1-32k',  label: 'Kimi (32K)',  tier: 'standard' },
        { id: 'moonshot-v1-128k', label: 'Kimi (128K)', tier: 'premium'  },
      ],
      openai: [
        { id: 'gpt-4o',      label: 'GPT-4o',      tier: 'premium'  },
        { id: 'gpt-4o-mini', label: 'GPT-4o Mini', tier: 'fast'     },
        { id: 'o1-mini',     label: 'o1 Mini',     tier: 'standard' },
      ],
    }
  }
}

// ─── 全局单例导出 ─────────────────────────────────────────────────────────────

export const llmClient = new LLMClient()
