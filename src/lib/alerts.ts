// Alert notifications for Telegram, Discord, Slack, and PagerDuty

interface AlertPayload {
  validator: string
  network: 'mainnet' | 'testnet'
  height: number | null
  round: number
  type: 'missed' | 'recovered'
  consecutiveMisses?: number
  previousStreak?: number
}

type LifecycleEvent = 'startup' | 'shutdown'

interface AlertStatus {
  telegram: boolean
  discord: boolean
  slack: boolean
  pagerduty: boolean
}

interface LifecyclePayload {
  event: LifecycleEvent
  timestamp: Date
  validatorName?: string
  dashboardUrl?: string
  alertStatus?: AlertStatus
}

interface RpcAlertPayload {
  type: 'offline' | 'online' | 'failover' | 'all_offline'
  rpcUrl: string
  network: 'mainnet' | 'testnet'
  isPrimary: boolean
  failoverFrom?: string
  failoverTo?: string
  downtime?: string
  chainProgressing?: boolean // true if uptime API shows new blocks
}

interface StatusChangePayload {
  validator: string
  network: 'mainnet' | 'testnet'
  status: 'active' | 'inactive'
  epoch?: number
}

// RPC Telegram Alert
export async function sendTelegramRpcAlert(
  botToken: string,
  chatId: string,
  payload: RpcAlertPayload
): Promise<boolean> {
  if (!botToken || !chatId) return false

  const network = payload.network.toUpperCase()
  let message = ''

  if (payload.type === 'all_offline') {
    const causes = payload.chainProgressing
      ? `⚠️ *Possible causes:*\n• Rate limiting on RPC endpoints\n• Incorrect RPC URLs in config`
      : `⚠️ *Possible causes:*\n• Rate limiting on RPC endpoints\n• Incorrect RPC URLs in config\n• Network/chain may be halted`
    message = `🚨 *ALL RPCs OFFLINE*\n\n*Network:* ${network}\n*Downtime:* ${payload.downtime || 'Unknown'}\n\n${causes}\n\n_Check your RPC configuration or network status_`
  } else if (payload.type === 'failover') {
    message = `⚠️ *RPC Failover*\n\n*Network:* ${network}\n*From:* \`${payload.failoverFrom}\`\n*To:* \`${payload.failoverTo}\`\n\n_Primary RPC is offline, switched to secondary_`
  } else {
    const emoji = payload.type === 'offline' ? '🔴' : '🟢'
    const status = payload.type === 'offline' ? 'OFFLINE' : 'ONLINE'
    const rpcType = payload.isPrimary ? 'Primary' : 'Secondary'
    message = `${emoji} *RPC ${status}*\n\n*Network:* ${network}\n*Type:* ${rpcType}\n*URL:* \`${payload.rpcUrl}\`\n\n_Monadoring RPC Alert_`
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown'
      })
    })
    return res.ok
  } catch (error) {
    console.error('Telegram RPC alert failed:', error)
    return false
  }
}

// RPC Discord Alert
export async function sendDiscordRpcAlert(
  webhookUrl: string,
  payload: RpcAlertPayload
): Promise<boolean> {
  if (!webhookUrl) return false

  const network = payload.network.toUpperCase()
  let description = ''
  let color = 0

  if (payload.type === 'all_offline') {
    color = 0xdc2626 // red-600
    const causes = payload.chainProgressing
      ? `⚠️ **Possible causes:**\n• Rate limiting on RPC endpoints\n• Incorrect RPC URLs in config`
      : `⚠️ **Possible causes:**\n• Rate limiting on RPC endpoints\n• Incorrect RPC URLs in config\n• Network/chain may be halted`
    description = `🚨 **ALL RPCs OFFLINE**\n\n**Network:** ${network}\n**Downtime:** ${payload.downtime || 'Unknown'}\n\n${causes}\n\n_Check your RPC configuration or network status_`
  } else if (payload.type === 'failover') {
    color = 0xf59e0b // amber
    description = `⚠️ **RPC Failover**\n\n**Network:** ${network}\n**From:** \`${payload.failoverFrom}\`\n**To:** \`${payload.failoverTo}\`\n\n_Primary RPC is offline, switched to secondary_`
  } else {
    const emoji = payload.type === 'offline' ? '🔴' : '🟢'
    const status = payload.type === 'offline' ? 'OFFLINE' : 'ONLINE'
    const rpcType = payload.isPrimary ? 'Primary' : 'Secondary'
    color = payload.type === 'offline' ? 0xef4444 : 0x22c55e
    description = `${emoji} **RPC ${status}**\n\n**Network:** ${network}\n**Type:** ${rpcType}\n**URL:** \`${payload.rpcUrl}\``
  }

  const embed = {
    embeds: [{
      description,
      color,
      footer: { text: 'Monadoring RPC Alert' },
      timestamp: new Date().toISOString()
    }]
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(embed)
    })
    return res.ok
  } catch (error) {
    console.error('Discord RPC alert failed:', error)
    return false
  }
}

// RPC Slack Alert
export async function sendSlackRpcAlert(
  webhookUrl: string,
  payload: RpcAlertPayload
): Promise<boolean> {
  if (!webhookUrl) return false

  const network = payload.network.toUpperCase()
  let title = ''
  let fields: Array<{ type: 'mrkdwn'; text: string }> = []
  let color = ''
  let context = ''

  if (payload.type === 'all_offline') {
    color = '#dc2626' // red-600
    title = '🚨 *ALL RPCs OFFLINE*'
    fields = [
      { type: 'mrkdwn', text: `*Network*\n${network}` },
      { type: 'mrkdwn', text: `*Downtime*\n${payload.downtime || 'Unknown'}` }
    ]
    const causes = payload.chainProgressing
      ? '⚠️ *Possible causes:*\n• Rate limiting on RPC endpoints\n• Incorrect RPC URLs in config'
      : '⚠️ *Possible causes:*\n• Rate limiting on RPC endpoints\n• Incorrect RPC URLs in config\n• Network/chain may be halted'
    context = `${causes}\n_Check your RPC configuration or network status_`
  } else if (payload.type === 'failover') {
    color = '#f59e0b' // amber
    title = '⚠️ *RPC Failover*'
    fields = [
      { type: 'mrkdwn', text: `*Network*\n${network}` },
      { type: 'mrkdwn', text: `*From*\n\`${payload.failoverFrom}\`` },
      { type: 'mrkdwn', text: `*To*\n\`${payload.failoverTo}\`` }
    ]
    context = '_Primary RPC is offline, switched to secondary_'
  } else {
    const emoji = payload.type === 'offline' ? '🔴' : '🟢'
    const status = payload.type === 'offline' ? 'OFFLINE' : 'ONLINE'
    const rpcType = payload.isPrimary ? 'Primary' : 'Secondary'
    color = payload.type === 'offline' ? '#ef4444' : '#22c55e'
    title = `${emoji} *RPC ${status}*`
    fields = [
      { type: 'mrkdwn', text: `*Network*\n${network}` },
      { type: 'mrkdwn', text: `*Type*\n${rpcType}` },
      { type: 'mrkdwn', text: `*URL*\n\`${payload.rpcUrl}\`` }
    ]
  }

  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: title } },
    { type: 'section', fields }
  ]

  if (context) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: context }]
    })
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Monadoring RPC Alert' }]
  })

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachments: [{ color, blocks }]
      })
    })
    return res.ok
  } catch (error) {
    console.error('Slack RPC alert failed:', error)
    return false
  }
}

// Send RPC alert to all configured services
export async function sendRpcAlert(
  config: {
    telegram?: { botToken: string; chatId: string }
    discord?: { webhookUrl: string }
    slack?: { webhookUrl: string }
  },
  payload: RpcAlertPayload
): Promise<{ telegram: boolean; discord: boolean; slack: boolean }> {
  const results = await Promise.all([
    config.telegram
      ? sendTelegramRpcAlert(config.telegram.botToken, config.telegram.chatId, payload)
      : Promise.resolve(false),
    config.discord
      ? sendDiscordRpcAlert(config.discord.webhookUrl, payload)
      : Promise.resolve(false),
    config.slack
      ? sendSlackRpcAlert(config.slack.webhookUrl, payload)
      : Promise.resolve(false)
  ])

  return {
    telegram: results[0],
    discord: results[1],
    slack: results[2]
  }
}

// Lifecycle Telegram Notification
export async function sendTelegramLifecycle(
  botToken: string,
  chatId: string,
  payload: LifecyclePayload
): Promise<boolean> {
  if (!botToken || !chatId) return false

  const isStartup = payload.event === 'startup'
  const validatorPart = payload.validatorName ? ` (${payload.validatorName})` : ''
  const dashboardPart = payload.dashboardUrl ? `\n📊 Dashboard: ${payload.dashboardUrl}` : ''

  let alertStatusPart = ''
  if (isStartup && payload.alertStatus) {
    const s = payload.alertStatus
    alertStatusPart = `\n\n*Alerts:*\nTelegram: ${s.telegram ? '✅' : '❌'} | Discord: ${s.discord ? '✅' : '❌'} | Slack: ${s.slack ? '✅' : '❌'} | PagerDuty: ${s.pagerduty ? '✅' : '❌'}`
  }

  const message = isStartup
    ? `🟢 *Monadoring* is now *online*${validatorPart}${dashboardPart}\n_Observing validator uptime_${alertStatusPart}`
    : `🔴 *Monadoring* is now *offline*${validatorPart}`

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown'
      })
    })
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}))
      console.error('Telegram API error:', res.status, errorData)
    }
    return res.ok
  } catch (error) {
    console.error('Telegram lifecycle alert failed:', error)
    return false
  }
}

// Lifecycle Discord Notification
export async function sendDiscordLifecycle(
  webhookUrl: string,
  payload: LifecyclePayload
): Promise<boolean> {
  if (!webhookUrl) return false

  const isStartup = payload.event === 'startup'
  const color = isStartup ? 0x22c55e : 0xef4444
  const validatorPart = payload.validatorName ? ` (${payload.validatorName})` : ''
  const description = isStartup
    ? `🟢 Monadoring is now **online**${validatorPart}\n${payload.dashboardUrl ? `📊 [Dashboard](${payload.dashboardUrl})\n` : ''}_Observing validator uptime_`
    : `🔴 Monadoring is now **offline**${validatorPart}`

  const embed = {
    embeds: [{
      description,
      color,
      footer: { text: 'Monadoring' },
      timestamp: payload.timestamp.toISOString()
    }]
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(embed)
    })
    if (!res.ok) {
      const errorData = await res.text().catch(() => '')
      console.error('Discord webhook error:', res.status, errorData)
    }
    return res.ok
  } catch (error) {
    console.error('Discord lifecycle alert failed:', error)
    return false
  }
}

// Lifecycle Slack Notification
export async function sendSlackLifecycle(
  webhookUrl: string,
  payload: LifecyclePayload
): Promise<boolean> {
  if (!webhookUrl) return false

  const isStartup = payload.event === 'startup'
  const color = isStartup ? '#22c55e' : '#ef4444'
  const validatorPart = payload.validatorName ? ` (${payload.validatorName})` : ''

  const headline = isStartup
    ? `🟢 Monadoring is now *online*${validatorPart}`
    : `🔴 Monadoring is now *offline*${validatorPart}`

  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: headline } }
  ]

  if (isStartup) {
    const detailLines: string[] = []
    if (payload.dashboardUrl) {
      detailLines.push(`📊 Dashboard: <${payload.dashboardUrl}|${payload.dashboardUrl}>`)
    }
    detailLines.push('_Observing validator uptime_')

    if (detailLines.length > 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: detailLines.join('\n') }
      })
    }

    if (payload.alertStatus) {
      const s = payload.alertStatus
      const statusLine = `*Alerts*\nTelegram: ${s.telegram ? '✅' : '❌'}  |  Discord: ${s.discord ? '✅' : '❌'}  |  Slack: ${s.slack ? '✅' : '❌'}  |  PagerDuty: ${s.pagerduty ? '✅' : '❌'}`
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: statusLine }
      })
    }
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Monadoring' }]
  })

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachments: [{ color, blocks }]
      })
    })
    if (!res.ok) {
      const errorData = await res.text().catch(() => '')
      console.error('Slack webhook error:', res.status, errorData)
    }
    return res.ok
  } catch (error) {
    console.error('Slack lifecycle alert failed:', error)
    return false
  }
}

// Send lifecycle notifications to all configured services
export async function sendLifecycleNotifications(
  event: LifecycleEvent,
  config: {
    telegram?: { botToken: string; chatId: string }
    discord?: { webhookUrl: string }
    slack?: { webhookUrl: string }
    validatorName?: string
    dashboardUrl?: string
    alertStatus?: AlertStatus
  }
): Promise<{ telegram: boolean; discord: boolean; slack: boolean }> {
  const payload: LifecyclePayload = {
    event,
    timestamp: new Date(),
    validatorName: config.validatorName,
    dashboardUrl: config.dashboardUrl,
    alertStatus: config.alertStatus
  }

  const results = await Promise.all([
    config.telegram
      ? sendTelegramLifecycle(config.telegram.botToken, config.telegram.chatId, payload)
      : Promise.resolve(false),
    config.discord
      ? sendDiscordLifecycle(config.discord.webhookUrl, payload)
      : Promise.resolve(false),
    config.slack
      ? sendSlackLifecycle(config.slack.webhookUrl, payload)
      : Promise.resolve(false)
  ])

  return {
    telegram: results[0],
    discord: results[1],
    slack: results[2]
  }
}

// Validator set status change (active <-> inactive) - Telegram
export async function sendTelegramStatusChange(
  botToken: string,
  chatId: string,
  payload: StatusChangePayload
): Promise<boolean> {
  if (!botToken || !chatId) return false

  const network = payload.network.charAt(0).toUpperCase() + payload.network.slice(1)
  const emoji = payload.status === 'active' ? '🟢' : '🔴'
  const epochPart = payload.epoch !== undefined ? ` (Epoch ${payload.epoch})` : ''

  const message = `${emoji} ${network} validator *${payload.validator}* now in *${payload.status}* set${epochPart}`

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown'
      })
    })
    return res.ok
  } catch (error) {
    console.error('Telegram status change alert failed:', error)
    return false
  }
}

// Validator set status change (active <-> inactive) - Discord
export async function sendDiscordStatusChange(
  webhookUrl: string,
  payload: StatusChangePayload
): Promise<boolean> {
  if (!webhookUrl) return false

  const network = payload.network.charAt(0).toUpperCase() + payload.network.slice(1)
  const emoji = payload.status === 'active' ? '🟢' : '🔴'
  const color = payload.status === 'active' ? 0x22c55e : 0xef4444
  const epochPart = payload.epoch !== undefined ? ` (Epoch ${payload.epoch})` : ''

  const description = `${emoji} ${network} validator **${payload.validator}** now in **${payload.status}** set${epochPart}`

  const embed = {
    embeds: [{
      description,
      color,
      footer: { text: 'Monadoring' },
      timestamp: new Date().toISOString()
    }]
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(embed)
    })
    return res.ok
  } catch (error) {
    console.error('Discord status change alert failed:', error)
    return false
  }
}

// Validator set status change (active <-> inactive) - Slack
export async function sendSlackStatusChange(
  webhookUrl: string,
  payload: StatusChangePayload
): Promise<boolean> {
  if (!webhookUrl) return false

  const network = payload.network.charAt(0).toUpperCase() + payload.network.slice(1)
  const emoji = payload.status === 'active' ? '🟢' : '🔴'
  const color = payload.status === 'active' ? '#22c55e' : '#ef4444'
  const epochPart = payload.epoch !== undefined ? ` (Epoch ${payload.epoch})` : ''

  const text = `${emoji} ${network} validator *${payload.validator}* now in *${payload.status}* set${epochPart}`

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachments: [{
          color,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text } },
            { type: 'context', elements: [{ type: 'mrkdwn', text: 'Monadoring' }] }
          ]
        }]
      })
    })
    return res.ok
  } catch (error) {
    console.error('Slack status change alert failed:', error)
    return false
  }
}

// Telegram Alert
export async function sendTelegramAlert(
  botToken: string,
  chatId: string,
  payload: AlertPayload
): Promise<boolean> {
  if (!botToken || !chatId) return false

  const network = payload.network.charAt(0).toUpperCase() + payload.network.slice(1)

  let message: string
  if (payload.type === 'missed') {
    message = `⛔ *Timeout detected* (#${payload.consecutiveMisses || 1})
• Round: \`${payload.round.toLocaleString()}\`
• Validator: ${payload.validator}
• Network: ${network}`
  } else {
    const streakLine = payload.previousStreak
      ? `\n• Previous timeout streak: ${payload.previousStreak}`
      : ''
    message = `✅ *Recovered*
• Finalized on round \`${payload.round.toLocaleString()}\`
• Validator: ${payload.validator}
• Network: ${network}${streakLine}`
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown'
      })
    })
    return res.ok
  } catch (error) {
    console.error('Telegram alert failed:', error)
    return false
  }
}

// Discord Alert
export async function sendDiscordAlert(
  webhookUrl: string,
  payload: AlertPayload
): Promise<boolean> {
  if (!webhookUrl) return false

  const network = payload.network.charAt(0).toUpperCase() + payload.network.slice(1)
  const isMissed = payload.type === 'missed'
  const color = isMissed ? 0xef4444 : 0x22c55e
  const title = isMissed
    ? `⛔ Timeout detected (#${payload.consecutiveMisses || 1})`
    : '✅ Recovered'

  const fields = [
    { name: 'Round', value: `\`${payload.round.toLocaleString()}\``, inline: true },
    { name: 'Validator', value: payload.validator, inline: true },
    { name: 'Network', value: network, inline: true },
    ...(!isMissed && payload.previousStreak ? [{
      name: 'Previous Streak',
      value: payload.previousStreak.toString(),
      inline: true
    }] : [])
  ]

  const embed = {
    embeds: [{
      title,
      color,
      fields,
      footer: { text: 'Monadoring' },
      timestamp: new Date().toISOString()
    }]
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(embed)
    })
    return res.ok
  } catch (error) {
    console.error('Discord alert failed:', error)
    return false
  }
}

// Slack Alert
export async function sendSlackAlert(
  webhookUrl: string,
  payload: AlertPayload
): Promise<boolean> {
  if (!webhookUrl) return false

  const network = payload.network.charAt(0).toUpperCase() + payload.network.slice(1)
  const isMissed = payload.type === 'missed'
  const color = isMissed ? '#ef4444' : '#22c55e'
  const title = isMissed
    ? `⛔ *Timeout detected* (#${payload.consecutiveMisses || 1})`
    : '✅ *Recovered*'

  const fields: Array<{ type: 'mrkdwn'; text: string }> = [
    { type: 'mrkdwn', text: `*Round*\n\`${payload.round.toLocaleString()}\`` },
    { type: 'mrkdwn', text: `*Validator*\n${payload.validator}` },
    { type: 'mrkdwn', text: `*Network*\n${network}` }
  ]

  if (!isMissed && payload.previousStreak) {
    fields.push({
      type: 'mrkdwn',
      text: `*Previous Streak*\n${payload.previousStreak}`
    })
  }

  const body = {
    attachments: [{
      color,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: title } },
        { type: 'section', fields },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'Monadoring' }]
        }
      ]
    }]
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return res.ok
  } catch (error) {
    console.error('Slack alert failed:', error)
    return false
  }
}

// PagerDuty Alert
export async function sendPagerDutyAlert(
  routingKey: string,
  payload: AlertPayload
): Promise<boolean> {
  if (!routingKey) return false

  const severity = payload.type === 'missed' ? 'error' : 'info'
  const action = payload.type === 'missed' ? 'trigger' : 'resolve'

  const event = {
    routing_key: routingKey,
    event_action: action,
    dedup_key: `monadoring-${payload.validator}-${payload.network}`,
    payload: {
      summary: `${payload.type === 'missed' ? 'Missed block' : 'Recovered'}: ${payload.validator} on ${payload.network}`,
      severity,
      source: 'Monadoring',
      custom_details: {
        validator: payload.validator,
        network: payload.network,
        height: payload.height,
        round: payload.round,
        consecutive_misses: payload.consecutiveMisses
      }
    }
  }

  try {
    const res = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    })
    return res.ok
  } catch (error) {
    console.error('PagerDuty alert failed:', error)
    return false
  }
}

// Alert Manager
interface AlertManagerConfig {
  telegram?: { botToken: string; chatId: string }
  discord?: { webhookUrl: string }
  slack?: { webhookUrl: string }
  pagerduty?: { routingKey: string; threshold: number }
}

export class AlertManager {
  private config: AlertManagerConfig
  private consecutiveMisses: Map<string, number> = new Map()
  private pagerdutyTriggered: Map<string, boolean> = new Map()

  constructor(config: AlertManagerConfig) {
    this.config = config
  }

  private getKey(validator: string, network: string): string {
    return `${validator}-${network}`
  }

  async handleMissedBlock(
    validator: string,
    network: 'mainnet' | 'testnet',
    height: number | null,
    round: number
  ): Promise<void> {
    const key = this.getKey(validator, network)
    const misses = (this.consecutiveMisses.get(key) || 0) + 1
    this.consecutiveMisses.set(key, misses)

    const payload: AlertPayload = {
      validator,
      network,
      height,
      round,
      type: 'missed',
      consecutiveMisses: misses
    }

    // Telegram: Alert on every miss
    if (this.config.telegram) {
      await sendTelegramAlert(
        this.config.telegram.botToken,
        this.config.telegram.chatId,
        payload
      )
    }

    // Discord: Alert on every miss
    if (this.config.discord) {
      await sendDiscordAlert(this.config.discord.webhookUrl, payload)
    }

    // Slack: Alert on every miss
    if (this.config.slack) {
      await sendSlackAlert(this.config.slack.webhookUrl, payload)
    }

    // PagerDuty: Alert after threshold
    if (this.config.pagerduty && misses >= this.config.pagerduty.threshold) {
      if (!this.pagerdutyTriggered.get(key)) {
        await sendPagerDutyAlert(this.config.pagerduty.routingKey, payload)
        this.pagerdutyTriggered.set(key, true)
      }
    }
  }

  async handleRecovery(
    validator: string,
    network: 'mainnet' | 'testnet',
    height: number | null,
    round: number
  ): Promise<void> {
    const key = this.getKey(validator, network)
    const hadMisses = (this.consecutiveMisses.get(key) || 0) > 0

    if (hadMisses) {
      const previousStreak = this.consecutiveMisses.get(key) || 0
      this.consecutiveMisses.set(key, 0)

      const payload: AlertPayload = {
        validator,
        network,
        height,
        round,
        type: 'recovered',
        previousStreak
      }

      // PagerDuty: Resolve incident
      if (this.config.pagerduty && this.pagerdutyTriggered.get(key)) {
        await sendPagerDutyAlert(this.config.pagerduty.routingKey, payload)
        this.pagerdutyTriggered.set(key, false)
      }
    }
  }
}
