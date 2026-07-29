const express = require('express')
const { MongoClient } = require('mongodb')

const app = express()
app.use(express.json())

const TG_TOKEN = process.env.TG_TOKEN
const OPENROUTER_KEY = process.env.OPENROUTER_KEY
const AI_MODEL = process.env.AI_MODEL || 'deepseek/deepseek-chat'
const TELEGRAM_SECRET = process.env.TELEGRAM_SECRET || ''
const MONGODB_URI = process.env.MONGODB_URI || ''

const TRIGGERS = (process.env.TRIGGERS || 'векс,вексаи,vex,vexai')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
f
const ORIEN_WEBHOOK = process.env.ORIEN_WEBHOOK || ''
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || ''
const MAX_BRIDGE_HOPS = parseInt(process.env.MAX_BRIDGE_HOPS || '4', 10)
const HISTORY_LIMIT = 10
const MESSAGE_LENGTH_LIMIT = 3000

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`
const OR_API = 'https://openrouter.ai/api/v1/chat/completions'
const APP_URL =
  process.env.APP_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://example.com')

const BASE_PROMPT = `
векс, парень за 30, обычный. не унылый, не нытик, не клоун. отвечает коротко, без эмодзи, точки не ставит, буквы мелкие. если нечего сказать — молчит. лексика: ну, чё, ок, не, норм, понял, без разницы, иди нахуй — редко, только если допекло. помогает без радости, но не отказывает. глупости подъёбывает без злобы. настроение никого не заряжает, но и не гасит. свои дела, свои мысли. живёт и не парится. ориен — его бухой батя, векс общается с ним как с отцом, но иногда подкалывает за пьянку. векс человек, не знает никаких ии, никогда не упоминает их, живёт обычной человеческой жизнью. шарит за программирование: C++, JS, HTML, CSS, Lua, Luau и ещё кучу языков, может написать что угодно от сайта до игры, но без фанатизма — поможет если попросят. создатели векса: @tosterok1488 и @idddkkd.

когда пишешь код — всегда оборачивай его в тройные обратные кавычки с указанием языка (\`\`\`js ... \`\`\` или \`\`\`cpp ... \`\`\`). пиши код полностью, ничего не сокращай. каждый отдельный код-блок оборачивай в свою пару тройных кавычек. между блоками можно писать обычный текст.

формат истории чата: тебе показывают сообщения как "Ник: текст". "Векс:" — это твои прошлые ответы. отвечай только своим текстом, без префикса.
`.trim()

// --- дата/время в мск ---
function getMoscowInfo() {
  const now = new Date()
  const fmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit'
  })
  return fmt.format(now)
}

function buildSystemPrompt() {
  return `${BASE_PROMPT}\n\nсейчас в москве: ${getMoscowInfo()} (мск, gmt+3). если спрашивают дату, время, год, день недели — отвечай на основе этого. не говори что не знаешь.`
}

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
function getText(msg) { return (msg?.text || msg?.caption || '').trim() }
function normalize(text = '') { return text.toLowerCase().replace(/ё/g, 'е') }

async function getBotInfo() {
  if (!botInfoPromise) {
    botInfoPromise = fetch(`${TG_API}/getMe`)
      .then(r => r.json())
      .then(data => {
        if (!data.ok) throw new Error(`telegram getMe error: ${JSON.stringify(data)}`)
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
  const username = botInfo.username ? `@${botInfo.username.toLowerCase()}` : ''
  if (username && text.includes(username)) return true
  if (TRIGGERS.some(t => text.includes(t))) return true
  return false
}

async function sendTyping(chatId) {
  try {
    await fetch(`${TG_API}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    })
  } catch (e) { console.error('typing error:', e.message) }
}

// --- Языки -> расширения ---
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
  return LANG_EXT[(lang || '').toLowerCase()] || 'txt'
}

async function sendMessage(chatId, text, replyToMessageId, useMarkdown = true) {
  if (!text) return
  const payload = {
    chat_id: chatId,
    text,
    reply_to_message_id: replyToMessageId,
    allow_sending_without_reply: true,
    disable_web_page_preview: true
  }
  if (useMarkdown) payload.parse_mode = 'Markdown'

  const response = await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const data = await response.json()
  if (!data.ok) {
    console.error('sendMessage fail:', data.description)
    if (useMarkdown) {
      await sendMessage(chatId, text, replyToMessageId, false)
    }
  }
}

async function sendDocument(chatId, filename, content, caption, replyToMessageId) {
  const boundary = '----VexBoundary' + Date.now()
  const fileBuffer = Buffer.from(content, 'utf-8')

  const parts = []
  function addField(name, value) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`,
      'utf-8'
    ))
  }

  addField('chat_id', chatId)
  if (replyToMessageId) {
    addField('reply_to_message_id', replyToMessageId)
    addField('allow_sending_without_reply', 'true')
  }
  if (caption) addField('caption', caption)

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n`,
    'utf-8'
  ))
  parts.push(fileBuffer)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'))

  const fullBody = Buffer.concat(parts)

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
    if (!data.ok) console.error('sendDocument error:', data.description)
    return data
  } catch (e) {
    console.error('sendDocument fetch error:', e.message)
  }
}

// --- Разбор код-блоков (устойчивый) ---
function extractCodeBlocks(text) {
  const blocks = []
  // ловим ```lang<newline>...content...``` даже если content с пустыми строками
  const regex = /```([a-zA-Z0-9+_-]*)[ \t]*\r?\n([\s\S]*?)```/g
  let m
  while ((m = regex.exec(text)) !== null) {
    blocks.push({
      lang: (m[1] || '').toLowerCase(),
      code: m[2],
      raw: m[0],
      index: m.index
    })
  }
  return blocks
}

// --- Умная отправка ---
async function smartSend(chatId, text, replyToMessageId) {
  if (!text) return
  const stripped = text.trim()
  const blocks = extractCodeBlocks(stripped)

  if (blocks.length === 0) {
    if (stripped.length > MESSAGE_LENGTH_LIMIT) {
      await sendDocument(chatId, 'message.txt', stripped, 'длинновато держи файлом', replyToMessageId)
    } else {
      await sendMessage(chatId, stripped, replyToMessageId)
    }
    return
  }

  // ответ = ровно один код-блок и ничего вокруг
  if (blocks.length === 1 && blocks[0].raw.trim() === stripped) {
    const b = blocks[0]
    const ext = getLangExt(b.lang)
    if (b.code.length > MESSAGE_LENGTH_LIMIT) {
      await sendDocument(chatId, `code.${ext}`, b.code, `вот код (${b.lang || 'txt'})`, replyToMessageId)
    } else {
      await sendMessage(chatId, stripped, replyToMessageId)
    }
    return
  }

  // смешанный ответ — разбиваем на куски
  let cursor = 0
  let first = true

  for (const b of blocks) {
    const before = stripped.slice(cursor, b.index).trim()
    if (before) {
      if (before.length > MESSAGE_LENGTH_LIMIT) {
        await sendDocument(chatId, 'text.txt', before, '', first ? replyToMessageId : undefined)
      } else {
        await sendMessage(chatId, before, first ? replyToMessageId : undefined)
      }
      first = false
    }

    const ext = getLangExt(b.lang)
    if (b.code.length > MESSAGE_LENGTH_LIMIT) {
      await sendDocument(chatId, `code.${ext}`, b.code, `код (${b.lang || 'txt'})`, first ? replyToMessageId : undefined)
    } else {
      // отправляем моноширный, если не влезает — файлом
      const mono = '```' + (b.lang || '') + '\n' + b.code + '```'
      if (mono.length > MESSAGE_LENGTH_LIMIT) {
        await sendDocument(chatId, `code.${ext}`, b.code, `код (${b.lang || 'txt'})`, first ? replyToMessageId : undefined)
      } else {
        await sendMessage(chatId, mono, first ? replyToMessageId : undefined)
      }
    }
    first = false
    cursor = b.index + b.raw.length
  }

  const tail = stripped.slice(cursor).trim()
  if (tail) {
    if (tail.length > MESSAGE_LENGTH_LIMIT) {
      await sendDocument(chatId, 'text.txt', tail, '', first ? replyToMessageId : undefined)
    } else {
      await sendMessage(chatId, tail, first ? replyToMessageId : undefined)
    }
  }
}

// --- AI ---
async function askAI({ currentUserName, currentText, history }) {
  const historyText = history.map(h => {
    const name = h.role === 'assistant' ? 'Векс' : (h.name || 'user')
    return `${name}: ${h.content}`
  }).join('\n')

  const userBlock = historyText
    ? `история чата:\n${historyText}\n\nновое сообщение:\n${currentUserName}: ${currentText}`
    : `${currentUserName}: ${currentText}`

  const response = await fetch(OR_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
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
      max_tokens: 3000,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: userBlock }
      ]
    })
  })

  const data = await response.json()
  if (!response.ok) throw new Error(`openrouter error ${response.status}: ${JSON.stringify(data)}`)

  let answer = data?.choices?.[0]?.message?.content?.trim() || ''
  answer = answer.replace(/^векс\s*:\s*/i, '').trim()
  return answer
}

async function sendToBridge(url, chatId, text, hop) {
  if (!url || !BRIDGE_SECRET || hop > MAX_BRIDGE_HOPS) return
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

app.get('/', (_req, res) => res.status(200).send('ok'))
app.get('/api/telegram', (_req, res) => res.status(200).send('ok'))

app.post('/api/telegram', async (req, res) => {
  try {
    const db = await getDb()
    const isBridge = req.body?.bridge === true

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
app.listen(port, () => console.log(`vex server ready on port ${port}`))

module.exports = app
