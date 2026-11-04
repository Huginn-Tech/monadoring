// Next.js Instrumentation - runs on server startup
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

import { sendLifecycleNotifications, sendRpcAlert, sendTelegramAlert, sendDiscordAlert, sendSlackAlert, sendTelegramStatusChange, sendDiscordStatusChange, sendSlackStatusChange, sendPagerDutyAlert } from '@/lib/alerts'
import { parseRpcConfig } from '@/lib/api'

let shutdownHandlersRegistered = false
let missedBlockCheckInterval: NodeJS.Timeout | null = null

// Track last known block for missed block detection
interface ValidatorBlockState {
  lastRound: number
  lastStatus: 'finalized' | 'timeout'
  consecutiveMisses: number
  alertedForMiss: boolean
  /** When lastRound last moved; bounds how far the next round may jump. */
  roundAt: number
  /** A PagerDuty incident is open for this validator. */
  pagerdutyTriggered: boolean
}

function isTimeout(err: unknown): boolean {
  const name = (err as Error)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

// A check that outlives its interval is skipped, not stacked: overlapping runs
// read the same state and would send the same alert twice.
function runExclusive(label: string, busy: { running: boolean }, fn: () => Promise<void>) {
  if (busy.running) {
    console.warn(`[Monadoring] ${label} still running, skipping this tick`)
    return
  }
  busy.running = true
  fn()
    .catch((err) => console.error(`[Monadoring] ${label} error:`, err))
    .finally(() => { busy.running = false })
}
const missedBlockCheckBusy = { running: false }
const rpcHealthCheckBusy = { running: false }
const validatorBlockStates: Map<string, ValidatorBlockState> = new Map()

// Track validator active/inactive set membership
const validatorStatusStates: Map<string, 'active' | 'inactive'> = new Map()
let cachedConfig: Awaited<ReturnType<typeof getAlertConfig>> | null = null
let rpcHealthCheckInterval: NodeJS.Timeout | null = null

// Track RPC heights for stale detection
const rpcHeights: Map<string, { height: number; staleCount: number }> = new Map()

// Track all-offline state to avoid duplicate alerts
let allOfflineState: {
  mainnet: { isOffline: boolean; since: Date | null; alertSent: boolean }
  testnet: { isOffline: boolean; since: Date | null; alertSent: boolean }
} = {
  mainnet: { isOffline: false, since: null, alertSent: false },
  testnet: { isOffline: false, since: null, alertSent: false }
}

// Track which RPC each network is currently served from, for failover/recovery alerts
const activeRpcState: Record<'mainnet' | 'testnet', { index: number; failedOver: boolean }> = {
  mainnet: { index: 0, failedOver: false },
  testnet: { index: 0, failedOver: false }
}

// Track last known block heights from Uptime API to detect chain progress
let lastKnownHeight: { mainnet: number; testnet: number } = { mainnet: 0, testnet: 0 }

const NAME_API = {
  mainnet: 'https://validator-api.huginn.tech/monad-api',
  testnet: 'https://validator-api-testnet.huginn.tech/monad-api'
}

// Validator names come from an external API and end up inside Telegram
// Markdown, Discord and Slack messages. Strip the characters that are markup
// there, so a name can neither add links or mentions nor make Telegram
// reject (and so silently drop) every alert that carries it.
function sanitizeValidatorName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const clean = raw
    .replace(/[\u0000-\u001f\u007f*_`[\]()<>&|~\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
  return clean || undefined
}

// Names per validator, so a second validator's alerts carry its own name.
const validatorNames = new Map<string, string>()

async function getValidatorName(network: 'mainnet' | 'testnet', validatorId: string): Promise<string | undefined> {
  const key = `${network}:${validatorId}`
  const cached = validatorNames.get(key)
  if (cached) return cached

  try {
    const res = await fetch(`${NAME_API[network]}/validator/uptime/${encodeURIComponent(validatorId)}/history?limit=1`, {
      signal: AbortSignal.timeout(5000)
    })
    const data = await res.json()
    const name = data?.success ? sanitizeValidatorName(data.validator_name) : undefined
    if (name) validatorNames.set(key, name)
    return name
  } catch (error) {
    console.error(`[Monadoring] Failed to fetch validator name for ${key}:`, error)
    return undefined
  }
}

// Name for the startup/shutdown messages: the first configured validator.
async function getPrimaryValidatorName(): Promise<string | undefined> {
  const firstMainnetId = (process.env.MAINNET_VALIDATORS || '').split(',')[0]?.trim()
  const firstTestnetId = (process.env.TESTNET_VALIDATORS || '').split(',')[0]?.trim()
  if (firstMainnetId) {
    const name = await getValidatorName('mainnet', firstMainnetId)
    if (name) return name
  }
  if (firstTestnetId) return getValidatorName('testnet', firstTestnetId)
  return undefined
}

async function getAlertConfig() {
  const telegram = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
    ? { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID }
    : undefined

  const discord = process.env.DISCORD_WEBHOOK_URL
    ? { webhookUrl: process.env.DISCORD_WEBHOOK_URL }
    : undefined

  const slack = process.env.SLACK_WEBHOOK_URL
    ? { webhookUrl: process.env.SLACK_WEBHOOK_URL }
    : undefined

  const port = process.env.PORT || '3030'
  const dashboardUrl = `http://localhost:${port}`
  const validatorName = await getPrimaryValidatorName()

  // Alert status for notification display
  const alertStatus = {
    telegram: !!telegram,
    discord: !!discord,
    slack: !!slack,
    pagerduty: !!process.env.PAGERDUTY_ROUTING_KEY
  }

  return { telegram, discord, slack, validatorName, dashboardUrl, alertStatus }
}

async function sendStartupNotification() {
  const config = await getAlertConfig()
  cachedConfig = config // Cache for shutdown use

  if (!config.telegram && !config.discord && !config.slack) {
    console.log('[Monadoring] No alert services configured, skipping startup notification')
    return
  }

  console.log('[Monadoring] Sending startup notifications...')
  console.log('[Monadoring] Config:', {
    telegram: config.telegram ? 'configured' : 'not configured',
    discord: config.discord ? 'configured' : 'not configured',
    slack: config.slack ? 'configured' : 'not configured'
  })

  try {
    const results = await sendLifecycleNotifications('startup', config)

    if (config.telegram) {
      console.log(`[Monadoring] Telegram: ${results.telegram ? 'sent' : 'FAILED'}`)
    }
    if (config.discord) {
      console.log(`[Monadoring] Discord: ${results.discord ? 'sent' : 'FAILED'}`)
    }
    if (config.slack) {
      console.log(`[Monadoring] Slack: ${results.slack ? 'sent' : 'FAILED'}`)
    }
  } catch (error) {
    console.error('[Monadoring] Startup notification error:', error)
  }
}

async function sendShutdownNotification() {
  // Use cached config to avoid network calls during shutdown
  const config = cachedConfig

  if (!config || (!config.telegram && !config.discord && !config.slack)) {
    return
  }

  console.log('[Monadoring] Sending shutdown notifications...')
  const results = await sendLifecycleNotifications('shutdown', config)

  if (results.telegram) console.log('[Monadoring] Telegram shutdown notification sent')
  if (results.discord) console.log('[Monadoring] Discord shutdown notification sent')
  if (results.slack) console.log('[Monadoring] Slack shutdown notification sent')
}

function registerShutdownHandlers() {
  if (shutdownHandlersRegistered) return
  shutdownHandlersRegistered = true

  let isShuttingDown = false

  const handleShutdown = (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true

    console.log(`[Monadoring] Received ${signal}, shutting down...`)

    // Send notification then exit
    const doShutdown = async () => {
      try {
        // Send notification with timeout
        const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 5000))
        const notificationPromise = sendShutdownNotification()

        await Promise.race([notificationPromise, timeoutPromise])
        console.log('[Monadoring] Shutdown complete')
      } catch (err) {
        console.error('[Monadoring] Shutdown notification error:', err)
      } finally {
        process.exit(0)
      }
    }

    doShutdown()
  }

  // Handle both SIGTERM and SIGINT
  process.on('SIGTERM', () => handleShutdown('SIGTERM'))
  process.on('SIGINT', () => handleShutdown('SIGINT'))

  // Also handle beforeExit for graceful shutdown
  process.on('beforeExit', () => {
    if (!isShuttingDown) {
      handleShutdown('beforeExit')
    }
  })
}

// Check if chain is progressing by fetching latest block height from Uptime API
async function checkChainProgress(network: 'mainnet' | 'testnet'): Promise<boolean> {
  const validators = network === 'mainnet'
    ? process.env.MAINNET_VALIDATORS
    : process.env.TESTNET_VALIDATORS

  const firstValidatorId = (validators || '').split(',')[0]?.trim()
  if (!firstValidatorId) return false

  const API = {
    mainnet: 'https://validator-api.huginn.tech/monad-api',
    testnet: 'https://validator-api-testnet.huginn.tech/monad-api'
  }

  try {
    const res = await fetch(`${API[network]}/validator/uptime/${firstValidatorId}`, {
      signal: AbortSignal.timeout(5000)
    })

    if (!res.ok) return false
    const data = await res.json()

    if (data.success && data.uptime?.last_block_height) {
      const currentHeight = data.uptime.last_block_height
      const previousHeight = lastKnownHeight[network]

      // Update last known height
      lastKnownHeight[network] = currentHeight

      // If we have a previous height and current is greater, chain is progressing
      if (previousHeight > 0 && currentHeight > previousHeight) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

// Consecutive bad checks (probe failure, lagging or stale height) before an RPC
// counts as unhealthy. At the 1 minute check interval this tolerates ~3 minutes,
// so a single slow probe no longer fires a failover alert.
const RPC_FAIL_THRESHOLD = 3

// Blocks an RPC may trail the best-responding RPC before it counts as lagging.
// Monad blocks land roughly every 0.4s, so 50 blocks is ~20 seconds behind.
const RPC_LAG_THRESHOLD = 50

// Check RPC health and return block height (0 = offline/error)
async function checkRpcHealth(url: string): Promise<number> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}',
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) {
      console.warn(`[Monadoring] RPC probe ${url} returned HTTP ${res.status}`)
      return 0
    }
    const data = await res.json()
    const height = data.result ? parseInt(data.result, 16) : 0
    return Number.isFinite(height) ? height : 0
  } catch (err) {
    const e = err as Error
    console.warn(`[Monadoring] RPC probe ${url} failed: ${e?.name || 'Error'}: ${e?.message || 'unknown'}`)
    return 0
  }
}

// Check if RPC is healthy. Three failure modes, all sharing one consecutive
// strike counter (RPC_FAIL_THRESHOLD in a row = unhealthy):
// - no response at all (probe timeout/error, height 0)
// - lagging: more than RPC_LAG_THRESHOLD blocks behind the median RPC this round
// - stale: own height not advancing between checks (catches a halted chain
//   even when every RPC reports the same stuck height)
function isRpcHealthy(url: string, currentHeight: number, bestHeight: number): boolean {
  const prev = rpcHeights.get(url)

  if (currentHeight === 0) {
    // No response - can't measure lag, count the miss and keep last known height
    const strikes = (prev?.staleCount ?? 0) + 1
    rpcHeights.set(url, { height: prev?.height ?? 0, staleCount: strikes })
    return strikes < RPC_FAIL_THRESHOLD
  }

  const lag = bestHeight - currentHeight
  const advanced = !prev || currentHeight > prev.height

  if (lag <= RPC_LAG_THRESHOLD && advanced) {
    rpcHeights.set(url, { height: currentHeight, staleCount: 0 })
    return true
  }

  const strikes = (prev?.staleCount ?? 0) + 1
  rpcHeights.set(url, { height: currentHeight, staleCount: strikes })
  if (lag > RPC_LAG_THRESHOLD) {
    console.warn(`[Monadoring] RPC ${url} lagging ${lag} blocks behind the median (${currentHeight} vs ${bestHeight}), strike ${strikes}/${RPC_FAIL_THRESHOLD}`)
  }
  return strikes < RPC_FAIL_THRESHOLD
}

// Alert when the active RPC fails, and again when the primary comes back.
// Lives here rather than in the dashboard so alerts fire even with no browser open.
async function checkRpcFailover(
  network: 'mainnet' | 'testnet',
  rpcs: { url: string; name: string }[],
  healthy: boolean[]
) {
  if (!cachedConfig || rpcs.length === 0) return

  const state = activeRpcState[network]
  if (state.index >= rpcs.length) state.index = 0

  const label = network.charAt(0).toUpperCase() + network.slice(1)

  // Primary is back - return to it whether or not the current RPC is still fine
  if (state.failedOver && state.index !== 0 && healthy[0]) {
    console.log(`[Monadoring] ${label} primary RPC recovered: ${rpcs[0].name}`)
    await sendRpcAlert(cachedConfig, {
      type: 'recovered',
      rpcUrl: rpcs[0].url,
      network,
      isPrimary: true,
      failoverFrom: rpcs[state.index].name,
      failoverTo: rpcs[0].name
    })

    state.index = 0
    state.failedOver = false
    return
  }

  if (healthy[state.index]) return

  for (let i = 1; i < rpcs.length; i++) {
    const next = (state.index + i) % rpcs.length
    if (!healthy[next]) continue

    console.log(`[Monadoring] ${label} RPC failover: ${rpcs[state.index].name} -> ${rpcs[next].name}`)
    await sendRpcAlert(cachedConfig, {
      type: 'failover',
      rpcUrl: rpcs[next].url,
      network,
      isPrimary: next === 0,
      failoverFrom: rpcs[state.index].name,
      failoverTo: rpcs[next].name
    })

    state.index = next
    state.failedOver = next !== 0
    return
  }

  // Nothing healthy to switch to - the all-offline check reports that case
}

// Lag is measured against the median height of the RPCs that answered (the
// upper median for an even count), so one RPC reporting an inflated height
// cannot make every honest RPC look behind and trigger failover alerts.
function referenceHeight(heights: number[]): number {
  const answered = heights.filter((h) => h > 0).sort((a, b) => a - b)
  if (answered.length === 0) return 0
  return answered[Math.floor(answered.length / 2)]
}

// Check one network's RPCs: failover/recovery alerts plus all-offline detection
async function checkNetworkRpcs(network: 'mainnet' | 'testnet') {
  if (!cachedConfig) return

  const configured = network === 'mainnet' ? process.env.MAINNET_RPCS : process.env.TESTNET_RPCS
  const rpcs = parseRpcConfig(configured || '')
  if (rpcs.length === 0) return

  // Probe every RPC first so lag can be judged against the best height this round
  const heights = await Promise.all(rpcs.map(rpc => checkRpcHealth(rpc.url)))
  const reference = referenceHeight(heights)
  const healthy = rpcs.map((rpc, i) => isRpcHealthy(rpc.url, heights[i], reference))

  await checkRpcFailover(network, rpcs, healthy)

  if (healthy.some(Boolean)) {
    allOfflineState[network] = { isOffline: false, since: null, alertSent: false }
    return
  }

  if (!allOfflineState[network].isOffline) {
    allOfflineState[network] = { isOffline: true, since: new Date(), alertSent: false }
  }

  const since = allOfflineState[network].since
  const downtime = since ? Math.floor((Date.now() - since.getTime()) / 1000 / 60) : 0

  if (downtime >= 3 && !allOfflineState[network].alertSent) {
    const chainProgressing = await checkChainProgress(network)
    const label = network.charAt(0).toUpperCase() + network.slice(1)
    console.log(`[Monadoring] All ${label} RPCs offline for ${downtime} minutes (chain progressing: ${chainProgressing})`)
    await sendRpcAlert(cachedConfig, {
      type: 'all_offline',
      rpcUrl: rpcs.map(r => r.url).join(', '),
      network,
      isPrimary: true,
      downtime: `${downtime} minutes`,
      chainProgressing
    })
    allOfflineState[network].alertSent = true
  }
}

// Run RPC health check for both networks
async function runRpcHealthCheck() {
  if (!cachedConfig) return

  await checkNetworkRpcs('mainnet')
  await checkNetworkRpcs('testnet')
}

// Start RPC health monitoring (failover, recovery and all-offline detection)
function startRpcHealthMonitoring() {
  const rpcAlerts = (process.env.RPC_ALERTS || '').toLowerCase()
  if (rpcAlerts !== 'on') {
    console.log('[Monadoring] RPC alerts disabled (set RPC_ALERTS=on to enable)')
    return
  }

  console.log('[Monadoring] RPC health monitoring enabled (1 min interval: failover, recovery, all-offline)')

  // First check after 30 seconds
  setTimeout(() => {
    runExclusive('RPC health check', rpcHealthCheckBusy, runRpcHealthCheck)
  }, 30 * 1000) // 30 seconds

  // Run health check every 1 minute
  rpcHealthCheckInterval = setInterval(() => {
    runExclusive('RPC health check', rpcHealthCheckBusy, runRpcHealthCheck)
  }, 60 * 1000) // 1 minute
}

// Check validator for missed blocks

const VALIDATOR_API = {
  mainnet: 'https://validator-api.huginn.tech/monad-api',
  testnet: 'https://validator-api-testnet.huginn.tech/monad-api'
}

// Monad rounds advance about 2.5 per second. A round further ahead than this
// rate allows since the last one seen is bad data from the API, not the chain,
// and is ignored so it cannot push lastRound past every real event.
const MAX_ROUNDS_PER_SECOND = 10
// The newest round falling this far below the last one seen means a chain
// reset (testnet) or a replaced API: the baseline starts over, without alerts.
const ROUND_RESET_GAP = 100_000
// Chat messages per validator per check. A run of misses in one check is one
// message (its streak counts them); beyond this only the latest are sent.
const MAX_ALERTS_PER_CHECK = 3

// PagerDuty: page once a timeout streak reaches the threshold, resolve when the
// validator finalizes again. Mainnet only unless PAGERDUTY_NETWORKS says more.
const PAGERDUTY_THRESHOLD = Math.max(1, parseInt(process.env.PAGERDUTY_THRESHOLD || '5', 10) || 5)
const PAGERDUTY_NETWORKS = new Set(
  (process.env.PAGERDUTY_NETWORKS || 'mainnet').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean)
)

type HistoryEvent = { round: number; height: number | null; status: 'finalized' | 'timeout' }
type ValidatorAlert = Parameters<typeof sendTelegramAlert>[2]

// Keep only well-formed events: safe-integer rounds and a known status.
function validHistory(raw: unknown): HistoryEvent[] {
  if (!Array.isArray(raw)) return []
  const out: HistoryEvent[] = []
  for (const e of raw as Array<Record<string, unknown> | null>) {
    if (!e || typeof e !== 'object') continue
    const { round, height, status } = e
    if (typeof round !== 'number' || !Number.isSafeInteger(round) || round < 0) continue
    if (status !== 'finalized' && status !== 'timeout') continue
    out.push({ round, height: typeof height === 'number' && Number.isSafeInteger(height) ? height : null, status })
  }
  return out
}

async function sendValidatorAlert(payload: ValidatorAlert) {
  if (!cachedConfig) return
  if (cachedConfig.telegram) {
    await sendTelegramAlert(cachedConfig.telegram.botToken, cachedConfig.telegram.chatId, payload)
  }
  if (cachedConfig.discord) {
    await sendDiscordAlert(cachedConfig.discord.webhookUrl, payload)
  }
  if (cachedConfig.slack) {
    await sendSlackAlert(cachedConfig.slack.webhookUrl, payload)
  }
}

async function updatePagerDuty(
  validatorId: string,
  network: 'mainnet' | 'testnet',
  validatorName: string,
  state: ValidatorBlockState,
  height: number | null
) {
  const routingKey = process.env.PAGERDUTY_ROUTING_KEY
  if (!routingKey || !PAGERDUTY_NETWORKS.has(network)) return
  const dedupKey = `monadoring-${network}-${validatorId}`
  const base = { validator: validatorName, network, height, round: state.lastRound }

  if (!state.pagerdutyTriggered && state.consecutiveMisses >= PAGERDUTY_THRESHOLD) {
    console.log(`[Monadoring] 📟 PagerDuty trigger: ${validatorName} ${network} streak ${state.consecutiveMisses}`)
    const ok = await sendPagerDutyAlert(routingKey, { ...base, type: 'missed', consecutiveMisses: state.consecutiveMisses }, dedupKey)
    if (ok) state.pagerdutyTriggered = true // on failure the next check retries
  } else if (state.pagerdutyTriggered && state.consecutiveMisses === 0) {
    console.log(`[Monadoring] 📟 PagerDuty resolve: ${validatorName} ${network}`)
    const ok = await sendPagerDutyAlert(routingKey, { ...base, type: 'recovered' }, dedupKey)
    if (ok) state.pagerdutyTriggered = false
  }
}

async function checkValidatorMissedBlocks(
  validatorId: string,
  network: 'mainnet' | 'testnet',
  validatorName: string
) {
  if (!cachedConfig) return

  try {
    const res = await fetch(`${VALIDATOR_API[network]}/validator/uptime/${encodeURIComponent(validatorId)}/history?limit=20`, {
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return

    const data = await res.json()
    if (!data?.success) return
    const history = validHistory(data.history)
    if (history.length === 0) return

    const key = `${validatorId}-${network}`
    const prevState = validatorBlockStates.get(key)
    const networkLabel = network.charAt(0).toUpperCase() + network.slice(1)
    const now = Date.now()
    const latest = history.reduce((a, b) => (b.round > a.round ? b : a))

    // First run, or a reset: take the newest event as the baseline, no alerts
    const resetDetected = prevState !== undefined && latest.round < prevState.lastRound - ROUND_RESET_GAP
    if (!prevState || resetDetected) {
      if (resetDetected) {
        console.warn(`[Monadoring] ${validatorName} ${networkLabel} rounds went back from ${prevState!.lastRound} to ${latest.round}; starting over`)
      }
      const emoji = latest.status === 'timeout' ? '🛑' : '🧊'
      const label = latest.status === 'timeout' ? 'Missed' : 'Finalized'
      console.log(`[Monadoring] ${emoji} ${validatorName} ${networkLabel} ~ ${label} round ${latest.round}`)
      validatorBlockStates.set(key, {
        lastRound: latest.round,
        lastStatus: latest.status,
        consecutiveMisses: latest.status === 'timeout' ? 1 : 0,
        alertedForMiss: false,
        roundAt: now,
        pagerdutyTriggered: prevState?.pagerdutyTriggered ?? false
      })
      return
    }

    // Every event newer than the last seen round, oldest first, within the
    // rate the chain can actually move
    const maxRound = prevState.lastRound + Math.ceil(((now - prevState.roundAt) / 1000 + 60) * MAX_ROUNDS_PER_SECOND)
    const newer = history.filter((e) => e.round > prevState.lastRound).sort((a, b) => a.round - b.round)
    const newEvents = newer.filter((e) => e.round <= maxRound)
    if (newEvents.length < newer.length) {
      console.warn(`[Monadoring] ${validatorName} ${networkLabel}: ignoring ${newer.length - newEvents.length} event(s) beyond round ${maxRound} (last seen ${prevState.lastRound})`)
    }

    const state: ValidatorBlockState = { ...prevState }
    const alerts: ValidatorAlert[] = []

    for (const ev of newEvents) {
      if (ev.status === 'timeout') {
        state.consecutiveMisses += 1
        state.lastRound = ev.round
        state.lastStatus = 'timeout'
        state.alertedForMiss = true

        console.log(`[Monadoring] 🛑 ${validatorName} ${networkLabel} ~ Missed round ${ev.round} (streak: ${state.consecutiveMisses})`)

        const payload: ValidatorAlert = {
          validator: validatorName,
          network,
          height: ev.height,
          round: ev.round,
          type: 'missed',
          consecutiveMisses: state.consecutiveMisses
        }
        // A run of misses in one check becomes one message carrying the streak
        if (alerts.length > 0 && alerts[alerts.length - 1].type === 'missed') {
          alerts[alerts.length - 1] = payload
        } else {
          alerts.push(payload)
        }
      } else {
        const hadMisses = state.consecutiveMisses > 0 && state.alertedForMiss
        const previousStreak = state.consecutiveMisses

        state.lastRound = ev.round
        state.lastStatus = 'finalized'
        state.consecutiveMisses = 0
        state.alertedForMiss = false

        if (hadMisses) {
          console.log(`[Monadoring] ✅ ${validatorName} ${networkLabel} ~ Recovered round ${ev.round} (streak was: ${previousStreak})`)
          alerts.push({
            validator: validatorName,
            network,
            height: ev.height,
            round: ev.round,
            type: 'recovered',
            previousStreak
          })
        } else {
          console.log(`[Monadoring] 🧊 ${validatorName} ${networkLabel} ~ Finalized round ${ev.round}`)
        }
      }
    }
    if (newEvents.length > 0) state.roundAt = now

    const toSend = alerts.slice(-MAX_ALERTS_PER_CHECK)
    if (toSend.length < alerts.length) {
      console.warn(`[Monadoring] ${validatorName} ${networkLabel}: ${alerts.length - toSend.length} older alert(s) in this check not sent, latest ${toSend.length} sent`)
    }
    for (const payload of toSend) await sendValidatorAlert(payload)

    await updatePagerDuty(validatorId, network, validatorName, state, (newEvents.length > 0 ? newEvents[newEvents.length - 1].height : latest.height))
    validatorBlockStates.set(key, state)
  } catch (err) {
    if (isTimeout(err)) return
    console.error(`[Monadoring] Missed block check error for ${validatorId}:`, err)
  }
}

// Check validator active/inactive set membership
async function checkValidatorStatus(
  validatorId: string,
  network: 'mainnet' | 'testnet',
  validatorName: string,
  currentEpoch: number | null
) {
  if (!cachedConfig) return

  const API = {
    mainnet: 'https://validator-api.huginn.tech/monad-api',
    testnet: 'https://validator-api-testnet.huginn.tech/monad-api'
  }

  try {
    const res = await fetch(`${API[network]}/validator/uptime/${validatorId}`, {
      signal: AbortSignal.timeout(15000)
    })

    if (!res.ok) return

    const data = await res.json()
    if (!data.success || !data.uptime) return

    const currentStatus = data.uptime.status

    if (currentStatus !== 'active' && currentStatus !== 'inactive') return

    const key = `${validatorId}-${network}`
    const prevStatus = validatorStatusStates.get(key)

    // Initialize on first run without alerting
    if (!prevStatus) {
      validatorStatusStates.set(key, currentStatus)
      return
    }

    if (prevStatus === currentStatus) return

    validatorStatusStates.set(key, currentStatus)

    const networkLabel = network.charAt(0).toUpperCase() + network.slice(1)
    const epochPart = currentEpoch !== null ? ` (Epoch ${currentEpoch})` : ''
    const emoji = currentStatus === 'active' ? '🟢' : '🔴'
    console.log(`[Monadoring] ${emoji} ${validatorName} ${networkLabel} ~ now in ${currentStatus} set${epochPart}`)

    const payload = {
      validator: validatorName,
      network,
      status: currentStatus as 'active' | 'inactive',
      epoch: currentEpoch ?? undefined
    }

    if (cachedConfig.telegram) {
      await sendTelegramStatusChange(cachedConfig.telegram.botToken, cachedConfig.telegram.chatId, payload)
    }
    if (cachedConfig.discord) {
      await sendDiscordStatusChange(cachedConfig.discord.webhookUrl, payload)
    }
    if (cachedConfig.slack) {
      await sendSlackStatusChange(cachedConfig.slack.webhookUrl, payload)
    }
  } catch (err) {
    if (isTimeout(err)) return
    console.error(`[Monadoring] Validator status check error for ${validatorId}:`, err)
  }
}

async function fetchEpoch(network: 'mainnet' | 'testnet'): Promise<number | null> {
  const API = {
    mainnet: 'https://validator-api.huginn.tech/monad-api',
    testnet: 'https://validator-api-testnet.huginn.tech/monad-api'
  }

  try {
    const res = await fetch(`${API[network]}/staking/epoch`, { signal: AbortSignal.timeout(15000) })

    if (!res.ok) return null

    const data = await res.json()
    if (typeof data?.epoch === 'number') return data.epoch
    if (typeof data?.data?.epoch === 'number') return data.data.epoch
    if (typeof data?.current_epoch === 'number') return data.current_epoch
    return null
  } catch {
    return null
  }
}

// Run missed block check for all validators
async function runMissedBlockCheck() {
  if (!cachedConfig) return

  const mainnetValidators = (process.env.MAINNET_VALIDATORS || '').split(',').map(s => s.trim()).filter(Boolean)
  const testnetValidators = (process.env.TESTNET_VALIDATORS || '').split(',').map(s => s.trim()).filter(Boolean)

  const mainnetEpoch = mainnetValidators.length > 0 ? await fetchEpoch('mainnet') : null
  const testnetEpoch = testnetValidators.length > 0 ? await fetchEpoch('testnet') : null

  // Check mainnet validators
  for (const validatorId of mainnetValidators) {
    const name = (await getValidatorName('mainnet', validatorId)) || validatorId
    await checkValidatorMissedBlocks(validatorId, 'mainnet', name)
    await checkValidatorStatus(validatorId, 'mainnet', name, mainnetEpoch)
  }

  // Check testnet validators
  for (const validatorId of testnetValidators) {
    const name = (await getValidatorName('testnet', validatorId)) || validatorId
    await checkValidatorMissedBlocks(validatorId, 'testnet', name)
    await checkValidatorStatus(validatorId, 'testnet', name, testnetEpoch)
  }
}

// Start missed block monitoring
function startMissedBlockMonitoring() {
  const hasValidators = process.env.MAINNET_VALIDATORS || process.env.TESTNET_VALIDATORS
  if (!hasValidators) {
    console.log('[Monadoring] No validators configured, skipping missed block monitoring')
    return
  }

  console.log('[Monadoring] Missed block monitoring enabled (30 sec interval)')

  // First check after 10 seconds
  setTimeout(() => {
    runExclusive('Missed block check', missedBlockCheckBusy, runMissedBlockCheck)
  }, 10 * 1000)

  // Run check every 30 seconds
  missedBlockCheckInterval = setInterval(() => {
    runExclusive('Missed block check', missedBlockCheckBusy, runMissedBlockCheck)
  }, 30 * 1000)
}

export async function register() {
  // Only run on server (not edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await sendStartupNotification()
    registerShutdownHandlers()
    startRpcHealthMonitoring()
    startMissedBlockMonitoring()
  }
}
