const http = require('http')
const { chromium, webkit, firefox } = require('playwright')

const PORT = process.env.PORT || 3001
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'

/**
 * Onlee Screenshot Service
 *
 * Uses Playwright with 3 browser engines (Chromium, WebKit, Firefox)
 * to capture screenshots matching the client's actual browser rendering.
 *
 * Supports two modes:
 * 1. URL mode: navigates to a URL and captures
 * 2. DOM snapshot mode: renders provided HTML (BugHerd approach — most accurate)
 */

// Pre-launch browsers for faster screenshots (reuse across requests)
let browsers = {}

async function getBrowser(engine) {
  if (browsers[engine]) return browsers[engine]

  const opts = { headless: true }

  switch (engine) {
    case 'webkit':
      browsers[engine] = await webkit.launch(opts)
      break
    case 'firefox':
      browsers[engine] = await firefox.launch(opts)
      break
    default:
      browsers[engine] = await chromium.launch(opts)
      break
  }

  console.log(`[Browser] ${engine} launched`)
  return browsers[engine]
}

// Detect which engine to use based on user agent
function detectEngine(userAgent) {
  if (!userAgent) return 'chromium'
  const ua = userAgent.toLowerCase()
  if (ua.includes('firefox')) return 'firefox'
  if (ua.includes('safari') && !ua.includes('chrome') && !ua.includes('chromium')) return 'webkit'
  return 'chromium'
}

async function takeScreenshot(params) {
  const {
    url,
    html,
    baseUrl,
    userAgent,
    viewportWidth = 1440,
    viewportHeight = 900,
    scrollX = 0,
    scrollY = 0,
    devicePixelRatio = 2
  } = params

  const engine = detectEngine(userAgent)
  const browser = await getBrowser(engine)

  const context = await browser.newContext({
    viewport: { width: viewportWidth, height: viewportHeight },
    deviceScaleFactor: Math.min(devicePixelRatio, 2),
    userAgent: userAgent || undefined,
  })

  const page = await context.newPage()

  try {
    if (html) {
      // DOM Snapshot mode — render the exact HTML the user sees
      // This is the BugHerd approach: most accurate, handles animations/state
      await page.setContent(html, { waitUntil: 'networkidle' })

      // If baseUrl provided, fix relative resource URLs
      if (baseUrl) {
        await page.addStyleTag({ content: `/* base override */ @import url("${baseUrl}");` }).catch(() => {})
      }
    } else if (url) {
      // URL mode — navigate and capture
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 })
    } else {
      throw new Error('Either url or html is required')
    }

    // Wait for fonts and animations
    await page.evaluate(() => document.fonts.ready).catch(() => {})
    await page.waitForTimeout(1000)

    // Scroll to position
    if (scrollX || scrollY) {
      await page.evaluate(({ sx, sy }) => window.scrollTo(sx, sy), { sx: scrollX, sy: scrollY })
      await page.waitForTimeout(500)
    }

    // Capture viewport screenshot
    const buffer = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: viewportWidth, height: viewportHeight },
    })

    await context.close()

    return {
      screenshot: `data:image/png;base64,${buffer.toString('base64')}`,
      engine,
    }
  } catch (error) {
    await context.close()
    throw error
  }
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'POST' && req.url === '/screenshot') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const params = JSON.parse(body)
        const result = await takeScreenshot(params)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (error) {
        console.error('[Error]', error.message)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
      }
    })
    return
  }

  // Health check
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      engines: ['chromium', 'webkit', 'firefox'],
      uptime: process.uptime(),
    }))
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

// Pre-warm Chromium on startup
getBrowser('chromium').then(() => {
  console.log('[Ready] Chromium pre-warmed')
})

server.listen(PORT, () => {
  console.log(`[Server] Screenshot service running on port ${PORT}`)
})
