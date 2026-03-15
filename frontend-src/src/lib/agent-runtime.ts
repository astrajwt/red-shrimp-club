import type { ModelInfo, ModelRegistry } from './api'

export type AgentRuntime = 'claude' | 'codex' | 'kimi'
type AgentProvider = keyof ModelRegistry

const PROVIDER_BY_RUNTIME: Record<AgentRuntime, AgentProvider> = {
  claude: 'anthropic',
  codex: 'openai',
  kimi: 'moonshot',
}

const DEFAULT_MODELS: Record<AgentRuntime, ModelInfo> = {
  claude: { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', tier: 'standard' },
  codex:  { id: 'gpt-5.4',           label: 'GPT-5.4',           tier: 'premium' },
  kimi:   { id: 'kimi-code/kimi-for-coding', label: 'Kimi Code', tier: 'standard' },
}

export function defaultAgentModelForRuntime(runtime: AgentRuntime): string {
  return DEFAULT_MODELS[runtime].id
}

export function runtimeForAgentModel(modelId: string): AgentRuntime {
  if (modelId.startsWith('claude')) return 'claude'
  if (modelId.startsWith('moonshot') || modelId.startsWith('kimi')) return 'kimi'
  return 'codex'
}

export function agentModelsForRuntime(
  registry: ModelRegistry | null,
  runtime: AgentRuntime
): ModelInfo[] {
  const defaults = [DEFAULT_MODELS[runtime]]
  const providerModels = registry?.[PROVIDER_BY_RUNTIME[runtime]] ?? []
  const merged = [...defaults, ...providerModels]

  return merged.filter((model, index) =>
    merged.findIndex(candidate => candidate.id === model.id) === index
  )
}

export function syncAgentModelForRuntime(
  registry: ModelRegistry | null,
  runtime: AgentRuntime,
  currentModelId: string
): string {
  const models = agentModelsForRuntime(registry, runtime)
  if (runtimeForAgentModel(currentModelId) === runtime && models.some(model => model.id === currentModelId)) {
    return currentModelId
  }
  return models[0]?.id ?? defaultAgentModelForRuntime(runtime)
}
