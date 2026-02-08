import type { Metadata } from "next"
import { ThemeProvider } from "@/components/validator-dashboard"
import "./globals.css"

export const metadata: Metadata = {
  title: "Monadoring - Validator Monitor",
  description: "Real-time validator uptime monitoring for Monad network",
  icons: {
    icon: "/favicon.ico",
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
