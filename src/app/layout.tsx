import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Zoom + Gemini Live Voice Agent',
  description: 'Voice agent in Zoom meetings powered by Gemini Live',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
