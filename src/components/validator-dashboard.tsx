"use client"

import * as React from "react"
import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { ThemeProvider as NextThemesProvider, useTheme as useNextTheme } from "next-themes"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { RefreshCw, Moon, Sun } from "lucide-react"
import { fetchBlockHeight, checkRpcHealth, fetchUptimeStats, fetchHistory } from "@/lib/api"

// ============ EXPORTS ============
export function ThemeProvider({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}

// ============ TYPES ============
type BlockStatus = "finalized" | "missed" | "no-data"

interface Block {
  height: number | null
  round: number
  status: BlockStatus
}

interface ValidatorState {
  id: string
  network: "mainnet" | "testnet"
  name: string
  moniker: string
  height: number
  uptime: number
  missed: number
  blocks: Block[]
}

interface RpcState {
  url: string
  name: string
  isOnline: boolean
  isPrimary: boolean
}

interface DashboardState {
  validators: ValidatorState[]
  mainnetRpcs: RpcState[]
  testnetRpcs: RpcState[]
  loading: boolean
  error: string | null
}

// ============ CONFIG ============
const CONFIG = {
  mainnetValidators: process.env.MAINNET_VALIDATORS || '',
  testnetValidators: process.env.TESTNET_VALIDATORS || '',
  mainnetRpcs: process.env.MAINNET_RPCS || '',
  testnetRpcs: process.env.TESTNET_RPCS || '',
}

// ============ CONSTANTS ============
const DISPLAY_BLOCKS = 50
const RPC_CHECK_INTERVAL = 600000 // 10 minutes - for secondary RPCs liveliness check
const DATA_POLL_INTERVAL = 2000 // 2 seconds - for primary RPC height polling
const PRIMARY_RECOVERY_INTERVAL = 300000 // 5 minutes - check if primary is back online
const FAILOVER_THRESHOLD = 30 // After 30 polls (1 minute) of issues, failover to secondary

// ============ HELPERS ============
function extractNameFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname
    const parts = hostname.split('.')
    const domainPart = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
    return domainPart.charAt(0).toUpperCase() + domainPart.slice(1)
  } catch {
    return url
  }
}

function parseRpcConfig(envValue: string): { url: string; name: string }[] {
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

// ============ COMPONENTS ============
function useTheme() {
  const { resolvedTheme, setTheme } = useNextTheme()
  return {
    theme: (resolvedTheme || "dark") as "dark" | "light",
    toggleTheme: () => setTheme(resolvedTheme === "dark" ? "light" : "dark")
  }
}

function StatusLegend({ isDark }: { isDark: boolean }) {
  return (
    <div className={`flex items-center gap-4 text-[13px] ${isDark ? "text-zinc-300" : "text-zinc-600"}`}>
      <div className="flex items-center gap-1.5">
        <div className="w-2 h-2 rounded-sm bg-emerald-500" />
        <span className="font-medium">Finalized</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-2 h-2 rounded-sm bg-red-500" />
        <span className="font-medium">Missed</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-2 h-2 rounded-sm bg-indigo-500" />
        <span className="font-medium">Last Finalized</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className={`w-2 h-2 rounded-sm ${isDark ? "bg-zinc-800" : "bg-zinc-200"}`} />
        <span className="font-medium">No Data</span>
      </div>
    </div>
  )
}

function ValidatorStatusIndicator({ validator }: { validator: ValidatorState }) {
  const lastBlock = validator.blocks.length > 0 ? validator.blocks[validator.blocks.length - 1] : null
  const isCurrentlyOnline = lastBlock?.status === "finalized"

  let color = "bg-emerald-500"
  let showPing = true
  let tooltip = "Validator is online"

  if (validator.blocks.length === 0 || validator.height === 0) {
    color = "bg-gray-500"
    showPing = false
    tooltip = "No data available"
  } else if (!isCurrentlyOnline && validator.missed >= 50) {
    color = "bg-red-500"
    showPing = false
    tooltip = `Critical: ${validator.missed} blocks missed in 24hr`
  } else if (!isCurrentlyOnline) {
    color = "bg-yellow-500"
    showPing = false
    tooltip = `Timeout: last block missed (${validator.missed} missed in 24hr)`
  }

  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="relative flex h-2.5 w-2.5 cursor-help">
            {showPing && (
              <span className="animate-ping absolute h-full w-full rounded-full bg-emerald-500 opacity-75" />
            )}
            <span className={`relative rounded-full h-2.5 w-2.5 ${color}`} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-[13px]">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function UptimeBar({ blocks, isDark, showLastFinalized = false }: { blocks: Block[]; isDark: boolean; showLastFinalized?: boolean }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const blockRefs = useRef<(HTMLDivElement | null)[]>([])

  if (blocks.length === 0) return null

  const display: Block[] = []
  for (let i = 0; i < DISPLAY_BLOCKS - blocks.length; i++) display.push({ height: null, round: 0, status: "no-data" })
  display.push(...blocks)

  let lastFinalizedIndex = -1
  if (showLastFinalized) {
    for (let i = display.length - 1; i >= 0; i--) {
      if (display[i].status === "finalized") {
        lastFinalizedIndex = i
        break
      }
    }
  }

  const hoveredBlock = hoveredIndex !== null ? display[hoveredIndex] : null
  const isHoveredLastFinalized = hoveredIndex === lastFinalizedIndex

  // Calculate tooltip position relative to container
  let tooltipLeft = 0
  if (hoveredIndex !== null && blockRefs.current[hoveredIndex] && containerRef.current) {
    const blockRect = blockRefs.current[hoveredIndex]!.getBoundingClientRect()
    const containerRect = containerRef.current.getBoundingClientRect()
    tooltipLeft = blockRect.left - containerRect.left + blockRect.width / 2
  }

  return (
    <div className="relative" onMouseLeave={() => setHoveredIndex(null)}>
      <div
        ref={containerRef}
        className={`flex gap-[2px] h-6 rounded-lg overflow-hidden p-1 ${isDark ? "bg-zinc-900/50" : "bg-zinc-100"}`}
      >
        {display.map((block, i) => {
          const isLastFinalized = i === lastFinalizedIndex
          return (
            <div
              key={i}
              ref={(el) => { blockRefs.current[i] = el }}
              onMouseEnter={() => setHoveredIndex(i)}
              className={`flex-1 rounded-[3px] transition-all duration-200 cursor-pointer hover:scale-y-110 ${
                isLastFinalized
                  ? "bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.4)]"
                  : block.status === "finalized"
                  ? "bg-emerald-500"
                  : block.status === "missed"
                  ? "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.3)]"
                  : isDark
                  ? "bg-zinc-800/60"
                  : "bg-zinc-200"
              }`}
            />
          )
        })}
      </div>
      {hoveredBlock && (
        <div
          className={`absolute bottom-full mb-2 z-50 rounded-md border px-3 py-1.5 text-[13px] shadow-xl backdrop-blur-sm pointer-events-none ${isDark ? "bg-zinc-900/95 border-zinc-700/50 text-white" : "bg-white/95 border-zinc-200 text-zinc-900"}`}
          style={{ left: tooltipLeft, transform: "translateX(-50%)" }}
        >
          {hoveredBlock.status === "no-data" ? (
            <span className={isDark ? "text-zinc-500" : "text-zinc-400"}>No Data</span>
          ) : (
            <div className="space-y-1.5 py-0.5">
              <div className="flex items-center gap-3">
                <span className={`text-[11px] uppercase tracking-wider font-medium ${isDark ? "text-zinc-500" : "text-zinc-400"}`}>Height</span>
                <span className={`font-mono text-[12px] ${isDark ? "text-zinc-200" : "text-zinc-800"}`}>{hoveredBlock.height !== null ? hoveredBlock.height.toLocaleString() : 'N/A'}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-[11px] uppercase tracking-wider font-medium ${isDark ? "text-zinc-500" : "text-zinc-400"}`}>Round</span>
                <div className="flex items-center gap-2">
                  <span className={`font-mono text-[12px] ${isDark ? "text-zinc-200" : "text-zinc-800"}`}>{hoveredBlock.round.toLocaleString()}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide whitespace-nowrap ${
                    hoveredBlock.status === "finalized"
                      ? "bg-indigo-500 text-white"
                      : "bg-red-500 text-white"
                  }`}>
                    {hoveredBlock.status === "finalized" ? (isHoveredLastFinalized ? "Last Finalized" : "Finalized") : "Missed"}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function RpcDisplay({ rpcs, isDark }: { rpcs: RpcState[]; isDark: boolean }) {
  if (rpcs.length === 0) return <span className="text-zinc-500">-</span>
  const online = rpcs.filter(r => r.isOnline).length
  const color = online === rpcs.length ? "text-emerald-500" : online > 0 ? "text-yellow-500" : "text-red-500"
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`font-mono text-[15px] font-bold cursor-help ${color}`}>{online}/{rpcs.length}</span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className={`text-[13px] ${isDark ? "bg-zinc-900 border-zinc-800 text-white" : "bg-white border-zinc-200 text-zinc-900"}`}
        >
          <div className="space-y-1">
            {rpcs.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className={`w-1.5 h-1.5 rounded-full ${r.isOnline ? "bg-emerald-500" : "bg-red-500"}`} />
                <span className={isDark ? "text-white" : "text-zinc-900"}>{r.name}</span>
                {r.isPrimary && <span className={isDark ? "text-zinc-400" : "text-zinc-500"} style={{ fontSize: '11px' }}>(Primary)</span>}
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// ============ MAIN ============
export function ValidatorDashboard() {
  const { theme, toggleTheme } = useTheme()
  const isDark = theme === "dark"

  const [state, setState] = useState<DashboardState>({
    validators: [],
    mainnetRpcs: [],
    testnetRpcs: [],
    loading: true,
    error: null
  })

  const mainnetRpcConfigs = useMemo(() => parseRpcConfig(CONFIG.mainnetRpcs), [])
  const testnetRpcConfigs = useMemo(() => parseRpcConfig(CONFIG.testnetRpcs), [])

  const [activeMainnetRpcIndex, setActiveMainnetRpcIndex] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('monadoring_mainnet_rpc')
      return saved ? parseInt(saved, 10) : 0
    }
    return 0
  })
  const [activeTestnetRpcIndex, setActiveTestnetRpcIndex] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('monadoring_testnet_rpc')
      return saved ? parseInt(saved, 10) : 0
    }
    return 0
  })

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('monadoring_mainnet_rpc', activeMainnetRpcIndex.toString())
    }
  }, [activeMainnetRpcIndex])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('monadoring_testnet_rpc', activeTestnetRpcIndex.toString())
    }
  }, [activeTestnetRpcIndex])

  const mainnetRpcsRef = useRef<RpcState[]>([])
  const testnetRpcsRef = useRef<RpcState[]>([])

  const lastMainnetHeightRef = useRef<number>(0)
  const lastTestnetHeightRef = useRef<number>(0)
  const mainnetIssueCountRef = useRef<number>(0)
  const testnetIssueCountRef = useRef<number>(0)

  const mainnetFailoverAlertSentRef = useRef<boolean>(false)
  const testnetFailoverAlertSentRef = useRef<boolean>(false)

  const checkAllRpcs = useCallback(async () => {
    const mainnetResults = await Promise.all(
      mainnetRpcConfigs.map(async (rpc, i) => ({
        url: rpc.url,
        name: rpc.name,
        isOnline: await checkRpcHealth(rpc.url),
        isPrimary: i === activeMainnetRpcIndex
      }))
    )

    const testnetResults = await Promise.all(
      testnetRpcConfigs.map(async (rpc, i) => ({
        url: rpc.url,
        name: rpc.name,
        isOnline: await checkRpcHealth(rpc.url),
        isPrimary: i === activeTestnetRpcIndex
      }))
    )

    mainnetRpcsRef.current = mainnetResults
    testnetRpcsRef.current = testnetResults

    setState(prev => ({
      ...prev,
      mainnetRpcs: mainnetResults,
      testnetRpcs: testnetResults
    }))
  }, [mainnetRpcConfigs, testnetRpcConfigs, activeMainnetRpcIndex, activeTestnetRpcIndex])

  const updateRpcDisplayState = useCallback((
    network: "mainnet" | "testnet",
    failedIndex: number,
    newActiveIndex: number,
    isRecovery: boolean = false
  ) => {
    setState(prev => {
      const oldRpcs = network === "mainnet" ? prev.mainnetRpcs : prev.testnetRpcs

      const rpcs = oldRpcs.map((rpc, i) => {
        let isOnline = rpc.isOnline

        if (isRecovery) {
          if (i === newActiveIndex) {
            isOnline = true
          }
        } else {
          if (i === failedIndex) {
            isOnline = false
          }
        }

        return {
          ...rpc,
          isOnline,
          isPrimary: i === newActiveIndex
        }
      })

      return {
        ...prev,
        ...(network === "mainnet" ? { mainnetRpcs: rpcs } : { testnetRpcs: rpcs })
      }
    })
  }, [])

  const sendRpcAlert = useCallback(async (
    type: "rpc_failover" | "rpc_recovered",
    network: "mainnet" | "testnet",
    fromRpc: string,
    toRpc: string,
    reason?: string
  ) => {
    try {
      await fetch("/api/alert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, network, fromRpc, toRpc, reason })
      })
      console.log(`[Monadoring] Alert sent: ${type} on ${network}`)
    } catch (err) {
      console.error("[Monadoring] Failed to send alert:", err)
    }
  }, [])

  const fetchCurrentHeight = useCallback(async (network: "mainnet" | "testnet"): Promise<number> => {
    const rpcConfigs = network === "mainnet" ? mainnetRpcConfigs : testnetRpcConfigs
    const activeIndex = network === "mainnet" ? activeMainnetRpcIndex : activeTestnetRpcIndex
    const setActiveIndex = network === "mainnet" ? setActiveMainnetRpcIndex : setActiveTestnetRpcIndex
    const lastHeightRef = network === "mainnet" ? lastMainnetHeightRef : lastTestnetHeightRef
    const issueCountRef = network === "mainnet" ? mainnetIssueCountRef : testnetIssueCountRef
    const alertSentRef = network === "mainnet" ? mainnetFailoverAlertSentRef : testnetFailoverAlertSentRef

    if (rpcConfigs.length === 0) return 0

    const height = await fetchBlockHeight(rpcConfigs[activeIndex].url)

    const hasIssue = height === 0 || height === lastHeightRef.current

    if (hasIssue) {
      issueCountRef.current++

      if (issueCountRef.current < FAILOVER_THRESHOLD) {
        return lastHeightRef.current || height
      }

      const reason = height === 0 ? 'offline' : `stale (stuck at ${height})`
      console.log(`[Monadoring] ${network} RPC ${reason} for 1 minute, trying failover...`)

      for (let i = 1; i < rpcConfigs.length; i++) {
        const nextIndex = (activeIndex + i) % rpcConfigs.length
        const fallbackHeight = await fetchBlockHeight(rpcConfigs[nextIndex].url)
        const isValidFallback = height === 0
          ? fallbackHeight > 0
          : fallbackHeight > 0 && fallbackHeight > height

        if (isValidFallback) {
          console.log(`[Monadoring] ${network} switched to ${rpcConfigs[nextIndex].name} (height: ${fallbackHeight})`)
          if (!alertSentRef.current) {
            sendRpcAlert("rpc_failover", network, rpcConfigs[activeIndex].name, rpcConfigs[nextIndex].name, reason)
            alertSentRef.current = true
          }
          updateRpcDisplayState(network, activeIndex, nextIndex)
          setActiveIndex(nextIndex)
          lastHeightRef.current = fallbackHeight
          issueCountRef.current = 0
          return fallbackHeight
        }
      }

      return height === 0 ? lastHeightRef.current : height
    }

    issueCountRef.current = 0
    lastHeightRef.current = height
    if (activeIndex === 0) {
      alertSentRef.current = false
    }
    return height
  }, [mainnetRpcConfigs, testnetRpcConfigs, activeMainnetRpcIndex, activeTestnetRpcIndex, sendRpcAlert, updateRpcDisplayState])

  const fetchData = useCallback(async () => {
    const mainnetIds = CONFIG.mainnetValidators.split(",").map(s => s.trim()).filter(Boolean)
    const testnetIds = CONFIG.testnetValidators.split(",").map(s => s.trim()).filter(Boolean)

    try {
      const [mainnetHeight, testnetHeight] = await Promise.all([
        fetchCurrentHeight("mainnet"),
        fetchCurrentHeight("testnet")
      ])

      const validators: ValidatorState[] = []

      for (const id of mainnetIds) {
        const [histData, uptimeData] = await Promise.all([
          fetchHistory(id, "mainnet", DISPLAY_BLOCKS),
          fetchUptimeStats(id, "mainnet")
        ])

        const blocks: Block[] = histData?.history
          ? [...histData.history].reverse().map(h => ({
              height: h.height,
              round: h.round,
              status: (h.status === "timeout" ? "missed" : "finalized") as BlockStatus
            }))
          : []

        validators.push({
          id,
          network: "mainnet",
          name: "Monad Mainnet",
          moniker: histData?.validatorName || "-",
          height: mainnetHeight,
          uptime: uptimeData?.uptime_percent || 0,
          missed: uptimeData?.timeout_count || 0,
          blocks
        })
      }

      for (const id of testnetIds) {
        const [histData, uptimeData] = await Promise.all([
          fetchHistory(id, "testnet", DISPLAY_BLOCKS),
          fetchUptimeStats(id, "testnet")
        ])

        const blocks: Block[] = histData?.history
          ? [...histData.history].reverse().map(h => ({
              height: h.height,
              round: h.round,
              status: (h.status === "timeout" ? "missed" : "finalized") as BlockStatus
            }))
          : []

        validators.push({
          id,
          network: "testnet",
          name: "Monad Testnet",
          moniker: histData?.validatorName || "-",
          height: testnetHeight,
          uptime: uptimeData?.uptime_percent || 0,
          missed: uptimeData?.timeout_count || 0,
          blocks
        })
      }

      if (testnetIds.length === 0) {
        validators.push({
          id: "-",
          network: "testnet",
          name: "Monad Testnet",
          moniker: "-",
          height: 0,
          uptime: 0,
          missed: 0,
          blocks: []
        })
      }

      setState(prev => ({
        ...prev,
        validators,
        loading: false,
        error: null
      }))
    } catch (err) {
      console.error("Fetch error:", err)
      setState(prev => ({
        ...prev,
        error: "Connection error",
        loading: false
      }))
    }
  }, [fetchCurrentHeight])

  useEffect(() => {
    checkAllRpcs()
    const interval = setInterval(checkAllRpcs, RPC_CHECK_INTERVAL)
    return () => clearInterval(interval)
  }, [checkAllRpcs])

  useEffect(() => {
    const checkPrimaryRecovery = async () => {
      if (activeMainnetRpcIndex !== 0 && mainnetRpcConfigs.length > 0) {
        const primaryHeight = await fetchBlockHeight(mainnetRpcConfigs[0].url)
        if (primaryHeight > 0 && primaryHeight > lastMainnetHeightRef.current) {
          console.log(`[Monadoring] Mainnet primary recovered (height: ${primaryHeight}), switching back`)
          sendRpcAlert("rpc_recovered", "mainnet", mainnetRpcConfigs[activeMainnetRpcIndex].name, mainnetRpcConfigs[0].name)
          updateRpcDisplayState("mainnet", activeMainnetRpcIndex, 0, true)
          setActiveMainnetRpcIndex(0)
          lastMainnetHeightRef.current = primaryHeight
          mainnetIssueCountRef.current = 0
          mainnetFailoverAlertSentRef.current = false
        }
      }
      if (activeTestnetRpcIndex !== 0 && testnetRpcConfigs.length > 0) {
        const primaryHeight = await fetchBlockHeight(testnetRpcConfigs[0].url)
        if (primaryHeight > 0 && primaryHeight > lastTestnetHeightRef.current) {
          console.log(`[Monadoring] Testnet primary recovered (height: ${primaryHeight}), switching back`)
          sendRpcAlert("rpc_recovered", "testnet", testnetRpcConfigs[activeTestnetRpcIndex].name, testnetRpcConfigs[0].name)
          updateRpcDisplayState("testnet", activeTestnetRpcIndex, 0, true)
          setActiveTestnetRpcIndex(0)
          lastTestnetHeightRef.current = primaryHeight
          testnetIssueCountRef.current = 0
          testnetFailoverAlertSentRef.current = false
        }
      }
    }

    const interval = setInterval(checkPrimaryRecovery, PRIMARY_RECOVERY_INTERVAL)
    return () => clearInterval(interval)
  }, [activeMainnetRpcIndex, activeTestnetRpcIndex, mainnetRpcConfigs, testnetRpcConfigs, sendRpcAlert, updateRpcDisplayState])

  useEffect(() => {
    let mounted = true

    async function poll() {
      if (mounted) await fetchData()
    }

    poll()
    const interval = setInterval(poll, DATA_POLL_INTERVAL)

    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [fetchData])

  if (state.loading && state.validators.length === 0) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${isDark ? "bg-black" : "bg-zinc-50"}`}>
        <RefreshCw className="w-5 h-5 text-zinc-500 animate-spin" />
      </div>
    )
  }

  const mainnet = state.validators.filter(v => v.network === "mainnet")
  const testnet = state.validators.filter(v => v.network === "testnet")

  return (
    <div className={`min-h-screen font-normal ${isDark ? "bg-black text-zinc-100" : "bg-zinc-50 text-zinc-900"}`}>
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <header className="flex items-center justify-between mb-10">
          <div className="flex items-center gap-4">
            <h1 className={`text-[22px] font-semibold tracking-tight ${isDark ? "text-white" : "text-zinc-900"}`}>Monadoring Dashboard</h1>
            {state.error && <span className="text-[13px] text-red-500">{state.error}</span>}
          </div>
          <div className="flex items-center gap-6">
            <StatusLegend isDark={isDark} />
            <button
              onClick={toggleTheme}
              className={`p-2 rounded-lg transition-colors ${isDark ? "hover:bg-zinc-900" : "hover:bg-zinc-100"}`}
            >
              {isDark ? <Sun className="w-4 h-4 text-zinc-400" /> : <Moon className="w-4 h-4 text-zinc-600" />}
            </button>
          </div>
        </header>

        {/* Uptime Bars */}
        <section className={`rounded-xl border p-6 mb-8 ${isDark ? "bg-zinc-900/30 border-zinc-800/60" : "bg-white border-zinc-200"}`}>
          <div className="space-y-5">
            {mainnet.map(v => (
              <div key={`bar-${v.network}-${v.id}`}>
                <div className="flex items-center gap-2 mb-3">
                  <ValidatorStatusIndicator validator={v} />
                  <span className={`text-[15px] font-medium tracking-tight ${isDark ? "text-white" : "text-zinc-900"}`}>{v.name}</span>
                  <span className={`text-[15px] ${isDark ? "text-white" : "text-zinc-900"}`}>- ({v.moniker})</span>
                </div>
                <UptimeBar blocks={v.blocks} isDark={isDark} showLastFinalized={true} />
              </div>
            ))}
            {testnet.map(v => (
              <div key={`bar-${v.network}-${v.id}`}>
                <div className="flex items-center gap-2 mb-3">
                  <ValidatorStatusIndicator validator={v} />
                  <span className={`text-[15px] font-medium tracking-tight ${isDark ? "text-white" : "text-zinc-900"}`}>{v.name}</span>
                  <span className={`text-[15px] ${isDark ? "text-white" : "text-zinc-900"}`}>- ({v.moniker})</span>
                </div>
                <UptimeBar blocks={v.blocks} isDark={isDark} showLastFinalized={true} />
              </div>
            ))}
          </div>
        </section>

        {/* Network Stats Cards */}
        <section className="grid gap-4 mb-10">
          {[
            { id: "mainnet", name: "Monad Mainnet", validators: mainnet, rpcs: state.mainnetRpcs },
            { id: "testnet", name: "Monad Testnet", validators: testnet, rpcs: state.testnetRpcs },
          ].filter(n => n.validators.length > 0).flatMap((network) => {
            const showValidatorName = network.validators.length > 1
            return network.validators.map((v) => (
              <div
                key={`card-${v.network}-${v.id}`}
                className={`rounded-xl border px-5 py-4 transition-all ${
                  isDark
                    ? "bg-zinc-900/40 border-zinc-800/60 hover:border-zinc-700/60"
                    : "bg-white border-zinc-200 hover:border-zinc-300"
                }`}
              >
                {/* Card Header */}
                <div className="flex items-center gap-3 mb-3">
                  <span className={`text-[18px] font-semibold ${isDark ? "text-white" : "text-zinc-900"}`}>
                    {network.name}{showValidatorName ? ` - ${v.moniker}` : ""}
                  </span>
                  {v.height > 0 && (
                    <span className={`text-[13px] px-2 py-0.5 rounded-full font-medium ${
                      isDark ? "bg-emerald-500/10 text-emerald-400" : "bg-emerald-50 text-emerald-600"
                    }`}>
                      Active
                    </span>
                  )}
                </div>

                {/* Stats */}
                <div className="flex justify-between">
                  <div className="text-left">
                    <div className={`text-[11px] uppercase tracking-wide mb-1 ${isDark ? "text-zinc-500" : "text-zinc-600"}`}>
                      Block Height
                    </div>
                    <div className={`text-[15px] font-bold tabular-nums ${isDark ? "text-zinc-200" : "text-zinc-700"}`}>
                      {v.height > 0 ? v.height.toLocaleString() : "-"}
                    </div>
                  </div>

                  <div className="text-center">
                    <div className={`text-[11px] uppercase tracking-wide mb-1 ${isDark ? "text-zinc-500" : "text-zinc-600"}`}>
                      Validator Uptime (24h)
                    </div>
                    <div className={`text-[15px] font-bold tabular-nums ${
                      v.height > 0
                        ? v.uptime >= 99
                          ? "text-emerald-400"
                          : v.uptime >= 95
                            ? "text-yellow-400"
                            : "text-red-400"
                        : isDark ? "text-zinc-600" : "text-zinc-400"
                    }`}>
                      {v.height > 0 ? `${v.uptime.toFixed(2)}%` : "-"}
                    </div>
                  </div>

                  <div className="text-center">
                    <div className={`text-[11px] uppercase tracking-wide mb-1 ${isDark ? "text-zinc-500" : "text-zinc-600"}`}>
                      Missed Blocks
                    </div>
                    <div className={`text-[15px] font-bold tabular-nums ${
                      v.height > 0 && v.missed > 0
                        ? "text-red-400"
                        : isDark ? "text-zinc-200" : "text-zinc-700"
                    }`}>
                      {v.height > 0 ? v.missed : "-"}
                    </div>
                  </div>

                  <div className="text-right">
                    <div className={`text-[11px] uppercase tracking-wide mb-1 ${isDark ? "text-zinc-500" : "text-zinc-600"}`}>
                      RPC
                    </div>
                    <div className="text-[15px]">
                      {network.rpcs.length > 0 ? (
                        <RpcDisplay rpcs={network.rpcs} isDark={isDark} />
                      ) : (
                        <span className="text-zinc-500">-</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))
          })}
        </section>

        {/* Footer */}
        <footer className="flex flex-col items-center gap-5 pt-4">
          <a
            href="https://monval.huginn.tech/monad-validator-api"
            target="_blank"
            rel="noopener noreferrer"
            className={`px-5 py-2.5 text-[15px] font-medium rounded-lg border transition-all ${
              isDark
                ? "border-zinc-800 hover:border-zinc-700 bg-zinc-900/50 hover:bg-zinc-800/50 text-zinc-300 hover:text-white"
                : "border-zinc-200 hover:border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-600 hover:text-zinc-900"
            }`}
          >
            <span className="font-mono">[VALIDATOR API]</span>
          </a>
          <div className={`w-full max-w-xs h-px ${isDark ? "bg-zinc-800/50" : "bg-zinc-200"}`} />
          <a
            href="https://github.com/Huginn-Tech/monadoring"
            target="_blank"
            rel="noopener noreferrer"
            className={`p-2.5 rounded-lg transition-all ${isDark ? "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50" : "text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100"}`}
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
          </a>
        </footer>
      </div>
    </div>
  )
}
