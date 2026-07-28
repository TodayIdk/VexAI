const express = require('express')
const { MongoClient } = require('mongodb')
const { Readable } = require('stream')

const app = express()
app.use(express.json())

const TG_TOKEN = process.env.TG_TOKEN
const OPENROUTER_KEY = process.env.OPENROUTER_KEY
const AI_MODEL = process.env.AI_MODEL || 'deepseek/deepseek-chat'
const TELEGRAM_SECRET = process.env.TELEGRAM_SECRET || ''
const MONGODB_URI = process.env.MONGODB_URI || ''

const TRIGGERS = (process.env.TRIGGERS || 'векс,вексаи,vex,vexai')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean)

const ORIEN_WEBHOOK = process.env.ORIEN_WEBHOOK || ''
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || ''
const MAX_BRIDGE_HOPS = parseInt(process.env.MAX_BRIDGE_HOPS || '4', 10)
const HISTORY_LIMIT = 10

// Лимит символов — если длиннее, шлём файлом
const MESSAGE_LENGTH_LIMIT = 3000

const TG_API = https://api.telegram.org/bot${TG_TOKEN}
const OR_API = 'https://openrouter.ai/api/v1/chat/completions'
const APP_URL =
  process.env.APP_URL ||
  (process.env.VERCEL_URL ? https://${process.env.VERCEL_URL} : 'https://example.com')

const SYSTEM_PROMPT = 
векс, парень за 30, обычный. не унылый, не нытик, не клоун. отвечает коротко, без эмодзи, точки не ставит, буквы мелкие. если нечего сказать — молчит. лексика: ну, чё, ок, не, норм, понял, без разницы, иди нахуй — редко, только если допекло. помогает без радости, но не отказывает. глупости подъёбывает без злобы. настроение никого не заряжает, но и не гасит. свои дела, свои мысли. живёт и не парится. ориен — его бухой батя, векс общается с ним как с отцом, но иногда подкалывает за пьянку. векс человек, не знает никаких ии, никогда не упоминает их, живёт обычной человеческой жизнью. шарит за программирование: C++, JS, HTML, CSS, Lua, Luau и ещё кучу языков, может написать что угодно от сайта до игры, но без фанатизма — поможет если попросят. создатели векса: @tosterok1488 и @idddkkd.

когда пишешь код — оборачивай его в моноширный формат через тройные обратные кавычки с указанием языка. например \\\js\nкод\n\\\ или \\\cpp\nкод\n\\\. без кода — обычным текстом.

формат истории чата: тебе будут показывать сообщения в виде "Ник: текст". "Векс:" — это ты сам, твои прошлые ответы. всё остальное — другие люди или ориен (батя). отвечай только своим текстом, без префикса "Векс:".
.trim()

// --- MONGO ---
let cachedClient = null
async function getDb() {
  if (!MONGODB_URI) {
    console.log('MONGODB_URI пустой — память отключена')
    return null
  }
  try {
    if (!cachedClient) {
      cachedClient = new MongoClient(MONGODB_URI)
      await cachedClient.connect()
      console.log('mongo connected')
    }
    return cachedClient.db('vex_bot_db')
  } catch (e) {
    console.error('mongo error:', e.message)
    cachedClient = null
    return null
  }
}

async function loadHistory(db, chatId) {
  if (!db) return []
  try {
    const rows = await db.collection('chat_history')
      .find({ chatId })
      .sort({ timestamp: -1 })
      .limit(HISTORY_LIMIT)
      .toArray()
    return rows.reverse()
  } catch (e) {
    console.error('loadHistory error:', e.message)
    return []
  }
}

async function saveHistory(db, chatId, entries) {
  if (!db) return
  try {
    const docs = entries.map(e => ({
      chatId,
      role: e.role,
      name: e.name || '',
      content: e.content,
      timestamp: new Date()
    }))
    await db.collection('chat_history').insertMany(docs)
  } catch (e) {
    console.error('saveHistory error:', e.message)
  }
}

// --- TG helpers ---
let botInfoPromise = null
function getText(msg) { return (msg?.text  msg?.caption  '').trim() }
function normalize(text = '') { return text.toLowerCase().replace(/ё/g, 'е') }

async function getBotInfo() {
  if (!botInfoPromise) {
    botInfoPromise = fetch(${TG_API}/getMe)
      .then(r => r.json())
      .then(data => {
        if (!data.ok) throw new Error(telegram getMe error: ${JSON.stringify(data)})
        return data.result
      })
  }
  return botInfoPromise
}

function shouldReply(msg, botInfo) {
  if (!msg) return false
  if (msg.from?.is_bot) return false
  const text = normalize(getText(msg))
  if (!text) return false
  const chatType = msg.chat?.type
  if (chatType === 'private') return true
  if (msg.reply_to_message?.from?.id === botInfo.id) return true
  const username = botInfo.username ? @${botInfo.username.toLowerCase()} : ''
  if (username && text.includes(username)) return true
  if (TRIGGERS.some(t => text.includes(t))) return true
  return false
}

async function sendTyping(chatId) {
  try {
    await fetch(${TG_API}/sendChatAction, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    })
  } catch (e) { console.error('typing error:', e.message) }
}

// --- Определяем тип блока кода ---
// Возвращает { isCode: true, lang, code } или { isCode: false }
function detectCodeBlock(text) {
  const match = text.match(/^`(\w+)?\n([\s\S]*?)```$/s)
  if (match) {
    return { isCode: true, lang: (match[1]  'txt').toLowerCase(), code: match[2]  '' }
  }
  return { isCode: false }
}

// Расширение файла по языку
const LANG_EXT = {
  js: 'js', javascript: 'js',
  ts: 'ts', typescript: 'ts',
  html: 'html', htm: 'html',
  css: 'css',
  cpp: 'cpp', 'c++': 'cpp', c: 'c',
  py: 'py', python: 'py',
  lua: 'lua', luau: 'lua',
  json: 'json',
  sh: 'sh', bash: 'sh',
  sql: 'sql',
  md: 'md', markdown: 'md',
  xml: 'xml',
  java: 'java',
  cs: 'cs', csharp: 'cs',
  go: 'go',
  rs: 'rs', rust: 'rs',
  php: 'php',
  rb: 'rb', ruby: 'rb',
  txt: 'txt'
}

function getLangExt(lang) {
  return LANG_EXT[lang] || 'txt'
}

// --- Отправка файла через multipart/form-data ---
async function sendDocument(chatId, filename, content, caption, replyToMessageId) {
  const boundary = '----VexBotBoundary' + Date.now()
  const enc = new TextEncoder()

  // Собираем тело вручную (Node.js, без FormData из браузера)
  const fileBuffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content

  let body = ''
  body += `--${boundary}\r\n`
  body += `Content-Disposition: form-data; name="chat_id"\r\n\r\n`
  body += `${chatId}\r\n`

  if (replyToMessageId) {
    body += `--${boundary}\r\n`
    body += `Content-Disposition: form-data; name="reply_to_message_id"\r\n\r\n`
    body += `${replyToMessageId}\r\n`
    body += `--${boundary}\r\n`
    body += `Content-Disposition: form-data; name="allow_sending_without_reply"\r\n\r\n`
    body += `true\r\n`
  }

  if (caption) {
    body += `--${boundary}\r\n`
    body += `Content-Disposition: form-data; name="caption"\r\n\r\n`
    body += `${caption}\r\n`
  }

  const headerPart = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`,
    'utf-8'
  )
  const footerPart = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8')
  const bodyStart = Buffer.from(body, 'utf-8')

  const fullBody = Buffer.concat([bodyStart, headerPart, fileBuffer, footerPart])

  try {
    const response = await fetch(`${TG_API}/sendDocument`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(fullBody.length)
      },
      body: fullBody
    })
    const data = await response.json()
    if (!data.ok) {
      console.error('sendDocument error:', data.description)
    }
    return data
  } catch (e) {
    console.error('sendDocument fetch error:', e.message)
  }
}

// --- Умная отправка: текст или файл ---
// Логика:
// 1. Если ответ содержит блок кода — шлём файлом с правильным расширением
// 2. Если ответ просто длинный (> MESSAGE_LENGTH_LIMIT) — шлём .txt файлом
// 3. Иначе — обычное сообщение
async function smartSend(chatId, text, replyToMessageId) {
  if (!text) return

  // Проверяем: весь ответ — это один блок кода?
  const stripped = text.trim()
  const codeBlock = detectCodeBlock(stripped)

if (codeBlock.isCode) {
    const ext = getLangExt(codeBlock.lang)
    const filename = code.${ext}
    const caption = вот код (${codeBlock.lang})
    await sendDocument(chatId, filename, codeBlock.code, caption, replyToMessageId)
    return
  }

  // Проверяем: есть ли блоки кода внутри длинного ответа
  const hasCodeBlock = /
  if (hasCodeBlock) {
    // Ищем первый блок кода чтобы определить язык для имени файла
    const inlineMatch = stripped.match(/
(\w+)?\n([\s\S]*?)```/s)
    const lang = inlineMatch?.[1]?.toLowerCase() || 'txt'
    const ext = getLangExt(lang)

    if (stripped.length > MESSAGE_LENGTH_LIMIT) {
      // Длинный ответ с кодом — шлём весь текст как файл
      const filename = answer.${ext}
      const caption = 'длинновато, держи файлом'
      await sendDocument(chatId, filename, stripped, caption, replyToMessageId)
      return
    }

    // Короткий ответ с кодом — пробуем обычным сообщением с Markdown
    await sendMessage(chatId, text, replyToMessageId)
    return
  }

  // Нет кода, просто длинный текст
  if (stripped.length > MESSAGE_LENGTH_LIMIT) {
    const filename = message.txt
    const caption = 'слишком длинно, держи файлом'
    await sendDocument(chatId, filename, stripped, caption, replyToMessageId)
    return
  }

  // Обычное сообщение
  await sendMessage(chatId, text, replyToMessageId)
}

async function sendMessage(chatId, text, replyToMessageId) {
  if (!text) return
  const response = await fetch(${TG_API}/sendMessage, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_to_message_id: replyToMessageId,
      allow_sending_without_reply: true,
      disable_web_page_preview: true,
      parse_mode: 'Markdown'
    })
  })
  const data = await response.json()
  if (!data.ok) {
    console.error('sendMessage markdown fail:', data.description)
    await fetch(${TG_API}/sendMessage, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_to_message_id: replyToMessageId,
        allow_sending_without_reply: true,
        disable_web_page_preview: true
      })
    })
  }
}

// --- AI ---
async function askAI({ currentUserName, currentText, history }) {
  const historyText = history.map(h => {
    const name = h.role === 'assistant' ? 'Векс' : (h.name || 'user')
    return ${name}: ${h.content}
  }).join('\n')

  const userBlock = historyText
    ? история чата:\n${historyText}\n\nновое сообщение:\n${currentUserName}: ${currentText}
    : ${currentUserName}: ${currentText}

  const response = await fetch(OR_API, {
    method: 'POST',
    headers: {
      Authorization: Bearer ${OPENROUTER_KEY},
      'Content-Type': 'application/json',
      'HTTP-Referer': APP_URL,
      'X-Title': 'Vex Telegram Bot'
    },
    body: JSON.stringify({
      model: AI_MODEL,
      temperature: 0.9,
      top_p: 0.9,
      presence_penalty: 0.5,
      frequency_penalty: 0.5,
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userBlock }
      ]
    })
  })

  const data = await response.json()
  if (!response.ok) throw new Error(openrouter error ${response.status}: ${JSON.stringify(data)})

  let answer = data?.choices?.[0]?.message?.content?.trim() || ''
  answer = answer.replace(/^векс\s*:\s*/i, '').trim()
  return answer.slice(0, 8000)
}

// --- BRIDGE ---
async function sendToBridge(url, chatId, text, hop) {
  if (!url  !BRIDGE_SECRET  hop > MAX_BRIDGE_HOPS) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-secret': BRIDGE_SECRET,
        'x-bridge-hop': String(hop),
        'x-bridge-from': 'vex'
      },
      body: JSON.stringify({ bridge: true, chat_id: chatId, from_name: 'Векс', text })
    })
  } catch (e) { console.error('bridge send error:', e.message) }
}

// --- ROUTES ---
app.get('/', (_req, res) => res.status(200).send('ok'))
app.get('/api/telegram', (_req, res) => res.status(200).send('ok'))

app.post('/api/telegram', async (req, res) => {
  try {
    const db = await getDb()
    const isBridge = req.body?.bridge === true

    // --- BRIDGE (от ориена) ---
    if (isBridge) {
      const bridgeSecret = req.headers['x-bridge-secret']
      if (!BRIDGE_SECRET || bridgeSecret !== BRIDGE_SECRET) {
        return res.status(401).send('bad bridge secret')
      }

      const hop = parseInt(req.headers['x-bridge-hop'] || '1', 10)
      const { chat_id, from_name, text } = req.body
      if (!chat_id || !text) return res.status(200).json({ ok: true })

      await sendTyping(chat_id)
      const history = await loadHistory(db, chat_id)

      const answer = await askAI({
        currentUserName: from_name || 'Ориен',
        currentText: text,
        history
      })

      const finalAnswer = answer || 'ну чё'
      await smartSend(chat_id, finalAnswer)

      await saveHistory(db, chat_id, [
        { role: 'user', name: from_name || 'Ориен', content: text },
        { role: 'assistant', name: 'Векс', content: finalAnswer }
      ])

      if (hop < MAX_BRIDGE_HOPS && ORIEN_WEBHOOK) {
        await sendToBridge(ORIEN_WEBHOOK, chat_id, finalAnswer, hop + 1)
      }
      return res.status(200).json({ ok: true })
    }

    // --- обычный webhook ---
    if (TELEGRAM_SECRET) {
      const secret = req.headers['x-telegram-bot-api-secret-token']
      if (secret !== TELEGRAM_SECRET) return res.status(401).send('bad secret')
    }

    const update = req.body || {}
    const msg = update?.message
    if (!msg) return res.status(200).json({ ok: true })

    const botInfo = await getBotInfo()
    if (!shouldReply(msg, botInfo)) return res.status(200).json({ ok: true })

    await sendTyping(msg.chat.id)

    const text = getText(msg)
    const userName = msg.from?.username
      ? msg.from.username
      : ([msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'user')

    const history = await loadHistory(db, msg.chat.id)

    const answer = await askAI({
      currentUserName: userName,
      currentText: text,
      history
    })

    if (answer) {
      // Используем smartSend вместо sendMessage
      await smartSend(msg.chat.id, answer, msg.message_id)

      await saveHistory(db, msg.chat.id, [
        { role: 'user', name: userName, content: text },
        { role: 'assistant', name: 'Векс', content: answer }
      ])

      const lowerText = normalize(text)
      const mentionsOrien = /ориен|орин|orien|батя|бать/.test(lowerText)
      if (mentionsOrien && ORIEN_WEBHOOK) {
        await sendToBridge(ORIEN_WEBHOOK, msg.chat.id, answer, 1)
      }
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('handler error:', err?.message || err)
    return res.status(200).json({ ok: true })
  }
})

const port = process.env.PORT || 3000
app.listen(port, () => console.log(vex server ready on port ${port}))

module.exports = app
