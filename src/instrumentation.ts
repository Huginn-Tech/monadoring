// Next.js Instrumentation - runs on server startup
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

import { sendLifecycleNotifications, sendRpcAlert, sendTelegramAlert, sendDiscordAlert } from '@/lib/alerts'

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

  const port = process.env.PORT || '3030'
  const dashboardUrl = `http://localhost:${port}`
  const validatorName = await getValidatorName()

  // Alert status for notification display
  const alertStatus = {
    telegram: !!telegram,
    discord: !!discord,
    pagerduty: !!process.env.PAGERDUTY_ROUTING_KEY
  }

  return { telegram, discord, validatorName, dashboardUrl, alertStatus }
}

async function sendStartupNotification() {
  const config = await getAlertConfig()
  cachedConfig = config // Cache for shutdown use

  if (!config.telegram && !config.discord) {
    console.log('[Monadoring] No alert services configured, skipping startup notification')
    return
  }

  console.log('[Monadoring] Sending startup notifications...')
  console.log('[Monadoring] Config:', {
    telegram: config.telegram ? 'configured' : 'not configured',
    discord: config.discord ? 'configured' : 'not configured'
  })

  try {
    const results = await sendLifecycleNotifications('startup', config)

    if (config.telegram) {
      console.log(`[Monadoring] Telegram: ${results.telegram ? 'sent' : 'FAILED'}`)
    }
    if (config.discord) {
      console.log(`[Monadoring] Discord: ${results.discord ? 'sent' : 'FAILED'}`)
    }
  } catch (error) {
    console.error('[Monadoring] Startup notification error:', error)
  }
}

async function sendShutdownNotification() {
  // Use cached config to avoid network calls during shutdown
  const config = cachedConfig

  if (!config || (!config.telegram && !config.discord)) {
    return
  }

  console.log('[Monadoring] Sending shutdown notifications...')
  const results = await sendLifecycleNotifications('shutdown', config)

  if (results.telegram) console.log('[Monadoring] Telegram shutdown notification sent')
  if (results.discord) console.log('[Monadoring] Discord shutdown notification sent')
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
    const timeout = setTimeout(() => controller.abort(), 10000)
    const res = await fetch(`${API[network]}/validator/uptime/${validatorId}/history?limit=5`, {
      signal: controller.signal
    })
    clearTimeout(timeout)

    if (!res.ok) return

    const data = await res.json()
    if (!data.success || !data.history || data.history.length === 0) return

    // Get most recent block
    const latestBlock = data.history[0]
    const key = `${validatorId}-${network}`
    const prevState = validatorBlockStates.get(key)

    // Initialize state if first time
    if (!prevState) {
      const emoji = latestBlock.status === 'timeout' ? '🛑' : '🧊'
      const label = latestBlock.status === 'timeout' ? 'Missed' : 'Finalized'
      const networkLabel = network.charAt(0).toUpperCase() + network.slice(1)
      console.log(`[Monadoring] ${emoji} ${validatorName} ${networkLabel} ~ ${label} round ${latestBlock.round}`)
      validatorBlockStates.set(key, {
        lastRound: latestBlock.round,
        lastStatus: latestBlock.status,
        consecutiveMisses: latestBlock.status === 'timeout' ? 1 : 0,
        alertedForMiss: false
      })
      return
    }

    // Check if this is a new block (different round)
    if (latestBlock.round === prevState.lastRound) {
      return // Same block, no update
    }

    // New block detected - log every round
    const networkLabel = network.charAt(0).toUpperCase() + network.slice(1)
    if (latestBlock.status === 'timeout') {
      // Missed block!
      const newMisses = prevState.consecutiveMisses + 1
      validatorBlockStates.set(key, {
        lastRound: latestBlock.round,
        lastStatus: 'timeout',
        consecutiveMisses: newMisses,
        alertedForMiss: true
      })

      console.log(`[Monadoring] 🛑 ${validatorName} ${networkLabel} ~ Missed round ${latestBlock.round} (streak: ${newMisses})`)

      // Send alerts
      const payload = {
        validator: validatorName,
        network,
        height: latestBlock.height,
        round: latestBlock.round,
        type: 'missed' as const,
        consecutiveMisses: newMisses
      }

      if (cachedConfig.telegram) {
        await sendTelegramAlert(cachedConfig.telegram.botToken, cachedConfig.telegram.chatId, payload)
      }
      if (cachedConfig.discord) {
        await sendDiscordAlert(cachedConfig.discord.webhookUrl, payload)
      }
    } else {
      // Finalized block
      const hadMisses = prevState.consecutiveMisses > 0 && prevState.alertedForMiss

      validatorBlockStates.set(key, {
        lastRound: latestBlock.round,
        lastStatus: 'finalized',
        consecutiveMisses: 0,
        alertedForMiss: false
      })

      if (hadMisses) {
        const previousStreak = prevState.consecutiveMisses
        console.log(`[Monadoring] ✅ ${validatorName} ${networkLabel} ~ Recovered round ${latestBlock.round} (streak was: ${previousStreak})`)
      } else {
        console.log(`[Monadoring] 🧊 ${validatorName} ${networkLabel} ~ Finalized round ${latestBlock.round}`)
      }

      // Send recovery alert if we had misses before
      if (hadMisses) {
        const previousStreak = prevState.consecutiveMisses

        const payload = {
          validator: validatorName,
          network,
          height: latestBlock.height,
          round: latestBlock.round,
          type: 'recovered' as const,
          previousStreak
        }

        if (cachedConfig.telegram) {
          await sendTelegramAlert(cachedConfig.telegram.botToken, cachedConfig.telegram.chatId, payload)
        }
        if (cachedConfig.discord) {
          await sendDiscordAlert(cachedConfig.discord.webhookUrl, payload)
        }
      }
    }
  } catch (err) {
    console.error(`[Monadoring] Missed block check error for ${validatorId}:`, err)
  }
}

// Run missed block check for all validators
async function runMissedBlockCheck() {
  if (!cachedConfig) return

  const mainnetValidators = (process.env.MAINNET_VALIDATORS || '').split(',').map(s => s.trim()).filter(Boolean)
  const testnetValidators = (process.env.TESTNET_VALIDATORS || '').split(',').map(s => s.trim()).filter(Boolean)

  // Check mainnet validators
  for (const validatorId of mainnetValidators) {
    await checkValidatorMissedBlocks(validatorId, 'mainnet', cachedConfig.validatorName || validatorId)
  }

  // Check testnet validators
  for (const validatorId of testnetValidators) {
    await checkValidatorMissedBlocks(validatorId, 'testnet', cachedConfig.validatorName || validatorId)
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
