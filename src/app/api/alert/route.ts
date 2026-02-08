import { NextRequest, NextResponse } from "next/server"
import {
  sendTelegramAlert,
  sendDiscordAlert,
  sendPagerDutyAlert
} from "@/lib/alerts"

interface ValidatorAlertRequest {
  validator: string
  network: "mainnet" | "testnet"
  height: number
  round: number
  type: "missed" | "recovered"
  consecutiveMisses?: number
}

interface RpcAlertRequest {
  type: "rpc_failover" | "rpc_recovered"
  network: "mainnet" | "testnet"
  fromRpc: string
  toRpc: string
  reason?: string
}

type AlertRequest = ValidatorAlertRequest | RpcAlertRequest

// Track consecutive misses per validator
const consecutiveMisses = new Map<string, number>()
const pagerdutyTriggered = new Map<string, boolean>()

// Format RPC alert message
function formatRpcAlertMessage(data: RpcAlertRequest): string {
  const networkEmoji = data.network === "mainnet" ? "🟣" : "🔵"
  const networkName = data.network.charAt(0).toUpperCase() + data.network.slice(1)

  if (data.type === "rpc_failover") {
    return `⚠️ RPC Failover\n\n${networkEmoji} Network: ${networkName}\n📍 From: ${data.fromRpc}\n📍 To: ${data.toRpc}${data.reason ? `\n📝 Reason: ${data.reason}` : ""}`
  } else {
    return `✅ RPC Recovered\n\n${networkEmoji} Network: ${networkName}\n📍 Primary: ${data.toRpc}\n📝 Switched back to primary RPC`
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: AlertRequest = await request.json()
    const results: { service: string; success: boolean }[] = []

    // Handle RPC alerts
    if (body.type === "rpc_failover" || body.type === "rpc_recovered") {
      const rpcData = body as RpcAlertRequest
      const message = formatRpcAlertMessage(rpcData)

      // Telegram
      const telegramToken = process.env.TELEGRAM_BOT_TOKEN
      const telegramChat = process.env.TELEGRAM_CHAT_ID
      if (telegramToken && telegramChat) {
        try {
          const res = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: telegramChat,
              text: message,
              parse_mode: "HTML"
            })
          })
          results.push({ service: "telegram", success: res.ok })
        } catch {
          results.push({ service: "telegram", success: false })
        }
      }

      // Discord
      const discordWebhook = process.env.DISCORD_WEBHOOK_URL
      if (discordWebhook) {
        try {
          const res = await fetch(discordWebhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: message.replace(/\n/g, "\n")
            })
          })
          results.push({ service: "discord", success: res.ok })
        } catch {
          results.push({ service: "discord", success: false })
        }
      }

      return NextResponse.json({ success: true, alerts: results })
    }

    // Handle validator alerts (existing logic)
    const validatorData = body as ValidatorAlertRequest
    const { validator, network, height, round, type } = validatorData

    const key = `${validator}-${network}`

    // Update consecutive misses
    if (type === "missed") {
      const current = (consecutiveMisses.get(key) || 0) + 1
      consecutiveMisses.set(key, current)
      validatorData.consecutiveMisses = current
    } else {
      consecutiveMisses.set(key, 0)
    }

    const payload = {
      validator,
      network,
      height,
      round,
      type,
      consecutiveMisses: validatorData.consecutiveMisses
    }

    // Telegram - every miss
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN
    const telegramChat = process.env.TELEGRAM_CHAT_ID
    if (telegramToken && telegramChat) {
      const success = await sendTelegramAlert(telegramToken, telegramChat, payload)
      results.push({ service: "telegram", success })
    }

    // Discord - every miss
    const discordWebhook = process.env.DISCORD_WEBHOOK_URL
    if (discordWebhook) {
      const success = await sendDiscordAlert(discordWebhook, payload)
      results.push({ service: "discord", success })
    }

    // PagerDuty - after threshold
    const pagerdutyKey = process.env.PAGERDUTY_ROUTING_KEY
    const threshold = parseInt(process.env.PAGERDUTY_THRESHOLD || "5", 10)
    if (pagerdutyKey) {
      if (type === "missed" && (validatorData.consecutiveMisses || 0) >= threshold) {
        if (!pagerdutyTriggered.get(key)) {
          const success = await sendPagerDutyAlert(pagerdutyKey, payload)
          results.push({ service: "pagerduty", success })
          pagerdutyTriggered.set(key, true)
        }
      } else if (type === "recovered" && pagerdutyTriggered.get(key)) {
        const success = await sendPagerDutyAlert(pagerdutyKey, payload)
        results.push({ service: "pagerduty", success })
        pagerdutyTriggered.set(key, false)
      }
    }

    return NextResponse.json({
      success: true,
      alerts: results,
      consecutiveMisses: consecutiveMisses.get(key) || 0
    })
  } catch (error) {
    console.error("Alert API error:", error)
    return NextResponse.json(
      { success: false, error: "Failed to send alerts" },
      { status: 500 }
    )
  }
}
