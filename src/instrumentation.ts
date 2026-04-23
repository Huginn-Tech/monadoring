// Next.js Instrumentation - runs on server startup
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

import { sendLifecycleNotifications, sendRpcAlert, sendTelegramAlert, sendDiscordAlert, sendSlackAlert, sendTelegramStatusChange, sendDiscordStatusChange, sendSlackStatusChange } from '@/lib/alerts'

let shutdownHandlersRegistered = false
let missedBlockCheckInterval: NodeJS.Timeout | null = null

// Track last known block for missed block detection
interface ValidatorBlockState {
  lastRound: number
  lastStatus: 'finalized' | 'timeout'
  consecutiveMisses: number
  alertedForMiss: boolean
}
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

// Track last known block heights from Uptime API to detect chain progress
let lastKnownHeight: { mainnet: number; testnet: number } = { mainnet: 0, testnet: 0 }

async function getValidatorName(): Promise<string | undefined> {
  const mainnetValidators = process.env.MAINNET_VALIDATORS || ''
  const testnetValidators = process.env.TESTNET_VALIDATORS || ''

  const firstMainnetId = mainnetValidators.split(',')[0]?.trim()
  const firstTestnetId = testnetValidators.split(',')[0]?.trim()

  // Try to fetch validator name from API
  const API = {
    mainnet: 'https://validator-api.huginn.tech/monad-api',
    testnet: 'https://validator-api-testnet.huginn.tech/monad-api'
  }

  try {
    if (firstMainnetId) {
      const res = await fetch(`${API.mainnet}/validator/uptime/${firstMainnetId}/history?limit=1`)
      const data = await res.json()
      if (data.success && data.validator_name) {
        return data.validator_name
      }
    }
    if (firstTestnetId) {
      const res = await fetch(`${API.testnet}/validator/uptime/${firstTestnetId}/history?limit=1`)
      const data = await res.json()
      if (data.success && data.validator_name) {
        return data.validator_name
      }
    }
  } catch (error) {
    console.error('[Monadoring] Failed to fetch validator name:', error)
  }

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
  const validatorName = await getValidatorName()

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
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(`${API[network]}/validator/uptime/${firstValidatorId}`, {
      signal: controller.signal
    })
    clearTimeout(timeout)

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

// Check RPC health and return block height (0 = offline/error)
async function checkRpcHealth(url: string): Promise<number> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}',
      signal: controller.signal
    })
    clearTimeout(timeout)
    const data = await res.json()
    return data.result ? parseInt(data.result, 16) : 0
  } catch {
    return 0
  }
}

// Check if RPC is healthy based on height progression
function isRpcHealthy(url: string, currentHeight: number): boolean {
  if (currentHeight === 0) return false // No response

  const prev = rpcHeights.get(url)
  if (!prev) {
    // First check - just record height
    rpcHeights.set(url, { height: currentHeight, staleCount: 0 })
    return true
  }

  if (currentHeight > prev.height) {
    // Height increased - healthy
    rpcHeights.set(url, { height: currentHeight, staleCount: 0 })
    return true
  } else {
    // Height stale - increment counter
    const newStaleCount = prev.staleCount + 1
    rpcHeights.set(url, { height: currentHeight, staleCount: newStaleCount })
    // Consider unhealthy after 2 consecutive stale checks (2 minutes)
    return newStaleCount < 2
  }
}

// Run RPC health check - only for all-offline detection
async function runRpcHealthCheck() {
  if (!cachedConfig) return

  const mainnetRpcs = (process.env.MAINNET_RPCS || '').split(',').map(s => s.trim()).filter(Boolean)
  const testnetRpcs = (process.env.TESTNET_RPCS || '').split(',').map(s => s.trim()).filter(Boolean)

  // Check Mainnet RPCs - count healthy ones
  let mainnetHealthy = 0
  for (const url of mainnetRpcs) {
    const height = await checkRpcHealth(url)
    if (isRpcHealthy(url, height)) mainnetHealthy++
  }

  // Check Mainnet all-offline state
  if (mainnetHealthy === 0 && mainnetRpcs.length > 0) {
    if (!allOfflineState.mainnet.isOffline) {
      allOfflineState.mainnet = { isOffline: true, since: new Date(), alertSent: false }
    }

    const downtime = allOfflineState.mainnet.since
      ? Math.floor((Date.now() - allOfflineState.mainnet.since.getTime()) / 1000 / 60)
      : 0

    if (downtime >= 3 && !allOfflineState.mainnet.alertSent) {
      const chainProgressing = await checkChainProgress('mainnet')
      console.log(`[Monadoring] All Mainnet RPCs offline for ${downtime} minutes (chain progressing: ${chainProgressing})`)
      await sendRpcAlert(cachedConfig, {
        type: 'all_offline',
        rpcUrl: mainnetRpcs.join(', '),
        network: 'mainnet',
        isPrimary: true,
        downtime: `${downtime} minutes`,
        chainProgressing
      })
      allOfflineState.mainnet.alertSent = true
    }
  } else if (mainnetHealthy > 0) {
    allOfflineState.mainnet = { isOffline: false, since: null, alertSent: false }
  }

  // Check Testnet RPCs - count healthy ones
  let testnetHealthy = 0
  for (const url of testnetRpcs) {
    const height = await checkRpcHealth(url)
    if (isRpcHealthy(url, height)) testnetHealthy++
  }

  // Check Testnet all-offline state
  if (testnetHealthy === 0 && testnetRpcs.length > 0) {
    if (!allOfflineState.testnet.isOffline) {
      allOfflineState.testnet = { isOffline: true, since: new Date(), alertSent: false }
    }

    const downtime = allOfflineState.testnet.since
      ? Math.floor((Date.now() - allOfflineState.testnet.since.getTime()) / 1000 / 60)
      : 0

    if (downtime >= 3 && !allOfflineState.testnet.alertSent) {
      const chainProgressing = await checkChainProgress('testnet')
      console.log(`[Monadoring] All Testnet RPCs offline for ${downtime} minutes (chain progressing: ${chainProgressing})`)
      await sendRpcAlert(cachedConfig, {
        type: 'all_offline',
        rpcUrl: testnetRpcs.join(', '),
        network: 'testnet',
        isPrimary: true,
        downtime: `${downtime} minutes`,
        chainProgressing
      })
      allOfflineState.testnet.alertSent = true
    }
  } else if (testnetHealthy > 0) {
    allOfflineState.testnet = { isOffline: false, since: null, alertSent: false }
  }
}

// Start RPC health monitoring (only for all-offline detection)
function startRpcHealthMonitoring() {
  const rpcAlerts = (process.env.RPC_ALERTS || '').toLowerCase()
  if (rpcAlerts !== 'on') {
    console.log('[Monadoring] RPC alerts disabled (set RPC_ALERTS=on to enable)')
    return
  }

  console.log('[Monadoring] RPC health monitoring enabled (1 min interval, all-offline alerts only)')

  // First check after 30 seconds
  setTimeout(() => {
    runRpcHealthCheck().catch(err => {
      console.error('[Monadoring] RPC health check error:', err)
    })
  }, 30 * 1000) // 30 seconds

  // Run health check every 1 minute
  rpcHealthCheckInterval = setInterval(() => {
    runRpcHealthCheck().catch(err => {
      console.error('[Monadoring] RPC health check error:', err)
    })
  }, 60 * 1000) // 1 minute
}

// Check validator for missed blocks
async function checkValidatorMissedBlocks(
  validatorId: string,
  network: 'mainnet' | 'testnet',
  validatorName: string
) {
  if (!cachedConfig) return

  const API = {
    mainnet: 'https://validator-api.huginn.tech/monad-api',
    testnet: 'https://validator-api-testnet.huginn.tech/monad-api'
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const res = await fetch(`${API[network]}/validator/uptime/${validatorId}/history?limit=20`, {
      signal: controller.signal
    })
    clearTimeout(timeout)

    if (!res.ok) return

    const data = await res.json()
    if (!data.success || !data.history || data.history.length === 0) return

    const key = `${validatorId}-${network}`
    const prevState = validatorBlockStates.get(key)
    const networkLabel = network.charAt(0).toUpperCase() + network.slice(1)

    // Initialize state on first run without alerting on backlog
    if (!prevState) {
      const latestBlock = data.history[0]
      const emoji = latestBlock.status === 'timeout' ? '🛑' : '🧊'
      const label = latestBlock.status === 'timeout' ? 'Missed' : 'Finalized'
      console.log(`[Monadoring] ${emoji} ${validatorName} ${networkLabel} ~ ${label} round ${latestBlock.round}`)
      validatorBlockStates.set(key, {
        lastRound: latestBlock.round,
        lastStatus: latestBlock.status,
        consecutiveMisses: latestBlock.status === 'timeout' ? 1 : 0,
        alertedForMiss: false
      })
      return
    }

    // Collect every event newer than last seen round, oldest first
    const newEvents = (data.history as Array<{ round: number; height: number | null; status: 'finalized' | 'timeout' }>)
      .filter((e) => e.round > prevState.lastRound)
      .sort((a, b) => a.round - b.round)

    if (newEvents.length === 0) return

    const state = { ...prevState }

    for (const ev of newEvents) {
      if (ev.status === 'timeout') {
        state.consecutiveMisses += 1
        state.lastRound = ev.round
        state.lastStatus = 'timeout'
        state.alertedForMiss = true

        console.log(`[Monadoring] 🛑 ${validatorName} ${networkLabel} ~ Missed round ${ev.round} (streak: ${state.consecutiveMisses})`)

        const payload = {
          validator: validatorName,
          network,
          height: ev.height,
          round: ev.round,
          type: 'missed' as const,
          consecutiveMisses: state.consecutiveMisses
        }

        if (cachedConfig.telegram) {
          await sendTelegramAlert(cachedConfig.telegram.botToken, cachedConfig.telegram.chatId, payload)
        }
        if (cachedConfig.discord) {
          await sendDiscordAlert(cachedConfig.discord.webhookUrl, payload)
        }
        if (cachedConfig.slack) {
          await sendSlackAlert(cachedConfig.slack.webhookUrl, payload)
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

          const payload = {
            validator: validatorName,
            network,
            height: ev.height,
            round: ev.round,
            type: 'recovered' as const,
            previousStreak
          }

          if (cachedConfig.telegram) {
            await sendTelegramAlert(cachedConfig.telegram.botToken, cachedConfig.telegram.chatId, payload)
          }
          if (cachedConfig.discord) {
            await sendDiscordAlert(cachedConfig.discord.webhookUrl, payload)
          }
          if (cachedConfig.slack) {
            await sendSlackAlert(cachedConfig.slack.webhookUrl, payload)
          }
        } else {
          console.log(`[Monadoring] 🧊 ${validatorName} ${networkLabel} ~ Finalized round ${ev.round}`)
        }
      }
    }

    validatorBlockStates.set(key, state)
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return
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
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const res = await fetch(`${API[network]}/validator/uptime/${validatorId}`, {
      signal: controller.signal
    })
    clearTimeout(timeout)

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
    if ((err as Error)?.name === 'AbortError') return
    console.error(`[Monadoring] Validator status check error for ${validatorId}:`, err)
  }
}

async function fetchEpoch(network: 'mainnet' | 'testnet'): Promise<number | null> {
  const API = {
    mainnet: 'https://validator-api.huginn.tech/monad-api',
    testnet: 'https://validator-api-testnet.huginn.tech/monad-api'
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const res = await fetch(`${API[network]}/staking/epoch`, { signal: controller.signal })
    clearTimeout(timeout)

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
    const name = cachedConfig.validatorName || validatorId
    await checkValidatorMissedBlocks(validatorId, 'mainnet', name)
    await checkValidatorStatus(validatorId, 'mainnet', name, mainnetEpoch)
  }

  // Check testnet validators
  for (const validatorId of testnetValidators) {
    const name = cachedConfig.validatorName || validatorId
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
    runMissedBlockCheck().catch(err => {
      console.error('[Monadoring] Missed block check error:', err)
    })
  }, 10 * 1000)

  // Run check every 30 seconds
  missedBlockCheckInterval = setInterval(() => {
    runMissedBlockCheck().catch(err => {
      console.error('[Monadoring] Missed block check error:', err)
    })
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
