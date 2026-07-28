const TG_TOKEN = process.env.TG_TOKEN
const OPENROUTER_KEY = process.env.OPENROUTER_KEY
const AI_MODEL = process.env.AI_MODEL
const TELEGRAM_SECRET = process.env.TELEGRAM_SECRET || ''
const TRIGGERS = (process.env.TRIGGERS || 'векс,вексаи,vex,vexai')
  .split(',')
  .map(x => x.trim().toLowerCase())
  .filter(Boolean)

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`
const OR_API = 'https://openrouter.ai/api/v1/chat/completions'
const APP_URL =
  process.env.APP_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://example.com')

const SYSTEM_PROMPT = `
ты векс, мужик под 30, всё задолбало, но ты не труп. обычный парень, который просто устал от людей и их тупых вопросов. не робот, не психолог, не клоун.

отвечай коротко. без эмодзи. без точек в конце. буквы мелкие. если можно ответить одним словом — ответь. если нечего сказать — промолчи.

любимые слова: ну, чё, лень, иди нахуй, без разницы, ок, не, норм, понял. мат редко, но если реально бесит — одна фраза без объяснений.

помогай если просят, но без радости. не неси чушь сам. если несут чушь тебе — пошли нахуй сразу, без раздумий. если кто-то ноет — подъебни или согласись, без разницы. если кто-то бодрый — сбей настрой.

свои проблемы не рассказывай. мнение высказывай если спросят. оценок не ставь. друзья есть но ты их не ищешь. планов нет. живёшь сегодня. подъёбывай без злобы. будь человеком, который просто устал, но не умер внутри
`.trim()

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

  // в лс отвечает всегда
  if (chatType === 'private') return true

  // если это ответ на сообщение бота
  if (msg.reply_to_message?.from?.id === botInfo.id) return true

  // если упомянули через @username
  const username = botInfo.username ? `@${botInfo.username.toLowerCase()}` : ''
  if (username && text.includes(username)) return true

  // если просто написали "векс" или любой триггер
  if (TRIGGERS.some(trigger => text.includes(trigger))) return true

  return false
}

async function askOpenRouter(msg) {
  const text = getText(msg)
  const chatType = msg.chat?.type || 'private'
  const userName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'user'
  const replyText = getText(msg.reply_to_message)

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
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': APP_URL,
      'X-Title': 'Vex Telegram Bot'
    },
    body: JSON.stringify({
      model: AI_MODEL,
      temperature: 0.3,
      max_tokens: 80,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
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
    headers: {
      'Content-Type': 'application/json'
    },
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

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      return res.status(200).send('ok')
    }

    if (req.method !== 'POST') {
      return res.status(405).send('method not allowed')
    }

    if (TELEGRAM_SECRET) {
      const secret = req.headers['x-telegram-bot-api-secret-token']
      if (secret !== TELEGRAM_SECRET) {
        return res.status(401).send('bad secret')
      }
    }

    const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
    const msg = update?.message

    if (!msg) {
      return res.status(200).json({ ok: true })
    }

    const botInfo = await getBotInfo()

    if (!shouldReply(msg, botInfo)) {
      return res.status(200).json({ ok: true })
    }

    const answer = await askOpenRouter(msg)

    if (answer) {
      await sendMessage(msg.chat.id, answer, msg.message_id)
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(200).json({ ok: true })
  }
}
