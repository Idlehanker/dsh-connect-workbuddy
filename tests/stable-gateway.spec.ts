import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import {
  DEFAULT_STABLE_GATEWAY_PORT,
  loadOrCreateStableGatewayKey,
  readStableGatewayConfig,
  startStableGateway,
  stableGatewayConfigPath,
  stableGatewayHostAllowed,
  stableGatewayKeyPath,
  type StableGateway,
  type StableGatewayShim,
} from '../src/stable-gateway.ts'

let gateway: StableGateway | undefined
let shimServer: Server | undefined

afterEach(async () => {
  await gateway?.close()
  gateway = undefined
  if (shimServer !== undefined) {
    await new Promise<void>((resolve, reject) => {
      shimServer!.close(error => error ? reject(error) : resolve())
    })
    shimServer = undefined
  }
})

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'wb-stable-gw-'))
}

function enableGateway(home: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(stableGatewayConfigPath(home), JSON.stringify({ enabled: true, port: 0, host: '127.0.0.1', ...extra }), 'utf8')
}

async function listenShim(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ port: number, token: { value: string }, shim: StableGatewayShim }> {
  const token = { value: 'shim-secret-one' }
  const server = createServer((req, res) => handler(req, res))
  shimServer = server
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no shim port')
  const port = address.port
  return {
    port,
    token,
    shim: {
      baseUrl: () => `http://127.0.0.1:${port}`,
      token: () => token.value,
    },
  }
}

function call(
  port: number,
  options: { method?: string, path: string, host?: string, token?: string, body?: string, headers?: Record<string, string> },
): Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? ''
    const headers: Record<string, string> = {
      host: options.host ?? '127.0.0.1',
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(body === '' ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
      ...options.headers,
    }
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: options.path,
      method: options.method ?? 'GET',
      headers,
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => { chunks.push(chunk as Buffer) })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    if (body !== '') req.write(body)
    req.end()
  })
}

describe('stable gateway host allow-list', () => {
  it('accepts loopback and docker host gateway names, with or without a port', () => {
    expect(stableGatewayHostAllowed('127.0.0.1')).toBe(true)
    expect(stableGatewayHostAllowed('127.0.0.1:4010')).toBe(true)
    expect(stableGatewayHostAllowed('localhost')).toBe(true)
    expect(stableGatewayHostAllowed('localhost:4010')).toBe(true)
    expect(stableGatewayHostAllowed('host.docker.internal')).toBe(true)
    expect(stableGatewayHostAllowed('host.docker.internal:4010')).toBe(true)
    expect(stableGatewayHostAllowed('example.com')).toBe(false)
    expect(stableGatewayHostAllowed('192.168.1.10:4010')).toBe(false)
    expect(stableGatewayHostAllowed(undefined)).toBe(false)
  })
})

describe('stable gateway config', () => {
  it('stays off when neither config nor key file is present', () => {
    const home = tempHome()
    expect(readStableGatewayConfig(home).enabled).toBe(false)
    expect(startStableGateway({ home, shims: { cn: dummyShim(), global: dummyShim() } })).toBeUndefined()
  })

  it('creates a reusable key file and does not rewrite it on the next start', () => {
    const home = tempHome()
    const first = loadOrCreateStableGatewayKey(home)
    const second = loadOrCreateStableGatewayKey(home)
    expect(second).toBe(first)
    expect(existsSync(stableGatewayKeyPath(home))).toBe(true)
    expect(readFileSync(stableGatewayKeyPath(home), 'utf8').trim()).toBe(first)
    expect(first.length).toBeGreaterThanOrEqual(16)
  })
})

function dummyShim(): StableGatewayShim {
  return {
    baseUrl: () => { throw new Error('not listening') },
    token: () => 'unused',
  }
}

describe('stable gateway proxy', () => {
  it('requires its own bearer, forwards region paths with a loopback Host and the live shim token, and picks up a token change', async () => {
    const seen: Array<{ url?: string, host?: string, authorization?: string }> = []
    const { token, shim } = await listenShim((req, res) => {
      seen.push({
        url: req.url,
        host: Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host,
        authorization: Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization,
      })
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, from: 'shim' }))
        return
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'wb-model', object: 'model' }] }))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const home = tempHome()
    enableGateway(home)
    const key = loadOrCreateStableGatewayKey(home)
    gateway = startStableGateway({
      home,
      host: '127.0.0.1',
      port: 0,
      shims: { cn: shim, global: dummyShim() },
    })
    expect(gateway).toBeDefined()
    await gateway!.ready
    const port = gateway!.port()
    expect(port).not.toBe(DEFAULT_STABLE_GATEWAY_PORT)

    const denied = await call(port, { path: '/cn/healthz' })
    expect(denied.status).toBe(401)

    const badHost = await call(port, { path: '/cn/healthz', token: key, host: 'evil.example' })
    expect(badHost.status).toBe(403)

    const health = await call(port, { path: '/cn/healthz', token: key, host: 'host.docker.internal:4010' })
    expect(health.status).toBe(200)
    expect(JSON.parse(health.body)).toEqual({ ok: true, from: 'shim' })
    expect(seen[0]?.url).toBe('/healthz')
    expect(seen[0]?.host).toBe('127.0.0.1')
    expect(seen[0]?.authorization).toBe(`Bearer ${token.value}`)

    const models = await call(port, { path: '/cn/v1/models', token: key })
    expect(models.status).toBe(200)
    expect(JSON.parse(models.body).data[0].id).toBe('wb-model')

    token.value = 'shim-secret-two'
    const again = await call(port, { path: '/cn/healthz', token: key })
    expect(again.status).toBe(200)
    expect(seen.at(-1)?.authorization).toBe('Bearer shim-secret-two')
  })
})
