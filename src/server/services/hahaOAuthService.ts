/**
 * HahaOAuthService — cc-haha-managed Claude OAuth token
 *
 * 这个 service 把 token 存到 haha 自己的目录,并通过 env 注入给 CLI。
 *
 * 复用 src/services/oauth/{crypto,client}.ts 里的 PKCE + token exchange 逻辑,
 * 不复制粘贴 —— 保证跟 CLI 走同一套协议实现。
 */

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from '../../services/oauth/crypto.js'
import {
  buildAuthUrl,
  fetchProfileInfo,
  refreshOAuthToken,
  isOAuthTokenExpired,
  parseScopes,
} from '../../services/oauth/client.js'
import type {
  OAuthTokens,
  OAuthTokenExchangeResponse,
  SubscriptionType,
} from '../../services/oauth/types.js'
import { getOauthConfig } from '../../constants/oauth.js'

export type StoredOAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[]
  subscriptionType: SubscriptionType | null
}

export type OAuthSession = {
  state: string
  codeVerifier: string
  authorizeUrl: string
  serverPort: number
  createdAt: number
}

type RefreshFn = (refreshToken: string, opts?: { scopes?: string[] }) => Promise<OAuthTokens>
type FetchProfileFn = (
  accessToken: string,
) => Promise<{ subscriptionType: SubscriptionType | null }>

const SESSION_TTL_MS = 5 * 60 * 1000
const OAUTH_CALLBACK_PATH = '/callback'

export class HahaOAuthService {
  private sessions = new Map<string, OAuthSession>()
  private refreshFn: RefreshFn = refreshOAuthToken
  private fetchProfileFn: FetchProfileFn = fetchProfileInfo

  setRefreshFn(fn: RefreshFn): void {
    this.refreshFn = fn
  }

  setFetchProfileFn(fn: FetchProfileFn): void {
    this.fetchProfileFn = fn
  }

  private getOAuthFilePath(): string {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    return path.join(configDir, 'cc-haha', 'oauth.json')
  }

  async loadTokens(): Promise<StoredOAuthTokens | null> {
    try {
      const raw = await fs.readFile(this.getOAuthFilePath(), 'utf-8')
      return JSON.parse(raw) as StoredOAuthTokens
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    const filePath = this.getOAuthFilePath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    // 写临时文件再 rename,防止写到一半被其他读者读到残缺 JSON。
    // 单进程 desktop 下 pid 后缀足够隔离。
    const tmp = `${filePath}.tmp.${process.pid}`
    await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 })
    await fs.rename(tmp, filePath)
  }

  async deleteTokens(): Promise<void> {
    try {
      await fs.unlink(this.getOAuthFilePath())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  startSession({ serverPort }: { serverPort: number }): OAuthSession {
    this.pruneExpiredSessions()

    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = generateState()

    const authorizeUrl = buildAuthUrl({
      codeChallenge,
      state,
      port: serverPort,
      isManual: false,
      loginWithClaudeAi: true,
    })

    const session: OAuthSession = {
      state,
      codeVerifier,
      authorizeUrl,
      serverPort,
      createdAt: Date.now(),
    }
    this.sessions.set(state, session)
    return session
  }

  getSession(state: string): OAuthSession | null {
    const s = this.sessions.get(state)
    if (!s) return null
    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(state)
      return null
    }
    return s
  }

  consumeSession(state: string): OAuthSession | null {
    const s = this.getSession(state)
    if (s) this.sessions.delete(state)
    return s
  }

  private pruneExpiredSessions(): void {
    const now = Date.now()
    for (const [state, s] of this.sessions.entries()) {
      if (now - s.createdAt > SESSION_TTL_MS) this.sessions.delete(state)
    }
  }

  async completeSession(
    authorizationCode: string,
    state: string,
  ): Promise<StoredOAuthTokens> {
    const session = this.consumeSession(state)
    if (!session) {
      throw new Error('OAuth session not found or expired')
    }

    const response = await this.exchangeWithCustomCallback(
      authorizationCode,
      state,
      session.codeVerifier,
      session.serverPort,
    )
    const profile = await this.fetchProfileFn(response.access_token)

    const tokens: StoredOAuthTokens = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? null,
      expiresAt: Date.now() + response.expires_in * 1000,
      scopes: parseScopes(response.scope),
      subscriptionType: profile.subscriptionType,
    }
    await this.saveTokens(tokens)
    return tokens
  }

  private async exchangeWithCustomCallback(
    code: string,
    state: string,
    verifier: string,
    port: number,
  ): Promise<OAuthTokenExchangeResponse> {
    const requestBody = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: `http://localhost:${port}${OAUTH_CALLBACK_PATH}`,
      client_id: getOauthConfig().CLIENT_ID,
      code_verifier: verifier,
      state,
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15_000)
    let res: Response
    try {
      res = await fetch(getOauthConfig().TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }
    if (!res.ok) {
      throw new Error(
        `Token exchange failed (${res.status}): ${await res.text()}`,
      )
    }
    return (await res.json()) as OAuthTokenExchangeResponse
  }

  async ensureFreshTokens(): Promise<StoredOAuthTokens | null> {
    const tokens = await this.loadTokens()
    if (!tokens) return null

    if (tokens.expiresAt === null) return tokens

    if (!isOAuthTokenExpired(tokens.expiresAt)) return tokens

    if (!tokens.refreshToken) return null

    try {
      const refreshed = await this.refreshFn(tokens.refreshToken, {
        scopes: tokens.scopes,
      })
      const updated: StoredOAuthTokens = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
        expiresAt: refreshed.expiresAt,
        scopes: refreshed.scopes,
        subscriptionType: refreshed.subscriptionType ?? tokens.subscriptionType,
      }
      await this.saveTokens(updated)
      return updated
    } catch (err) {
      console.error(
        '[HahaOAuthService] token refresh failed:',
        err instanceof Error ? err.message : err,
      )
      return null
    }
  }

  async ensureFreshAccessToken(): Promise<string | null> {
    const tokens = await this.ensureFreshTokens()
    return tokens?.accessToken ?? null
  }
}

export const hahaOAuthService = new HahaOAuthService()
