// Configuration loaded from environment variables

export interface ValidatorConfig {
  id: string
  network: 'mainnet' | 'testnet'
}

export interface RpcConfig {
  url: string
  name: string
  isPrimary: boolean
}

export interface AlertConfig {
  telegram: {
    enabled: boolean
    botToken: string
    chatId: string
  }
  discord: {
    enabled: boolean
    webhookUrl: string
  }
  pagerduty: {
    enabled: boolean
    routingKey: string
    threshold: number
  }
}

export interface Config {
  validators: {
    mainnet: string[]
    testnet: string[]
  }
  rpcs: {
    mainnet: RpcConfig[]
    testnet: RpcConfig[]
  }
  api: {
    mainnet: string
    testnet: string
  }
  server: {
    port: number
    host: string
  }
  alerts: AlertConfig
}

function parseValidators(envValue: string | undefined): string[] {
  if (!envValue) return []
  return envValue.split(',').map(v => v.trim()).filter(Boolean)
}

function parseRpcs(envValue: string | undefined): RpcConfig[] {
  if (!envValue) return []
  return envValue.split(',').map((url, index) => ({
    url: url.trim(),
    name: `RPC ${index + 1}`,
    isPrimary: index === 0
  })).filter(rpc => rpc.url)
}

export function getConfig(): Config {
  return {
    validators: {
      mainnet: parseValidators(process.env.MAINNET_VALIDATORS),
      testnet: parseValidators(process.env.TESTNET_VALIDATORS)
    },
    rpcs: {
      mainnet: parseRpcs(process.env.MAINNET_RPCS),
      testnet: parseRpcs(process.env.TESTNET_RPCS)
    },
    api: {
      mainnet: 'https://staking-api.huginn.tech/monad-api',
      testnet: 'https://testnet-staking-api.huginn.tech/monad-api'
    },
    server: {
      port: parseInt(process.env.PORT || '3030', 10),
      host: process.env.HOST || '0.0.0.0'
    },
    alerts: {
      telegram: {
        enabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
        chatId: process.env.TELEGRAM_CHAT_ID || ''
      },
      discord: {
        enabled: !!process.env.DISCORD_WEBHOOK_URL,
        webhookUrl: process.env.DISCORD_WEBHOOK_URL || ''
      },
      pagerduty: {
        enabled: !!process.env.PAGERDUTY_ROUTING_KEY,
        routingKey: process.env.PAGERDUTY_ROUTING_KEY || '',
        threshold: parseInt(process.env.PAGERDUTY_THRESHOLD || '5', 10)
      }
    }
  }
}

// Default RPCs if none configured
export const DEFAULT_MAINNET_RPCS: RpcConfig[] = [
  { url: 'https://monad-rpc.huginn.tech', name: 'Huginn', isPrimary: true },
  { url: 'https://rpc.monad.xyz', name: 'Monad', isPrimary: false },
  { url: 'https://rpc-mainnet.monadinfra.com', name: 'Monad Infra', isPrimary: false }
]

export const DEFAULT_TESTNET_RPCS: RpcConfig[] = [
  { url: 'https://testnet-rpc.monad.xyz', name: 'Testnet', isPrimary: true }
]
