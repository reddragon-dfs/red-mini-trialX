const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');
const axios = require('axios');
const cheerio = require('cheerio');
const yts = require('yt-search');
const { exec } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  getContentType,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  downloadContentFromMessage,
  DisconnectReason
} = require('@whiskeysockets/baileys');

// ========== CONFIGURATION ==========
const BOT_NAME = 'Red Mini';
const OWNER_NUMBER = '27634988678';
const NEWSLETTER_JID = '120363427119111004@newsletter';
const FOOTER = '© ʀᴇᴅ ᴅʀᴀɢᴏɴ ᴅғs';
const BOT_IMAGE = 'https://files.catbox.moe/eumprt.jpg';

const config = {
  AUTO_VIEW_STATUS: 'true',
  AUTO_LIKE_STATUS: 'true',
  AUTO_RECORDING: 'false',
  AUTO_LIKE_EMOJI: ['🔥', '❤️', '👍', '😎', '🥳'],
  PREFIX: '.',
  MAX_RETRIES: 3,
  OTP_EXPIRY: 300000,
  BOT_NAME: BOT_NAME,
  OWNER_NAME: 'Red Dragon',
  OWNER_NUMBER: OWNER_NUMBER,
  BOT_VERSION: '1.0.0',
  BOT_FOOTER: FOOTER,
  RCD_IMAGE_PATH: BOT_IMAGE
};

// ========== SUPABASE SETUP ==========
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
}

const supabase = createClient(supabaseUrl || '', supabaseKey || '');

// ========== SUPABASE HELPERS ==========
async function saveCredsToSupabase(number, creds, keys = null) {
  const sanitized = number.replace(/[^0-9]/g, '');
  await supabase.from('sessions').upsert({
    number: sanitized,
    creds,
    keys,
    updated_at: new Date()
  });
}

async function loadCredsFromSupabase(number) {
  const sanitized = number.replace(/[^0-9]/g, '');
  const { data } = await supabase.from('sessions').select('*').eq('number', sanitized).single();
  return data || null;
}

async function removeSessionFromSupabase(number) {
  const sanitized = number.replace(/[^0-9]/g, '');
  await supabase.from('sessions').delete().eq('number', sanitized);
  await supabase.from('numbers').delete().eq('number', sanitized);
}

async function addNumberToSupabase(number) {
  const sanitized = number.replace(/[^0-9]/g, '');
  await supabase.from('numbers').upsert({ number: sanitized });
}

async function getAllNumbersFromSupabase() {
  const { data } = await supabase.from('numbers').select('number');
  return data ? data.map(d => d.number) : [];
}

async function loadUserConfigFromSupabase(number) {
  const sanitized = number.replace(/[^0-9]/g, '');
  const { data } = await supabase.from('configs').select('config').eq('number', sanitized).single();
  return data ? data.config : null;
}

async function setUserConfigInSupabase(number, configObj) {
  const sanitized = number.replace(/[^0-9]/g, '');
  await supabase.from('configs').upsert({ number: sanitized, config: configObj, updated_at: new Date() });
}

async function listNewslettersFromSupabase() {
  const { data } = await supabase.from('newsletters').select('*');
  return data ? data.map(d => ({ jid: d.jid, emojis: d.emojis || [] })) : [];
}

// ========== UTILS ==========
function getSouthAfricaTimestamp() {
  return moment().tz('Africa/Johannesburg').format('YYYY-MM-DD HH:mm:ss');
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function downloadQuotedMedia(quoted) {
  if (!quoted) return null;
  const qTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
  const qType = qTypes.find(t => quoted[t]);
  if (!qType) return null;
  const messageType = qType.replace(/Message$/i, '').toLowerCase();
  const stream = await downloadContentFromMessage(quoted[qType], messageType);
  let buffer = Buffer.from([]);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }
  return {
    buffer,
    mime: quoted[qType].mimetype || '',
    caption: quoted[qType].caption || quoted[qType].fileName || '',
    ptt: quoted[qType].ptt || false,
    fileName: quoted[qType].fileName || ''
  };
}

// ========== ACTIVE SESSIONS ==========
const activeSockets = new Map();
const socketCreationTime = new Map();

// ========== COMMAND HANDLER ==========
function setupCommandHandlers(socket, sessionNumber) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message || msg.key.remoteJid === 'status@broadcast') return;

    const type = getContentType(msg.message);
    let body = '';

    if (type === 'conversation') body = msg.message.conversation || '';
    else if (type === 'extendedTextMessage') body = msg.message.extendedTextMessage.text || '';
    else if (type === 'imageMessage') body = msg.message.imageMessage.caption || '';
    else if (type === 'videoMessage') body = msg.message.videoMessage.caption || '';
    else if (type === 'buttonsResponseMessage') body = msg.message.buttonsResponseMessage?.selectedButtonId || '';

    if (!body || typeof body !== 'string') return;

    const from = msg.key.remoteJid;
    const sender = msg.key.fromMe ? socket.user.id.split(':')[0] + '@s.whatsapp.net' : (msg.key.participant || msg.key.remoteJid);
    const senderNumber = sender.split('@')[0];
    const prefix = config.PREFIX;
    const isCmd = body.startsWith(prefix);
    const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : null;
    const args = body.trim().split(/ +/).slice(1);

    if (!command) return;

    try {
      // ========== MENU COMMAND ==========
      if (command === 'menu') {
        await socket.sendMessage(from, { react: { text: '🔴', key: msg.key } });

        const uptime = Math.floor((Date.now() - (socketCreationTime.get(sessionNumber) || Date.now())) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);

        const menuText = `╭───❰ 🔴 RED MINI BOT 🔴 ❱───╮
│
│ 🤖 *Name:* Red Mini
│ 👑 *Owner:* ${OWNER_NUMBER}
│ ⏱️ *Uptime:* ${hours}h ${minutes}m ${seconds}s
│ 📡 *Status:* Active
│ 🇿🇦 *Region:* South Africa
│
╰─────────────────────╯

╭───❰ 📥 DOWNLOADER ❱───╮
│ 🎵 ${prefix}play <song>
│ 🎬 ${prefix}video <name>
│ 🎨 ${prefix}sticker
│ 📘 ${prefix}fb <url>
│ 📸 ${prefix}ig <url>
│ 📹 ${prefix}tt <url>
╰─────────────────────╯

╭───❰ 🛠️ TOOLS ❱───╮
│ 🌤️ ${prefix}weather <city>
│ 📝 ${prefix}tr <lang> <text>
│ 🔗 ${prefix}short <url>
│ 🧮 ${prefix}calc <math>
│ 🆔 ${prefix}jid
│ 💾 ${prefix}save
╰─────────────────────╯

╭───❰ ⚙️ INFO ❱───╮
│ 🤖 ${prefix}alive
│ ⚡ ${prefix}ping
│ 👤 ${prefix}profile
│ 📊 ${prefix}stats
╰─────────────────────╯

${FOOTER}`;

        await socket.sendMessage(from, {
          image: { url: BOT_IMAGE },
          caption: menuText
        }, { quoted: msg });
      }

      // ========== ALIVE COMMAND ==========
      else if (command === 'alive') {
        const uptime = Math.floor((Date.now() - (socketCreationTime.get(sessionNumber) || Date.now())) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);

        const aliveText = `🔴 *RED MINI IS ONLINE* 🔴
━━━━━━━━━━━━━━━━━━
🤖 *Bot:* Red Mini
👑 *Owner:* ${OWNER_NUMBER}
⏱️ *Uptime:* ${hours}h ${minutes}m ${seconds}s
📡 *Status:* Active
🇿🇦 *Region:* South Africa
━━━━━━━━━━━━━━━━━━
${FOOTER}`;

        await socket.sendMessage(from, {
          image: { url: BOT_IMAGE },
          caption: aliveText
        }, { quoted: msg });
      }

      // ========== PING COMMAND ==========
      else if (command === 'ping') {
        const start = Date.now();
        await socket.sendMessage(from, { react: { text: '⏳', key: msg.key } });
        const latency = Date.now() - start;
        const pingText = `⚡ *PONG!*\n━━━━━━━━━━━━━━━━━━\n📡 *Latency:* ${latency}ms\n🚀 *Speed:* ${latency < 100 ? 'Excellent' : latency < 300 ? 'Good' : 'Slow'}\n━━━━━━━━━━━━━━━━━━\n${FOOTER}`;
        await socket.sendMessage(from, { text: pingText }, { quoted: msg });
      }

      // ========== PROFILE COMMAND ==========
      else if (command === 'profile') {
        const profileText = `👤 *Red Mini Bot Profile*
━━━━━━━━━━━━━━━━━━
🤖 *Name:* Red Mini
👑 *Owner:* ${OWNER_NUMBER}
📢 *Newsletter:* ${NEWSLETTER_JID}
🔢 *Prefix:* ${prefix}
🇿🇦 *Region:* South Africa
📡 *Status:* Active
━━━━━━━━━━━━━━━━━━
${FOOTER}`;

        await socket.sendMessage(from, {
          image: { url: BOT_IMAGE },
          caption: profileText
        }, { quoted: msg });
      }

      // ========== STATS COMMAND ==========
      else if (command === 'stats') {
        const totalSessions = activeSockets.size;
        const statsText = `📊 *Bot Statistics*
━━━━━━━━━━━━━━━━━━
🤖 *Bot Name:* Red Mini
📱 *Active Sessions:* ${totalSessions}
📡 *Status:* Online
🇿🇦 *Region:* South Africa
━━━━━━━━━━━━━━━━━━
${FOOTER}`;
        await socket.sendMessage(from, { text: statsText }, { quoted: msg });
      }

      // ========== JID COMMAND ==========
      else if (command === 'jid') {
        await socket.sendMessage(from, {
          text: `🆔 *Your JID Info*\n━━━━━━━━━━━━━━━━━━\n📱 JID: ${sender}\n🔢 Number: +${senderNumber}\n📡 Type: ${from.endsWith('@g.us') ? 'Group' : 'Private Chat'}\n━━━━━━━━━━━━━━━━━━\n${FOOTER}`
        }, { quoted: msg });
      }

      // ========== STICKER COMMAND ==========
      else if (command === 'sticker' || command === 's') {
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const mime = msg.message?.imageMessage?.mimetype || quoted?.imageMessage?.mimetype || msg.message?.videoMessage?.mimetype || quoted?.videoMessage?.mimetype;

        if (!mime) {
          await socket.sendMessage(from, { text: '❌ Reply to an image or video!' }, { quoted: msg });
          return;
        }

        try {
          let media = await downloadQuotedMedia(msg.message?.imageMessage ? msg.message : quoted);
          let buffer = media.buffer;
          const ran = generateOTP();
          const pathIn = `./${ran}.${mime.split('/')[1]}`;
          const pathOut = `./${ran}.webp`;

          fs.writeFileSync(pathIn, buffer);

          const ffmpegCmd = `ffmpeg -i ${pathIn} -vcodec libwebp -filter:v fps=fps=20 -lossless 1 -loop 0 -preset default -an -vsync 0 -s 512:512 ${pathOut}`;

          exec(ffmpegCmd, async (err) => {
            fs.unlinkSync(pathIn);
            if (err) {
              await socket.sendMessage(from, { text: '❌ Failed to create sticker' }, { quoted: msg });
              return;
            }
            await socket.sendMessage(from, { sticker: fs.readFileSync(pathOut) }, { quoted: msg });
            fs.unlinkSync(pathOut);
          });
        } catch (e) {
          await socket.sendMessage(from, { text: '❌ Error creating sticker' }, { quoted: msg });
        }
      }

      // ========== PLAY COMMAND ==========
      else if (command === 'play') {
        const query = args.join(' ');
        if (!query) {
          await socket.sendMessage(from, { text: '🎵 *Usage:* .play <song name>' }, { quoted: msg });
          return;
        }

        await socket.sendMessage(from, { react: { text: '🎵', key: msg.key } });

        try {
          const search = await yts(query);
          if (!search.videos.length) {
            await socket.sendMessage(from, { text: '❌ No results found!' }, { quoted: msg });
            return;
          }

          const video = search.videos[0];
          const apiUrl = `https://api.dreaded.site/api/ytdl/audio?url=${video.url}`;
          const { data } = await axios.get(apiUrl);

          if (!data.result?.downloadUrl) {
            await socket.sendMessage(from, { text: '❌ Failed to get audio' }, { quoted: msg });
            return;
          }

          const caption = `🎵 *${video.title}*\n⏱️ Duration: ${video.timestamp}\n👀 Views: ${video.views}\n\n${FOOTER}`;

          await socket.sendMessage(from, {
            image: { url: video.thumbnail },
            caption: caption
          }, { quoted: msg });

          await socket.sendMessage(from, {
            audio: { url: data.result.downloadUrl },
            mimetype: 'audio/mpeg',
            ptt: false
          }, { quoted: msg });
        } catch (err) {
          await socket.sendMessage(from, { text: `❌ Error: ${err.message}` }, { quoted: msg });
        }
      }

      // ========== VIDEO COMMAND ==========
      else if (command === 'video') {
        const query = args.join(' ');
        if (!query) {
          await socket.sendMessage(from, { text: '🎬 *Usage:* .video <video name>' }, { quoted: msg });
          return;
        }

        await socket.sendMessage(from, { react: { text: '🎬', key: msg.key } });

        try {
          const search = await yts(query);
          if (!search.videos.length) {
            await socket.sendMessage(from, { text: '❌ No results found!' }, { quoted: msg });
            return;
          }

          const video = search.videos[0];
          const apiUrl = `https://api.dreaded.site/api/ytdl/video?url=${video.url}`;
          const { data } = await axios.get(apiUrl);

          if (!data.result?.downloadUrl) {
            await socket.sendMessage(from, { text: '❌ Failed to get video' }, { quoted: msg });
            return;
          }

          const caption = `🎬 *${video.title}*\n⏱️ Duration: ${video.timestamp}\n👀 Views: ${video.views}\n\n${FOOTER}`;

          await socket.sendMessage(from, {
            video: { url: data.result.downloadUrl },
            caption: caption,
            mimetype: 'video/mp4'
          }, { quoted: msg });
        } catch (err) {
          await socket.sendMessage(from, { text: `❌ Error: ${err.message}` }, { quoted: msg });
        }
      }

      // ========== WEATHER COMMAND ==========
      else if (command === 'weather') {
        const city = args.join(' ');
        if (!city) {
          await socket.sendMessage(from, { text: '🌤️ *Usage:* .weather <city name>' }, { quoted: msg });
          return;
        }

        try {
          const apiKey = '2d61a72574c11c4f36173b627f8cb177';
          const url = `http://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`;
          const { data } = await axios.get(url);

          const weatherText = `🌤️ *Weather in ${data.name}, ${data.sys.country}*
━━━━━━━━━━━━━━━━━━
🌡️ *Temperature:* ${data.main.temp}°C
💧 *Humidity:* ${data.main.humidity}%
🌬️ *Wind:* ${data.wind.speed} m/s
☁️ *Condition:* ${data.weather[0].description}
━━━━━━━━━━━━━━━━━━
${FOOTER}`;

          await socket.sendMessage(from, { text: weatherText }, { quoted: msg });
        } catch (err) {
          await socket.sendMessage(from, { text: '❌ City not found!' }, { quoted: msg });
        }
      }

      // ========== TRANSLATE COMMAND ==========
      else if (command === 'translate' || command === 'tr') {
        const lang = args[0] || 'af';
        const text = args.slice(1).join(' ') || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation;

        if (!text) {
          await socket.sendMessage(from, { text: '📝 *Usage:* .tr af Hello' }, { quoted: msg });
          return;
        }

        try {
          const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`;
          const { data } = await axios.get(url);
          const translated = data[0][0][0];

          await socket.sendMessage(from, {
            text: `📝 *Translation (${lang.toUpperCase()})*\n━━━━━━━━━━━━━━━━━━\n📌 Original: ${text}\n🔄 Translated: ${translated}\n━━━━━━━━━━━━━━━━━━\n${FOOTER}`
          }, { quoted: msg });
        } catch (err) {
          await socket.sendMessage(from, { text: '❌ Translation failed' }, { quoted: msg });
        }
      }

      // ========== SHORTEN URL ==========
      else if (command === 'short') {
        const link = args[0];
        if (!link) {
          await socket.sendMessage(from, { text: '🔗 *Usage:* .short <url>' }, { quoted: msg });
          return;
        }

        try {
          const { data } = await axios.get(`https://tinyurl.com/api-create.php?url=${link}`);
          await socket.sendMessage(from, {
            text: `🔗 *URL Shortened*\n━━━━━━━━━━━━━━━━━━\n🔗 Original: ${link}\n📎 Shortened: ${data}\n━━━━━━━━━━━━━━━━━━\n${FOOTER}`
          }, { quoted: msg });
        } catch (err) {
          await socket.sendMessage(from, { text: '❌ Failed to shorten URL' }, { quoted: msg });
        }
      }

      // ========== CALCULATE ==========
      else if (command === 'calc') {
        const expr = args.join(' ');
        if (!expr) {
          await socket.sendMessage(from, { text: '🧮 *Usage:* .calc 2+2*5' }, { quoted: msg });
          return;
        }

        try {
          const result = new Function('return ' + expr)();
          await socket.sendMessage(from, {
            text: `🧮 *Calculator*\n━━━━━━━━━━━━━━━━━━\n📌 Question: ${expr}\n✅ Answer: ${result}\n━━━━━━━━━━━━━━━━━━\n${FOOTER}`
          }, { quoted: msg });
        } catch (err) {
          await socket.sendMessage(from, { text: '❌ Invalid expression' }, { quoted: msg });
        }
      }

      // ========== FACEBOOK DOWNLOADER ==========
      else if (command === 'fb' || command === 'facebook') {
        const url = args[0];
        if (!url) {
          await socket.sendMessage(from, { text: '📘 *Usage:* .fb <facebook video url>' }, { quoted: msg });
          return;
        }

        await socket.sendMessage(from, { react: { text: '📘', key: msg.key } });

        try {
          const apiUrl = `https://api.siputzx.my.id/api/download/fb?url=${encodeURIComponent(url)}`;
          const { data } = await axios.get(apiUrl);

          if (!data.result?.hd) {
            await socket.sendMessage(from, { text: '❌ Failed to fetch video' }, { quoted: msg });
            return;
          }

          await socket.sendMessage(from, {
            video: { url: data.result.hd },
            caption: `📘 *Facebook Video*\n\n${FOOTER}`
          }, { quoted: msg });
        } catch (err) {
          await socket.sendMessage(from, { text: `❌ Error: ${err.message}` }, { quoted: msg });
        }
      }

      // ========== SAVE STATUS ==========
      else if (command === 'save') {
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quoted) {
          await socket.sendMessage(from, { text: '💾 *Reply to a status message to save it*' }, { quoted: msg });
          return;
        }

        try {
          const media = await downloadQuotedMedia(quoted);
          if (!media || !media.buffer) {
            await socket.sendMessage(from, { text: '❌ Failed to download media' }, { quoted: msg });
            return;
          }

          if (quoted.imageMessage) {
            await socket.sendMessage(from, { image: media.buffer, caption: '✅ Status Saved' });
          } else if (quoted.videoMessage) {
            await socket.sendMessage(from, { video: media.buffer, caption: '✅ Status Saved' });
          } else if (quoted.audioMessage) {
            await socket.sendMessage(from, { audio: media.buffer, ptt: true });
          } else if (quoted.conversation) {
            await socket.sendMessage(from, { text: `✅ *Saved Status*\n\n${quoted.conversation}` });
          }

          await socket.sendMessage(from, { text: '✅ Status saved successfully!' }, { quoted: msg });
        } catch (err) {
          await socket.sendMessage(from, { text: '❌ Failed to save status' }, { quoted: msg });
        }
      }

      // ========== DEFAULT ==========
      else {
        // Unknown command - ignore
      }

    } catch (err) {
      console.error('Command error:', err);
      await socket.sendMessage(from, { text: '❌ An error occurred' }).catch(() => {});
    }
  });
}

// ========== STATUS HANDLERS ==========
async function setupStatusHandlers(socket, sessionNumber) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.key || msg.key.remoteJid !== 'status@broadcast') return;

    try {
      const userConfig = await loadUserConfigFromSupabase(sessionNumber) || {};
      if (userConfig.AUTO_VIEW_STATUS === 'true') {
        await socket.readMessages([msg.key]);
      }
      if (userConfig.AUTO_LIKE_STATUS === 'true') {
        const emojis = userConfig.AUTO_LIKE_EMOJI || config.AUTO_LIKE_EMOJI;
        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
        await socket.sendMessage(msg.key.remoteJid, {
          react: { text: randomEmoji, key: msg.key }
        }, { statusJidList: [msg.key.participant] });
      }
    } catch (err) {
      console.error('Status handler error:', err);
    }
  });
}

// ========== PAIR FUNCTION ==========
async function EmpirePair(number, res) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);

  try {
    const saved = await loadCredsFromSupabase(sanitizedNumber);
    if (saved?.creds) {
      fs.ensureDirSync(sessionPath);
      fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(saved.creds, null, 2));
    }
  } catch (e) {}

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const logger = pino({ level: 'fatal' });

  const socket = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  socketCreationTime.set(sanitizedNumber, Date.now());

  if (!state.creds.registered) {
    let code;
    for (let i = 0; i < config.MAX_RETRIES; i++) {
      try {
        code = await socket.requestPairingCode(sanitizedNumber);
        break;
      } catch (err) {
        await delay(2000);
      }
    }
    if (!res.headersSent) res.send({ code });
  }

  socket.ev.on('creds.update', async () => {
    await saveCreds();
    const credsPath = path.join(sessionPath, 'creds.json');
    if (fs.existsSync(credsPath)) {
      const credsObj = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      await saveCredsToSupabase(sanitizedNumber, credsObj, state.keys);
    }
  });

  socket.ev.on('connection.update', async (update) => {
    const { connection } = update;
    if (connection === 'open') {
      activeSockets.set(sanitizedNumber, socket);
      await addNumberToSupabase(sanitizedNumber);

      const userJid = socket.user.id;
      await socket.sendMessage(userJid, {
        image: { url: BOT_IMAGE },
        caption: `🔴 *Red Mini Bot Activated* 🔴\n━━━━━━━━━━━━━━━━━━\n✅ Connected: +${sanitizedNumber}\n📡 Status: Active\n🇿🇦 Region: South Africa\n⏱️ Time: ${getSouthAfricaTimestamp()}\n━━━━━━━━━━━━━━━━━━\n${FOOTER}`
      });
    }
    if (connection === 'close') {
      activeSockets.delete(sanitizedNumber);
    }
  });

  setupCommandHandlers(socket, sanitizedNumber);
  setupStatusHandlers(socket, sanitizedNumber);

  activeSockets.set(sanitizedNumber, socket);
}

// ========== ROUTES ==========
router.get('/', async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).json({ error: 'Number required' });
  const sanitized = number.replace(/[^0-9]/g, '');
  if (activeSockets.has(sanitized)) {
    return res.status(200).json({ status: 'already_connected' });
  }
  await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
  res.json({
    botName: BOT_NAME,
    count: activeSockets.size,
    numbers: Array.from(activeSockets.keys()),
    timestamp: getSouthAfricaTimestamp()
  });
});

router.get('/ping', (req, res) => {
  res.json({ status: 'active', botName: BOT_NAME, sessions: activeSockets.size });
});

module.exports = router;
