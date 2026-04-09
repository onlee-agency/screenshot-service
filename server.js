const http = require('http')
const { chromium, webkit, firefox } = require('playwright')

const PORT = process.env.PORT || 3001
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'

/**
 * Onlee Screenshot Service
 *
 * Page caching approach:
 * - First feedback on a URL: loads page, scrolls to bottom (triggers ALL animations),
 *   then scrolls to target and captures
 * - Subsequent feedback on same URL: reuses the already-loaded page (instant scroll + capture)
 * - Pages expire after 5 minutes of inactivity
 */

// Pre-launched browsers (reused across requests)
let browsers = {}

// Page cache: { [cacheKey]: { page, context, lastUsed, url } }
let pageCache = {}
const PAGE_TTL = 5 * 60 * 1000 // 5 minutes

async function getBrowser(engine) {
  if (browsers[engine]) return browsers[engine]
  const opts = { headless: true }
  switch (engine) {
    case 'webkit': browsers[engine] = await webkit.launch(opts); break
    case 'firefox': browsers[engine] = await firefox.launch(opts); break
    default: browsers[engine] = await chromium.launch(opts); break
  }
  console.log(`[Browser] ${engine} launched`)
  return browsers[engine]
}

function detectEngine(userAgent) {
  if (!userAgent) return 'chromium'
  const ua = userAgent.toLowerCase()
  if (ua.includes('firefox')) return 'firefox'
  if (ua.includes('safari') && !ua.includes('chrome') && !ua.includes('chromium')) return 'webkit'
  return 'chromium'
}

// Build cache key from URL + viewport + engine
function cacheKey(url, vw, vh, engine) {
  return `${engine}:${vw}x${vh}:${url}`
}

// Get or create a fully-loaded page (all animations triggered)
async function getPage(params) {
  const {
    url,
    userAgent,
    viewportWidth = 1440,
    viewportHeight = 900,
    devicePixelRatio = 2
  } = params

  const engine = detectEngine(userAgent)
  const key = cacheKey(url, viewportWidth, viewportHeight, engine)

  // Check cache — reuse if same page is still open
  if (pageCache[key]) {
    const cached = pageCache[key]
    cached.lastUsed = Date.now()
    console.log(`[Cache] HIT — reusing page for ${url} (${engine})`)
    return { page: cached.page, engine, fromCache: true }
  }

  // Cache miss — create new page, load URL, scroll to bottom to trigger all animations
  console.log(`[Cache] MISS — loading page for ${url} (${engine})`)
  const browser = await getBrowser(engine)
  const context = await browser.newContext({
    viewport: { width: viewportWidth, height: viewportHeight },
    deviceScaleFactor: Math.min(devicePixelRatio, 2),
    userAgent: userAgent || undefined,
  })

  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 })

  // Wait for fonts
  await page.evaluate(() => document.fonts.ready).catch(() => {})
  await page.waitForTimeout(500)

  // Scroll ALL the way to the bottom to trigger every animation on the page
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto'
    document.body.style.scrollBehavior = 'auto'
    var step = Math.floor(window.innerHeight / 2)
    var maxScroll = document.documentElement.scrollHeight
    for (var y = 0; y <= maxScroll; y += step) {
      window.scrollTo({ top: y, left: 0, behavior: 'instant' })
    }
    // Hit the absolute bottom
    window.scrollTo({ top: maxScroll, left: 0, behavior: 'instant' })
  })

  // Wait for all animations to complete
  await page.waitForTimeout(1500)

  // Store in cache
  pageCache[key] = { page, context, lastUsed: Date.now(), url }
  console.log(`[Cache] Stored page for ${url} (${engine})`)

  return { page, engine, fromCache: false }
}

async function takeScreenshot(params) {
  const { url, scrollX = 0, scrollY = 0, viewportWidth = 1440, viewportHeight = 900 } = params

  if (!url) throw new Error('URL is required')

  const { page, engine, fromCache } = await getPage(params)

  // Scroll to the target position (page already has all animations loaded)
  await page.evaluate(({ sx, sy }) => {
    window.scrollTo({ top: sy, left: sx, behavior: 'instant' })
  }, { sx: scrollX, sy: scrollY })

  // Brief wait — if from cache, elements are already loaded (fast)
  // If fresh page, animations already completed during full-page scroll
  await page.waitForTimeout(fromCache ? 300 : 500)

  // Capture the visible viewport
  const buffer = await page.screenshot({ type: 'png' })

  return {
    screenshot: `data:image/png;base64,${buffer.toString('base64')}`,
    engine,
    cached: fromCache,
  }
}

// Clean up expired pages every 60 seconds
setInterval(() => {
  const now = Date.now()
  for (const key in pageCache) {
    if (now - pageCache[key].lastUsed > PAGE_TTL) {
      console.log(`[Cache] Expiring page: ${key}`)
      pageCache[key].context.close().catch(() => {})
      delete pageCache[key]
    }
  }
}, 60000)

// HTTP Server
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

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

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    const cachedPages = Object.keys(pageCache).length
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      engines: ['chromium', 'webkit', 'firefox'],
      cachedPages,
      uptime: process.uptime(),
    }))
    return
  }

  res.writeHead(404); res.end('Not found')
})

getBrowser('chromium').then(() => console.log('[Ready] Chromium pre-warmed'))

server.listen(PORT, () => {
  console.log(`[Server] Screenshot service running on port ${PORT}`)
})
