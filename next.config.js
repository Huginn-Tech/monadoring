/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  experimental: {
    instrumentationHook: true,
  },
  // Expose server env vars to client (no NEXT_PUBLIC_ prefix needed)
  env: {
    MAINNET_VALIDATORS: process.env.MAINNET_VALIDATORS,
    TESTNET_VALIDATORS: process.env.TESTNET_VALIDATORS,
    MAINNET_RPCS: process.env.MAINNET_RPCS,
    TESTNET_RPCS: process.env.TESTNET_RPCS,
  },
}

module.exports = nextConfig
