/**
 * Optional stable OpenAI-compatible entry in front of the per-region loopback
 * shims. The shims themselves stay ephemeral (127.0.0.1 + random port +
 * in-memory secret). This listener uses a fixed port and its own Bearer key so
 * a Docker LiteLLM container can reach WorkBuddy without discovering the shim
 * secret.
 *
 * Local trial only: not an upstream feature, off unless a config or key file
 * is present under $DSH_HOME.
 *
 * @module dsh-connect-workbuddy/stable-gateway
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostnameOfHost, hostIsLoopback } from './loopback.ts'
import { resolveDshHome } from './host-peers.ts'
import type { ShimLogger } from './shim.ts'
import type { WorkBuddyRegion } from './upstream.ts'

export const STABLE_GATEWAY_KEY_FILENAME = '.workbuddy-stable-gateway.key'
export const STABLE_GATEWAY_CONFIG_FILENAME = '.workbuddy-stable-gateway.json'
export const DEFAULT_STABLE_GATEWAY_PORT = 4010
export const DEFAULT_STABLE_GATEWAY_BIND = '0.0.0.0'

export interface StableGatewayConfig {
  enabled: boolean
  port: number
  host: string
}

export interface StableGatewayShim {
  baseUrl(): string
  token(): string
}

export interface StableGatewayOptions {
  shims: Record<WorkBuddyRegion, StableGatewayShim>
  logger?: ShimLogger
  /** Override $DSH_HOME (tests). */
  home?: string
  /** Override listen port (tests). */
  port?: number
  /** Override bind address (tests). */
  host?: string
}

export interface StableGateway {
  ready: Promise<void>
  close(): Promise<void>
  port(): number
  address(): string
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const DOCKER_HOSTNAMES = new Set(['host.docker.internal', 'gateway.docker.internal'])

export function stableGatewayConfigPath(home: string): string {
  return join(home, STABLE_GATEWAY_CONFIG_FILENAME)
}

export function stableGatewayKeyPath(home: string): string {
  return join(home, STABLE_GATEWAY_KEY_FILENAME)
}

export function readStableGatewayConfig(home: string): StableGatewayConfig {
  const defaults: StableGatewayConfig = {
    enabled: existsSync(stableGatewayKeyPath(home)),
    port: DEFAULT_STABLE_GATEWAY_PORT,
    host: DEFAULT_STABLE_GATEWAY_BIND,
  }
  const path = stableGatewayConfigPath(home)
  if (!existsSync(path)) return defaults
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const enabled = raw.enabled === undefined ? true : raw.enabled === true
    const port = typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 && raw.port <= 65535
      ? raw.port
      : DEFAULT_STABLE_GATEWAY_PORT
    const host = typeof raw.host === 'string' && raw.host.trim() !== ''
      ? raw.host.trim()
      : DEFAULT_STABLE_GATEWAY_BIND
    return { enabled, port, host }
  } catch {
    return { ...defaults, enabled: false }
  }
}

/**
 * Load the stable gateway Bearer key, creating it once if missing.
 * Never log the return value.
 */
export function loadOrCreateStableGatewayKey(home: string): string {
  mkdirSync(home, { recursive: true })
  const path = stableGatewayKeyPath(home)
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing.length >= 16) return existing
  }
  const key = randomBytes(32).toString('base64url')
  writeFileSync(path, `${key}\n`, { encoding: 'utf8', mode: 0o600, flag: 'w' })
  try { chmodSync(path, 0o600) } catch { /* Windows may ignore mode; key still required at the door. */ }
  return key
}

export function stableGatewayHostAllowed(host: string | undefined): boolean {
  if (hostIsLoopback(host)) return true
  if (host === undefined || host.trim() === '') return false
  const name = hostnameOfHost(host)
  const trimmed = name.endsWith('.') && !name.endsWith('..') ? name.slice(0, -1) : name
  return DOCKER_HOSTNAMES.has(trimmed)
}

function bearerOk(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (match === null) return false
  const presented = match[1] as string
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
  })
  res.end(payload)
}

function writeOpenAIError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { error: { message, type: 'invalid_request_error', code } })
}

function filterHeaders(headers: IncomingHttpHeaders, extra: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    if (key.toLowerCase() === 'host' || key.toLowerCase() === 'authorization') continue
    out[key] = value
  }
  return { ...out, ...extra }
}

function parseRegionPath(url: string): { region: WorkBuddyRegion, path: string } | undefined {
  const raw = url.split('?')[0] ?? url
  const path = raw.endsWith('/') && raw.length > 1 ? raw.slice(0, -1) : raw
  const cn = path.match(/^\/cn(\/.*)?$/)
  if (cn) return { region: 'cn', path: cn[1] && cn[1] !== '' ? cn[1] : '/' }
  const global = path.match(/^\/global(\/.*)?$/)
  if (global) return { region: 'global', path: global[1] && global[1] !== '' ? global[1] : '/' }
  return undefined
}

function allowedUpstreamPath(path: string): boolean {
  return path === '/healthz' || path === '/v1/models' || path === '/v1/chat/completions'
}

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  shim: StableGatewayShim,
  path: string,
): void {
  let target: URL
  try {
    target = new URL(path, `${shim.baseUrl().replace(/\/$/, '')}/`)
  } catch {
    writeOpenAIError(res, 503, 'shim_unavailable', 'WorkBuddy loopback shim is not listening')
    return
  }
  const headers = filterHeaders(req.headers, {
    host: '127.0.0.1',
    authorization: `Bearer ${shim.token()}`,
  })
  const upstream = httpRequest({
    protocol: 'http:',
    hostname: '127.0.0.1',
    port: target.port,
    path: `${target.pathname}${target.search}`,
    method: req.method,
    headers,
  }, up => {
    if (res.headersSent) {
      up.resume()
      return
    }
    res.writeHead(up.statusCode ?? 502, filterHeaders(up.headers, {}))
    up.pipe(res)
  })
  upstream.on('error', () => {
    writeOpenAIError(res, 502, 'shim_unreachable', 'Failed to reach the WorkBuddy loopback shim')
  })
  req.pipe(upstream)
}

/**
 * Start the stable gateway when a local config or key file enables it.
 * Returns undefined when disabled. Failures to bind are surfaced on `ready`.
 */
export function startStableGateway(options: StableGatewayOptions): StableGateway | undefined {
  const home = options.home ?? resolveDshHome()
  const fileConfig = readStableGatewayConfig(home)
  if (!fileConfig.enabled) return undefined

  const bindHost = options.host ?? fileConfig.host
  const bindPort = options.port ?? fileConfig.port
  const key = loadOrCreateStableGatewayKey(home)
  const logger = options.logger

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  let disposed = false

  server.on('error', (error: Error) => {
    if (server.listening) logger?.error('dsh-connect-workbuddy: stable gateway listener error', error)
  })

  const ready = new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('error', onError)
      reject(error)
    }
    server.once('error', onError)
    server.listen(bindPort, bindHost, () => {
      server.off('error', onError)
      resolve()
    })
  })

  ready.then(() => {
    if (!disposed) {
      logger?.warn(`dsh-connect-workbuddy: stable gateway listening on ${bindHost}:${bindPort} (cn=/cn/v1, global=/global/v1)`)
    }
  }).catch((error: unknown) => {
    logger?.error('dsh-connect-workbuddy: stable gateway failed to listen', error)
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!stableGatewayHostAllowed(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must be loopback or host.docker.internal')
        return
      }
      if (!bearerOk(req.headers.authorization, key)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      const pathname = (url.split('?')[0] ?? url)
      const normalized = pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname
      if (req.method === 'GET' && normalized === '/healthz') {
        const regions: Record<string, boolean> = {}
        for (const region of ['cn', 'global'] as const) {
          try {
            void options.shims[region].baseUrl()
            regions[region] = true
          } catch {
            regions[region] = false
          }
        }
        writeJson(res, 200, { ok: true, regions })
        return
      }
      const routed = parseRegionPath(url)
      if (routed === undefined || !allowedUpstreamPath(routed.path)) {
        writeOpenAIError(res, 404, 'not_found', 'Not found')
        return
      }
      if (req.method !== 'GET' && req.method !== 'POST') {
        writeOpenAIError(res, 405, 'method_not_allowed', 'Method not allowed')
        return
      }
      if (routed.path === '/v1/chat/completions' && req.method !== 'POST') {
        writeOpenAIError(res, 405, 'method_not_allowed', 'Method not allowed')
        return
      }
      if ((routed.path === '/healthz' || routed.path === '/v1/models') && req.method !== 'GET') {
        writeOpenAIError(res, 405, 'method_not_allowed', 'Method not allowed')
        return
      }
      const search = url.includes('?') ? url.slice(url.indexOf('?')) : ''
      forward(req, res, options.shims[routed.region], `${routed.path}${search}`)
    } catch (error) {
      logger?.error('dsh-connect-workbuddy: stable gateway request failed', error)
      writeOpenAIError(res, 500, 'internal_error', 'Stable gateway failed to handle the request')
    }
  }

  const port = (): number => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('stable gateway has no listening address')
    }
    return address.port
  }

  return {
    ready,
    port,
    address: () => bindHost,
    close: async () => {
      disposed = true
      if (!server.listening) return
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    },
  }
}

export function tryStartStableGateway(options: StableGatewayOptions): StableGateway | undefined {
  try {
    return startStableGateway(options)
  } catch (error) {
    options.logger?.error('dsh-connect-workbuddy: stable gateway failed to start', error)
    return undefined
  }
}
