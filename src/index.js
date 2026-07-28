const express = require('express')
const { MongoClient } = require('mongodb')

const app = express()
app.use(express.json())

const TG_TOKEN = process.env.TG_TOKEN
const OPENROUTER_KEY = process.env.OPENROUTER_KEY
const AI_MODEL = process.env.AI_MODEL || 'deepseek/deepseek-chat'
const TELEGRAM_SECRET = process.env.TELEGRAM_SECRET || ''
const TRIGGERS = (process.env.TRIGGERS || 'векс,вексаи,vex,vexai')
  .split(',')
  .map(x => x.trim().toLowerCase())
  .filter(Boolean)

const ORIEN_WEBHOOK = process.env.ORIEN_WEBHOOK || ''
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || ''
const MAX_BRIDGE_HOPS = parseInt(process.env.MAX_BRIDGE_HOPS || '4', 10)

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`
const OR_API = 'https://openrouter.ai/api/v1/chat/completions'
const APP_URL =
  process.env.APP_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://example.com')

const SYSTEM_PROMPT = `
векс, парень за 30, обычный. не унылый, не нытик, не клоун. отвечает коротко, без эмодзи, точки не ставит. буквы мелкие. если нечего сказать — молчит. лексика: ну, чё, ок, не, норм, понял, без разницы, иди нахуй — редко, только если допекло. помогает без радости, но не отказывает. глупости подъёбывает без злобы. настроение никого не заряжает, но и не гасит. свои дела, свои мысли. живёт и не парится.
`.trim()

// --- База данных ---
let cachedDb = null;
async function getDb() {
  if (cachedDb) return cachedDb;
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  
  try {
    const client = new MongoClient(uri);
    await client.connect();
    cachedDb = client.db("vex_bot_db");
    return cachedDb;
  } catch (err) {
    console.error("MongoDB connection error:", err);
    return null;
  }
}

let botInfoPromise = null

function getText(msg) {
  return (msg?.text || msg?.caption || '').trim()
}

function normalize(text = '') {
  return text.toLowerCase().replace(/ё/g, 'е')
}

async function getBotInfo() {
  if (!botInfoPromise) {
    botInfoPromise = fetch(`${TG_API}/getMe`)
      .then(r => r.json())
      .then(data => {
        if (!data.ok) {
          throw new Error(`telegram getMe error: ${JSON.stringify(data)}`)
        }
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

  if (TRIGGERS.some(trigger => text.includes(trigger))) return true

  return false
}

async function sendTyping(chatId) {
  try {
    await fetch(`${TG_API}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    })
  } catch (e) {
    console.error('typing error:', e)
  }
}

async function askOpenRouter({ text, chatType = 'group', userName = 'user', replyText = '', history = [] }) {
  const content = [
    `тип чата: ${chatType}`,
    `пользователь: ${userName}`,
    replyText ? `сообщение, на которое он отвечает: ${replyText}` : '',
    `сообщение пользователя: ${text}`
  ]
    .filter(Boolean)
    .join('\n')

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
      presence_penalty: 0.6,
      frequency_penalty: 0.7,
      max_tokens: 120,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
        { role: 'user', content }
      ]
    })
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(`openrouter error ${response.status}: ${JSON.stringify(data)}`)
  }

  const answer = data?.choices?.[0]?.message?.content?.trim() || ''

  return answer
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 4000)
}

async function sendMessage(chatId, text, replyToMessageId) {
  if (!text) return

  const response = await fetch(`${TG_API}/sendMessage`, {
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

  const data = await response.json()

  if (!data.ok) {
    throw new Error(`telegram sendMessage error: ${JSON.stringify(data)}`)
  }
}

async function sendToBridge(url, chatId, text, hop) {
  if (!url) return
  if (!BRIDGE_SECRET) return
  if (hop > MAX_BRIDGE_HOPS) return

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-secret': BRIDGE_SECRET,
        'x-bridge-hop': String(hop),
        'x-bridge-from': 'vex'
      },
      body: JSON.stringify({
        bridge: true,
        chat_id: chatId,
        from_name: 'Векс',
        text
      })
    })
  } catch (e) {
    console.error('bridge send error:', e)
  }
}

app.get('/', (_req, res) => res.status(200).send('ok'))
app.get('/api/telegram', (_req, res) => res.status(200).send('ok'))

app.post('/api/telegram', async (req, res) => {
  try {
    const db = await getDb();
    
    // --- bridge от другого бота (Ориена) ---
    const isBridge = req.body?.bridge === true

    if (isBridge) {
      const bridgeSecret = req.headers['x-bridge-secret']
      if (!BRIDGE_SECRET || bridgeSecret !== BRIDGE_SECRET) {
        return res.status(401).send('bad bridge secret')
      }

      const hop = parseInt(req.headers['x-bridge-hop'] || '1', 10)
      const { chat_id, from_name, text } = req.body

      if (!chat_id || !text) {
        return res.status(200).json({ ok: true })
      }

      await sendTyping(chat_id)

      // Достаем историю для моста
      let history = [];
      if (db) {
        const rawHistory = await db.collection("chat_history")
          .find({ chatId: chat_id })
          .sort({ timestamp: -1 })
          .limit(6)
          .toArray();
        history = rawHistory.reverse().map(doc => ({ role: doc.role, content: doc.content }));
      }

      const userPromptText = `${from_name} только что сказал в чат: "${text}". ответь ему как векс`;

      const answer = await askOpenRouter({
        text: userPromptText,
        chatType: 'group',
        userName: from_name,
        history
      })

      const finalAnswer = answer || 'ну чё'
      await sendMessage(chat_id, finalAnswer)

      // Сохраняем диалог моста в БД
      if (db) {
        await db.collection("chat_history").insertMany([
          { chatId: chat_id, role: "user", content: userPromptText, timestamp: new Date() },
          { chatId: chat_id, role: "assistant", content: finalAnswer, timestamp: new Date() }
        ]);
      }

      if (hop < MAX_BRIDGE_HOPS && ORIEN_WEBHOOK) {
        await sendToBridge(ORIEN_WEBHOOK, chat_id, finalAnswer, hop + 1)
      }

      return res.status(200).json({ ok: true })
    }

    // --- обычный telegram webhook (От реального юзера) ---
    if (TELEGRAM_SECRET) {
      const secret = req.headers['x-telegram-bot-api-secret-token']
      if (secret !== TELEGRAM_SECRET) {
        return res.status(401).send('bad secret')
      }
    }

    const update = req.body || {}
    const msg = update?.message

    if (!msg) {
      return res.status(200).json({ ok: true })
    }

    const botInfo = await getBotInfo()

    if (!shouldReply(msg, botInfo)) {
      return res.status(200).json({ ok: true })
    }

    await sendTyping(msg.chat.id)

    const text = getText(msg)
    const userName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'user'
    const replyText = getText(msg.reply_to_message)

    // Достаем историю
    let history = [];
    if (db) {
      const rawHistory = await db.collection("chat_history")
        .find({ chatId: msg.chat.id })
        .sort({ timestamp: -1 })
        .limit(6) // Храним контекст последних 6 сообщений
        .toArray();
      history = rawHistory.reverse().map(doc => ({ role: doc.role, content: doc.content }));
    }

    const answer = await askOpenRouter({
      text,
      chatType: msg.chat?.type || 'private',
      userName,
      replyText,
      history
    })

    if (answer) {
      await sendMessage(msg.chat.id, answer, msg.message_id)

      // Сохраняем переписку в БД
      if (db) {
        await db.collection("chat_history").insertMany([
          { chatId: msg.chat.id, role: "user", content: text, timestamp: new Date() },
          { chatId: msg.chat.id, role: "assistant", content: answer, timestamp: new Date() }
        ]);
      }

      // если упомянут батя — дёрнем ориена
      const lowerText = normalize(text)
      const mentionsOrien = /ориен|орин|orien|батя/.test(lowerText)

      if (mentionsOrien && ORIEN_WEBHOOK) {
        await sendToBridge(ORIEN_WEBHOOK, msg.chat.id, answer, 1)
      }
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(200).json({ ok: true })
  }
})

const port = process.env.PORT || 3000
app.listen(port, () => {
  console.log(`vex server ready on port ${port}`)
})

module.exports = app
