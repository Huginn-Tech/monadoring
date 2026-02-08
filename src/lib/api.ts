// API client for Huginn Staking API

export interface ValidatorInfo {
  id: number
  name: string
  secp_address: string
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

export async function fetchBlockHeight(rpcUrl: string): Promise<number> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    
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
    return parseInt(data.result, 16)
  } catch (error) {
    console.error(`Failed to fetch block height:`, error)
    return 0
  }
}

export async function checkRpcHealth(rpcUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    
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
    
    if (!res.ok) return false
    
    const data = await res.json()
    return !!data.result
  } catch {
    return false
  }
}
