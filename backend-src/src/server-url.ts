import type { FastifyRequest } from 'fastify'

type RequestLike = Pick<FastifyRequest, 'protocol' | 'headers'>

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null
  if (typeof value === 'string') {
    const first = value.split(',')[0]?.trim()
    return first || null
  }
  return null
}

export function resolveServerUrl(req?: RequestLike | null) {
  const configured = process.env.SERVER_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')

  const host =
    firstHeaderValue(req?.headers['x-forwarded-host'] as string | string[] | undefined)
    ?? firstHeaderValue(req?.headers.host)
  const protocol =
    firstHeaderValue(req?.headers['x-forwarded-proto'] as string | string[] | undefined)
    ?? req?.protocol
    ?? 'http'

  if (host) return `${protocol}://${host}`

  const fallbackHost =
    process.env.HOST && process.env.HOST !== '0.0.0.0'
      ? process.env.HOST
      : '127.0.0.1'

  return `http://${fallbackHost}:${process.env.PORT ?? 3001}`
}
