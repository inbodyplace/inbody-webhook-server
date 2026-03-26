'use strict'

require('dotenv').config()
const express = require('express')
const axios = require('axios')
const path = require('path')
const { randomUUID } = require('crypto')

const app = express()
const PORT = process.env.PORT || 3000

// ─── Config ───────────────────────────────────────────────────────────────────
const INBODY_API_BASE   = (process.env.INBODY_API_BASE_URL || 'https://inbodywebapi.lookinbody.com').replace(/\/$/, '')
const INBODY_ACCOUNT    = process.env.INBODY_ACCOUNT || ''
const INBODY_API_KEY    = process.env.INBODY_API_KEY || ''
const WEBHOOK_HDR_NAME  = process.env.WEBHOOK_HEADER_NAME || ''
const WEBHOOK_HDR_VALUE = process.env.WEBHOOK_HEADER_VALUE || ''

// ─── In-memory event store (max 200 entries) ──────────────────────────────────
const MAX_EVENTS = 200
const events = []

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ─── POST /webhook ────────────────────────────────────────────────────────────
// InBody Developers sends a POST to this URL whenever a measurement is completed.
//
// Payload example:
// {
//   "EquipSerial":   "CC71700163",
//   "TelHP":         "01012344733",   // UserToken (mobile number)
//   "UserID":        "member001",
//   "TestDatetimes": "20190811120103",
//   "Account":       "your_lbweb_account",
//   "Equip":         "InBody770",
//   "Type":          "InBody",
//   "IsTempData":    "false"
// }
app.post('/webhook', (req, res) => {
  // 1. Optional custom-header validation
  //    Set WEBHOOK_HEADER_NAME / WEBHOOK_HEADER_VALUE in .env and configure the
  //    same header in InBody Developers > API Setup > Webhook > Custom Headers.
  if (WEBHOOK_HDR_NAME && WEBHOOK_HDR_VALUE) {
    const incoming = req.headers[WEBHOOK_HDR_NAME.toLowerCase()]
    if (incoming !== WEBHOOK_HDR_VALUE) {
      console.warn('[Webhook] Rejected — invalid custom header')
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  const payload = req.body

  // 2. IsTempData guard — temp data cannot be fetched via API yet.
  //    The LBWeb admin must review and approve it first.
  if (payload.IsTempData === 'true') {
    console.log(`[Webhook] Received temp-data event (UserID=${payload.UserID}). Skipping API fetch.`)
    storeEvent(payload, null, 'skipped_temp')
    return res.status(200).json({ received: true })
  }

  console.log(`[Webhook] Received — UserID=${payload.UserID}, Equip=${payload.Equip}, Time=${payload.TestDatetimes}`)

  // 3. Persist the event immediately
  const event = storeEvent(payload, null, apiReady() ? 'pending' : 'skipped_no_config')

  // 4. Acknowledge InBody immediately (must respond 2xx quickly)
  res.status(200).json({ received: true })

  // 5. Asynchronously fetch full measurement data from InBody API
  if (apiReady() && payload.UserID && payload.TestDatetimes) {
    fetchInBodyData(event)
  }
})

// ─── POST /api/test-webhook ───────────────────────────────────────────────────
// Simulate an incoming webhook for local testing without a real InBody device.
app.post('/api/test-webhook', (req, res) => {
  const now = new Date()
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')

  const samplePayload = {
    EquipSerial:   'CC71700163',
    TelHP:         '01012344733',
    UserID:        req.body?.userID || 'testuser001',
    TestDatetimes: req.body?.testDatetimes || ts,
    Account:       INBODY_ACCOUNT || 'demo_account',
    Equip:         'InBody770',
    Type:          'InBody',
    IsTempData:    'false',
  }

  const event = storeEvent(samplePayload, null, apiReady() ? 'pending' : 'skipped_no_config', true)

  if (apiReady()) {
    fetchInBodyData(event)
  }

  res.json({ message: 'Test event injected', eventId: event.id })
})

// ─── GET /api/events ──────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.json(events)
})

// ─── GET /api/events/:id ──────────────────────────────────────────────────────
app.get('/api/events/:id', (req, res) => {
  const event = events.find(e => e.id === req.params.id)
  if (!event) return res.status(404).json({ error: 'Not found' })
  res.json(event)
})

// ─── DELETE /api/events ───────────────────────────────────────────────────────
app.delete('/api/events', (_req, res) => {
  events.length = 0
  res.json({ cleared: true })
})

// ─── GET /api/status ──────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json({
    apiConfigured: apiReady(),
    account:       INBODY_ACCOUNT ? INBODY_ACCOUNT : null,
    webhookUrl:    `http://localhost:${PORT}/webhook`,
    eventCount:    events.length,
  })
})

// ─── Helpers ──────────────────────────────────────────────────────────────────
function apiReady() {
  return !!(INBODY_ACCOUNT && INBODY_API_KEY)
}

function storeEvent(payload, inbodyData, fetchStatus, isTest = false) {
  const event = {
    id:          randomUUID(),
    receivedAt:  new Date().toISOString(),
    isTest,
    payload,
    inbodyData,
    fetchStatus, // 'pending' | 'success' | 'error' | 'skipped_no_config' | 'skipped_temp'
    fetchError:  null,
  }
  events.unshift(event)
  if (events.length > MAX_EVENTS) events.pop()
  return event
}

async function fetchInBodyData(event) {
  const { UserID, TestDatetimes } = event.payload
  try {
    const res = await axios.post(
      `${INBODY_API_BASE}/api/v1/InBody/GetInBodyDataByID`,
      {
        USER_ID:   UserID,
        DATETIMES: TestDatetimes,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Account':      INBODY_ACCOUNT,
          'API-KEY':      INBODY_API_KEY,
        },
        timeout: 10000,
      },
    )
    event.inbodyData  = res.data
    event.fetchStatus = 'success'
    console.log(`[InBody API] Fetched data — UserID=${UserID}`)
  } catch (err) {
    event.fetchStatus = 'error'
    event.fetchError  = err.response?.data?.errorCode || err.message
    console.error(`[InBody API] Failed — UserID=${UserID}:`, event.fetchError)
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('────────────────────────────────────────────')
  console.log(`  InBody Webhook Server`)
  console.log(`  Dashboard : http://localhost:${PORT}/`)
  console.log(`  Webhook   : POST http://localhost:${PORT}/webhook`)
  console.log(`  API ready : ${apiReady() ? 'Yes' : 'No (set INBODY_ACCOUNT and INBODY_API_KEY in .env)'}`)
  console.log('────────────────────────────────────────────')
})
