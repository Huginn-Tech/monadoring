// API client for Huginn Staking API

export type ValidatorStatus = 'active' | 'inactive'

export interface ValidatorInfo {
  id: number
  name: string
  secp_address: string
  status?: ValidatorStatus
}

export interface UptimeStats {
  validator_id: number
  validator_name: string
  finalized_count: number
  timeout_count: number
  total_events: number
  uptime_percent: number
  last_round: number
  last_block_height: number | null
  status?: ValidatorStatus
}

export interface HistoryEvent {
  round: number
  height: number | null
  status: 'finalized' | 'timeout'
}

export interface HistoryResponse {
  success: boolean
  validator_id: number
  validator_name: string
  count: number
  history: HistoryEvent[]
}

export interface ValidatorResponse {
  success: boolean
  validator: ValidatorInfo
}

export interface UptimeResponse {
  success: boolean
  uptime: UptimeStats
}

const API_ENDPOINTS = {
  mainnet: 'https://validator-api.huginn.tech/monad-api',
  testnet: 'https://validator-api-testnet.huginn.tech/monad-api'
}

export async function fetchValidatorInfo(
  validatorId: string,
  network: 'mainnet' | 'testnet'
): Promise<ValidatorInfo | null> {
  try {
    const baseUrl = API_ENDPOINTS[network]
    const res = await fetch(`${baseUrl}/validator/${validatorId}`)

    if (!res.ok) return null

    const data: ValidatorResponse = await res.json()
    return data.success ? data.validator : null
  } catch (error) {
    console.error(`Failed to fetch validator info:`, error)
    return null
  }
}

export async function fetchUptimeStats(
  validatorId: string,
  network: 'mainnet' | 'testnet'
): Promise<UptimeStats | null> {
  try {
    const baseUrl = API_ENDPOINTS[network]
    const res = await fetch(`${baseUrl}/validator/uptime/${validatorId}`)

    if (!res.ok) return null

    const data: UptimeResponse = await res.json()
    return data.success ? data.uptime : null
  } catch (error) {
    console.error(`Failed to fetch uptime stats:`, error)
    return null
  }
}

export async function fetchHistory(
  validatorId: string,
  network: 'mainnet' | 'testnet',
  limit: number = 50
): Promise<{ history: HistoryEvent[], validatorName: string } | null> {
  try {
    const baseUrl = API_ENDPOINTS[network]
    const res = await fetch(`${baseUrl}/validator/uptime/${validatorId}/history?limit=${limit}`)

    if (!res.ok) return null

    const data: HistoryResponse = await res.json()
    if (!data.success) return null

    return {
      history: data.history,
      validatorName: data.validator_name
    }
  } catch (error) {
    console.error(`Failed to fetch history:`, error)
    return null
  }
}

export async function fetchBlockHeight(rpcUrl: string, timeoutMs: number = 10000): Promise<number> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
        id: 1
      }),
      signal: controller.signal
    })

    clearTimeout(timeout)

    if (!res.ok) return 0

    const data = await res.json()
    if (!data.result) return 0

    const height = parseInt(data.result, 16)
    return Number.isFinite(height) ? height : 0
  } catch (error) {
    console.error(`Failed to fetch block height:`, error)
    return 0
  }
}

export async function fetchCurrentEpoch(
  network: 'mainnet' | 'testnet'
): Promise<number | null> {
  try {
    const baseUrl = API_ENDPOINTS[network]
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    const res = await fetch(`${baseUrl}/staking/epoch`, { signal: controller.signal })
    clearTimeout(timeout)

    if (!res.ok) return null

    const data = await res.json()
    const candidate =
      typeof data?.epoch === 'number' ? data.epoch
      : typeof data?.data?.epoch === 'number' ? data.data.epoch
      : typeof data?.current_epoch === 'number' ? data.current_epoch
      : null

    return candidate
  } catch (error) {
    console.error('Failed to fetch current epoch:', error)
    return null
  }
}

export interface RpcHealthState {
  height: number
  staleCount: number
}

/**
 * Decide whether an RPC is healthy from its block height progression.
 *
 * Answering `eth_blockNumber` is not enough: an endpoint can keep replying
 * while its height sits still, which means it is stuck rather than healthy.
 * Callers keep the returned state and hand it back on the next check.
 */
export function evaluateRpcHealth(
  previous: RpcHealthState | undefined,
  currentHeight: number,
  staleLimit: number = 2
): { healthy: boolean; state: RpcHealthState } {
  if (currentHeight <= 0) {
    return {
      healthy: false,
      state: { height: previous?.height ?? 0, staleCount: (previous?.staleCount ?? 0) + 1 }
    }
  }

  // First observation - nothing to compare against yet
  if (!previous) {
    return { healthy: true, state: { height: currentHeight, staleCount: 0 } }
  }

  if (currentHeight > previous.height) {
    return { healthy: true, state: { height: currentHeight, staleCount: 0 } }
  }

  const staleCount = previous.staleCount + 1
  return {
    healthy: staleCount < staleLimit,
    state: { height: currentHeight, staleCount }
  }
}

export function extractNameFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname
    const parts = hostname.split('.')
    const domainPart = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
    return domainPart.charAt(0).toUpperCase() + domainPart.slice(1)
  } catch {
    return url
  }
}

export function parseRpcConfig(envValue: string): { url: string; name: string }[] {
  if (!envValue) return []
  return envValue.split(',').map((entry) => {
    const trimmed = entry.trim()
    if (trimmed.includes(':https://') || trimmed.includes(':http://')) {
      const colonIndex = trimmed.indexOf(':http')
      return {
        name: trimmed.substring(0, colonIndex),
        url: trimmed.substring(colonIndex + 1)
      }
    }
    return {
      name: extractNameFromUrl(trimmed),
      url: trimmed
    }
  }).filter(rpc => rpc.url)
}
