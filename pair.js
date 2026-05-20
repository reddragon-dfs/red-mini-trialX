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
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

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

async function loadAdminsFromSupabase() {
  const { data } = await supabase.from('admins').select('jid');
  return data ? data.map(d => d.jid) : [];
}

async function addAdminToSupabase(jid) {
  await supabase.from('admins').upsert({ jid });
}

async function removeAdminFromSupabase(jid) {
  await supabase.from('admins').delete().eq('jid', jid);
}

async function addNewsletterToSupabase(jid, emojis = []) {
  await supabase.from('newsletters').upsert({ jid, emojis, added_at: new Date() });
}

async function removeNewsletterFromSupabase(jid) {
  await supabase.from('newsletters').delete().eq('jid', jid);
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
const otpStore = new Map();

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
    else if (type === 'listResponseMessage') body = msg.message.listResponseMessage?.singleSelectReply?.selectedRowId || '';

    if (!body || typeof body !== 'string') return;

    const from = msg.key.remoteJid;
    const sender = msg.key.fromMe ? socket.user.id.split(':')[0] + '@s.whatsapp.net' : (msg.key.participant || msg.key.remoteJid);
    const senderNumber = sender.split('@')[0];
    const isGroup = from.endsWith('@g.us');
    const prefix = config.PREFIX;
    const isCmd = body.startsWith(prefix);
    const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : null;
    const args = body.trim().split(/ +/).slice(1);

    if (!command) return;

    try {
      // ==================== MENU COMMAND WITH BUTTONS ====================
      if (command === 'menu') {
        await socket.sendMessage(from, { react: { text: '🔴', key: msg.key } });

        const uptime = Math.floor((Date.now() - (socketCreationTime.get(sessionNumber) || Date.now())) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);

        const menuText = `╭───❰ 🔴 RED MINI BOT 🔴 ❱───╮
│
│ 🤖 *Name:* Red Mini
│ 👑 *Owner:* 27634988678
│ ⏱️ *Uptime:* ${hours}h ${minutes}m ${seconds}s
│ 📡 *Status:* Active
│ 🇿🇦 *Region:* South Africa
│
╰─────────────────────╯

╭───❰ 📥 DOWNLOADER ❱───╮
│ 🎵 ${prefix}play <song>
│ 🎬 ${prefix}video <name>
│ 📘 ${prefix}fb <url>
│ 🎨 ${prefix}sticker
│ 📸 ${prefix}instagram <url>
│ 🐦 ${prefix}twitter <url>
│ 🎵 ${prefix}soundcloud <url>
│ 📹 ${prefix}tiktok <url>
│ 📺 ${prefix}youtube <url>
╰─────────────────────╯

╭───❰ 🛠️ TOOLS ❱───╮
│ 🌤️ ${prefix}weather <city>
│ 🔍 ${prefix}google <query>
│ 📝 ${prefix}translate <text>
│ 🔗 ${prefix}short <url>
│ 🧮 ${prefix}calc <math>
│ 🆔 ${prefix}jid
│ 💾 ${prefix}save
│ 🔐 ${prefix}pair <number>
╰─────────────────────╯

╭───❰ ⚙️ SETTINGS ❱───╮
│ 🤖 ${prefix}alive
│ ⚡ ${prefix}ping
│ 🎭 ${prefix}profile
│ 📊 ${prefix}stats
│ 🔧 ${prefix}setting
╰─────────────────────╯

╭───❰ 👑 OWNER ❱───╮
│ 📢 ${prefix}broadcast
│ 👥 ${prefix}admin
│ 📰 ${prefix}newsletter
│ 🗑️ ${prefix}deleteme
╰─────────────────────╯

${FOOTER}`;

        const buttons = [
          { buttonId: `${prefix}alive`, buttonText: { displayText: '🤖 ALIVE' }, type: 1 },
          { buttonId: `${prefix}ping`, buttonText: { displayText: '⚡ PING' }, type: 1 },
          { buttonId: `${prefix}sticker`, buttonText: { displayText: '🎨 STICKER' }, type: 1 },
          { buttonId: `${prefix}play`, buttonText: { displayText: '🎵 PLAY' }, type: 1 },
          { buttonId: `${prefix}weather`, buttonText: { displayText: '🌤️ WEATHER' }, type: 1 }
        ];

        await socket.sendMessage(from, {
          image: { url: BOT_IMAGE },
          caption: menuText,
          buttons: buttons,
          headerType: 4
        }, { quoted: msg });
        break;
      }

      // ==================== ALIVE COMMAND ====================
      if (command === 'alive') {
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
        break;
      }

      // ==================== PING COMMAND ====================
      if (command === 'ping') {
        const start = Date.now();
        await socket.sendMessage(from, { react: { text: '⏳', key: msg.key } });
        const latency = Date.now() - start;
        const pingText = `⚡ *PONG!*\n━━━━━━━━━━━━━━━━━━\n📡 *Latency:* ${latency}ms\n🚀 *Speed:* ${latency < 100 ? 'Excellent' : latency < 300 ? 'Good' : 'Slow'}\n━━━━━━━━━━━━━━━━━━\n${FOOTER}`;
        await socket.sendMessage(from, { text: pingText }, { quoted: msg });
        break;
      }

      // ==================== STICKER COMMAND ====================
      if (command === 'sticker' || command === 's') {
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const mime = msg.message?.imageMessage?.mimetype ||
          quoted?.imageMessage?.mimetype ||
          msg.message?.videoMessage?.mimetype ||
          quoted?.videoMessage?.mimetype;

        if (!mime) {
          await socket.sendMessage(from, { text: '❌ Reply to an image or video!' }, { quoted: msg });
          break;
        }

        try {
          let media = await downloadQuotedMedia(msg.message?.imageMessage ? msg.message : quoted);
          let buffer = media.buffer;
          const ran = generateOTP();
          const pathIn = `./${ran}.${mime.split('/')[1]}`;
          const pathOut = `./${ran}.webp`;

          fs.writeFileSync(pathIn, buffer);

          const { exec } = require('child_process');
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
        break;
      }

      // ==================== PLAY COMMAND (MUSIC) ====================
      if (command === 'play') {
        const query = args.join(' ');
        if (!query) {
          await socket.sendMessage(from, { text: '🎵 *Usage:* .play <song name>' }, { quoted: msg });
          break;
        }

        await socket.sendMessage(from, { react: { text: '🎵', key: msg.key } });

        try {
          const search = await yts(query);
          if (!search.videos.length) {
            await socket.sendMessage(from, { text: '❌ No results found!' }, { quoted: msg });
            break;
          }

          const video = search.videos[0];
          const apiUrl = `https://api.dreaded.site/api/ytdl/audio?url=${video.url}`;
          const { data } = await axios.get(apiUrl);

          if (!data.result?.downloadUrl) {
            await socket.sendMessage(from, { text: '❌ Failed to get audio' }, { quoted: msg });
            break;
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
        break;
      }

      // ==================== VIDEO COMMAND ====================
      if (command === 'video') {
        const query = args.join(' ');
        if (!query) {
          await socket.sendMessage(from, { text: '🎬 *Usage:* .video <video name>' }, { quoted: msg });
          break;
        }

        await socket.sendMessage(from, { react: { text: '🎬', key: msg.key } });

        try {
          const search = await yts(query);
          if (!search.videos.length) {
            await socket.sendMessage(from, { text: '❌ No results found!' }, { quoted: msg });
            break;
          }

          const video = search.videos[0];
          const apiUrl = `https://api.dreaded.site/api/ytdl/video?url=${video.url}`;
          const { data } = await axios.get(apiUrl);

          if (!data.result?.downloadUrl) {
            await socket.sendMessage(from, { text: '❌ Failed to get video' }, { quoted: msg });
            break;
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
        break;
      }

      // ==================== FACEBOOK DOWNLOADER ====================
      if (command === 'fb' || command === 'facebook') {
        const url = args[0];
        if (!url) {
          await socket.sendMessage(from, { text: '📘 *Usage:* .fb <facebook video url>' }, { quoted: msg });
          break;
        }

        await socket.sendMessage(from, { react: { text: '📘', key: msg.key } });

        try {
          const apiUrl = `https://api.siputzx.my.id/api/download/fb?url=${encodeURIComponent(url)}`;
          const { data } = await axios.get(apiUrl);

          if (!data.result?.hd) {
            await socket.sendMessage(from, { text: '❌ Failed to fetch video' }, { quoted: msg });
            break;
          }

          await socket.sendMessage(from, {
            video: { url: data.result.hd },
            caption: `📘 *Facebook Video*\n\n${FOOTER}`
          }, { quoted: msg });

        } catch (err) {
          await socket.sendMessage(from, { text: `❌ Error: ${err.message}` }, { quoted: msg });
        }
        break;
      }

      // ==================== INSTAGRAM DOWNLOADER ====================
      if (command === 'instagram' || command === 'ig') {
        const url = args[0];
        if (!url) {
          await socket.sendMessage(from, { text: '📸 *Usage:* .ig <instagram url>' }, { quoted: msg });
          break;
        }

        await socket.sendMessage(from, { react: { text: '📸', key: msg.key } });

        try {
          const apiUrl = `https://api.siputzx.my.id/api/download/ig?url=${encodeURIComponent(url)}`;
          const { data } = await axios.get(apiUrl);

          if (!data.result?.url) {
            await socket.sendMessage(from, { text: '❌ Failed to fetch media' }, { quoted: msg });
            break;
          }

          if (data.result.url.endsWith('.mp4')) {
            await socket.sendMessage(from, { video: { url: data.result.url }, caption: `📸 *Instagram Video*\n\n${FOOTER}` }, { quoted: msg });
          } else {
            await socket.sendMessage(from, { image: { url: data.result.url }, caption: `📸 *Instagram Image*\n\n${FOOTER}` }, { quoted: msg });
          }

        } catch (err) {
          await socket.sendMessage(from, { text: `❌ Error: ${err.message}` }, { quoted: msg });
        }
        break;
      }

      // ==================== TIKTOK DOWNLOADER ====================
      if (command === 'tiktok' || command === 'tt') {
        const url = args[0];
        if (!url) {
          await socket.sendMessage(from, { text: '📹 *Usage:* .tt <tiktok url>' }, { quoted: msg });
          break;
        }

        await socket.sendMessage(from, { react: { text: '📹', key: msg.key } });

        try {
          const apiUrl = `https://api.siputzx.my.id/api/download/tiktok?url=${encodeURIComponent(url)}`;
          const { data } = await axios.get(apiUrl);

          if (!data.result?.video) {
            await socket.sendMessage(from, { text: '❌ Failed to fetch video' }, { quoted: msg });
            break;
          }

          await socket.sendMessage(from, {
            video: { url: data.result.video },
            caption: `📹 *TikTok Video*\n👤 Author: ${data.result.author || 'Unknown'}\n\n${FOOTER}`
          }, { quoted: msg });

        } catch (err) {
          await socket.sendMessage(from, { text: `❌ Error: ${err.message}` }, { quoted: msg });
        }
        break;
      }

      // ==================== TWITTER DOWNLOADER ====================
      if (command === 'twitter' || command === 'tw') {
        const url = args[0];
        if (!url) {
          await socket.sendMessage(from, { text: '🐦 *Usage:* .tw <twitter url>' }, { quoted: msg });
          break;
        }

        await socket.sendMessage(from, { react: { text: '🐦', key: msg.key } });

        try {
          const apiUrl = `https://api.siputzx.my.id/api/download/twitter?url=${encodeURIComponent(url)}`;
          const { data } = await axios.get(apiUrl);

          if (!data.result?.hd) {
            await socket.sendMessage(from, { text: '❌ Failed to fetch video' }, { quoted: msg });
            break;
          }

          await socket.sendMessage(from, {
            video: { url: data.result.hd },
            caption: `🐦 *Twitter Video*\n\n${FOOTER}`
          }, { quoted: msg });

        } catch (err) {
          await socket.sendMessage(from, { text: `❌ Error: ${err.message}` }, { quoted: msg });
        }
        break;
      }

      // ==================== WEATHER COMMAND ====================
      if (command === 'weather') {
        const city = args.join(' ');
        if (!city) {
          await socket.sendMessage(from, { text: '🌤️ *Usage:* .weather <city name>' }, { quoted: msg });
          break;
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
        break;
      }

      // ==================== TRANSLATE COMMAND ====================
      if (command === 'translate' || command === 'tr') {
        const lang = args[0] || 'af';
        const text = args.slice(1).join(' ') || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation;

        if (!text) {
          await socket.sendMessage(from, { text: '📝 *Usage:* .translate af Hello' }, { quoted: msg });
          break;
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
        break;
      }

      // ==================== CALCULATE COMMAND ====================
      if (command === 'calc') {
        const expr = args.join(' ');
        if (!expr) {
          await socket.sendMessage(from, { text: '🧮 *Usage:* .calc 2+2*5' }, { quoted: msg });
          break;
        }

        try {
          const result = new Function('return ' + expr)();
          await socket.sendMessage(from, {
            text: `🧮 *Calculator*\n━━━━━━━━━━━━━━━━━━\n📌 Question: ${expr}\n✅ Answer: ${result}\n━━━━━━━━━━━━━━━━━━\n${FOOTER}`
          }, { quoted: msg });
        } catch (err) {
          await socket.sendMessage(from, { text: '❌ Invalid expression' }, { quoted: msg });
        }
        break;
      }

      // ==================== SHORTEN URL ====================
      if (command === 'short') {
        const link = args[0];
        if (!link) {
          await socket.sendMessage(from, { text: '🔗 *Usage:* .short <url>' }, { quoted: msg });
          break;
        }

        try {
          const { data } = await axios.get(`https://tinyurl.com/api-create.php?url=${link}`);
          await socket.sendMessage(from, {
            text: `🔗 *URL Shortened*\n━━━━━━━━━━━━━━━━━━\n🔗 Original: ${link}\n📎 Shortened: ${data}\n━━━━━━━━━━━━━━━━━━\n${FOOTER}`
          }, { quoted: msg });
        } catch (err) {
          await socket.sendMessage(from, { text: '❌ Failed to shorten URL' }, { quoted: msg });
        }
        break;
      }

      // ==================== GITHUB PROFILE ====================
      if (command === 'github' || command === 'git') {
        const user = args[0];
        if (!user) {
          await socket.sendMessage(from, { text: '🐙 *Usage:* .github <username>' }, { quoted: msg });
          break;
        }

        try {
          const { data } = await axios.get(`https://api.github.com/users/${user}`);
          const profileText = `🐙 *GitHub Profile*\n━━━━━━━━━━━━━━━━━━\n👤 Name: ${data.name || 'N/A'}\n🔖 Username: ${data.login}\n📦 Repos: ${data.public_repos}\n👥 Followers: ${data.followers}\n🔗 URL: ${data.html_url}\n━━━━━━━━━━━━━━━━━━\n${FOOTER}`;

          await socket.sendMessage(from, {
            image: { url: data.avatar_url },
            caption: profileText
          }, { quoted: msg });

        } catch (err) {
          await socket.sendMessage(from, { text: '❌ User not found' }, { quoted: msg });
        }
        break;
      }

      // ==================== JID COMMAND ====================
      if (command === 'jid') {
        await socket.sendMessage(from, {
          text: `🆔 *Your JID Info*\n━━━━━━━━━━━━━━━━━━\n📱 JID: ${sender}\n🔢 Number: +${senderNumber}\n📡 Type: ${isGroup ? 'Group' : 'Private Chat'}\n━━━━━━━━━━━━━━━━━━\n${FOOTER}`
        }, { quoted: msg });
        break;
      }

      // ==================== SAVE STATUS ====================
      if (command === 'save') {
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quoted) {
          await socket.sendMessage(from, { text: '💾 *Reply to a status message to save it*' }, { quoted: msg });
          break;
        }

        try {
          const media = await downloadQuotedMedia(quoted);
          if (!media || !media.buffer) {
            await socket.sendMessage(from, { text: '❌ Failed to download media' }, { quoted: msg });
            break;
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
        break;
      }

      // ==================== PAIR COMMAND ====================
      if (command === 'pair') {
        const number = args[0];
        if (!number) {
          await socket.sendMessage(from, { text: '🔐 *Usage:* .pair 27634988678' }, { quoted: msg });
          break;
        }

        try {
          const cleanNumber = number.replace(/[^0-9]/g, '');
          const response = await axios.get(`https://${req.headers.host}/code?number=${cleanNumber}`);
          const code = response.data.code;

          await socket.sendMessage(from, {
            text: `🔐 *Pairing Code*\n━━━━━━━━━━━━━━━━━━\n📱 Number: +${cleanNumber}\n🔑 Code: ${code}\n⏱️ Expires in 5 minutes\n━━━━━━━━━━━━━━━━━━\n${FOOTER}`
          }, { quoted: msg });

        } catch (err) {
          await socket.sendMessage(from, { text: '❌ Failed to generate pairing code' }, { quoted: msg });
        }
        break;
      }

      // ==================== PROFILE COMMAND ====================
      if (command === 'profile') {
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
        break;
      }

      // ==================== STATS COMMAND ====================
      if (command === 'stats') {
        const totalSessions = activeSockets.size;
        const uptime = Math.floor((Date.now() - (socketCreationTime.get(sessionNumber) || Date.now())) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);

        const statsText = `📊 *Bot Statistics*
━━━━━━━━━━━━━━━━━━
🤖 *Bot Name:* Red Mini
⏱️ *Uptime:* ${hours}h ${minutes}m
📱 *Active Sessions:* ${totalSessions}
📡 *Status:* Online
🇿🇦 *Region:* South Africa
━━━━━━━━━━━━━━━━━━
${FOOTER}`;

        await socket.sendMessage(from, { text: statsText }, { quoted: msg });
        break;
      }

      // ==================== SETTING COMMAND ====================
      if (command === 'setting') {
        const userConfig = await loadUserConfigFromSupabase(sessionNumber) || {};
        const workType = userConfig.WORK_TYPE || 'public';

        const settingText = `⚙️ *Bot Settings*
━━━━━━━━━━━━━━━━━━
🔧 *Work Type:* ${workType}
🔣 *Prefix:* ${prefix}
🤖 *Bot Name:* Red Mini
━━━━━━━━━━━━━━━━━━
📌 *Commands to change settings:*
${prefix}wtype public/groups/inbox/private
━━━━━━━━━━━━━━━━━━
${FOOTER}`;

        await socket.sendMessage(from, { text: settingText }, { quoted: msg });
        break;
      }

      // ==================== WORK TYPE COMMAND ====================
      if (command === 'wtype') {
        const type = args[0];
        if (!type || !['public', 'groups', 'inbox', 'private'].includes(type)) {
          await socket.sendMessage(from, { text: '⚙️ *Usage:* .wtype public/groups/inbox/private' }, { quoted: msg });
          break;
        }

        const userConfig = await loadUserConfigFromSupabase(sessionNumber) || {};
        userConfig.WORK_TYPE = type;
        await setUserConfigInSupabase(sessionNumber, userConfig);

        await socket.sendMessage(from, { text: `✅ Work type updated to: ${type}` }, { quoted: msg });
        break;
      }

      // ==================== GOOGLE COMMAND ====================
      if (command === 'google') {
        const query = args.join(' ');
        if (!query) {
          await socket.sendMessage(from, { text: '🔍 *Usage:* .google <search query>' }, { quoted: msg });
          break;
        }

        try {
          const response = await axios.get(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
          const $ = cheerio.load(response.data);
          const results = [];

          $('.tF2Cxc').slice(0, 5).each((i, el) => {
            const title = $(el).find('h3').text();
            const link = $(el).find('a').attr('href');
            if (title && link) {
              results.push(`📌 *${title}*\n🔗 ${link}\n`);
            }
          });

          if (results.length === 0) {
            await socket.sendMessage(from, { text: '❌ No results found' }, { quoted: msg });
          } else {
            await socket.sendMessage(from, {
              text: `🔍 *Google Search: ${query}*\n━━━━━━━━━━━━━━━━━━\n${results.join('\n')}\n━━━━━━━━━━━━━━━━━━\n${FOOTER}`
            }, { quoted: msg });
          }

        } catch (err) {
          await socket.sendMessage(from, { text: '❌ Search failed' }, { quoted: msg });
        }
        break;
      }

      // ==================== DELETE SESSION ====================
      if (command === 'deleteme') {
        const senderNum = senderNumber;
        if (senderNum !== sessionNumber && senderNum !== OWNER_NUMBER) {
          await socket.sendMessage(from, { text: '❌ Permission denied' }, { quoted: msg });
          break;
        }

        await removeSessionFromSupabase(sessionNumber);
        await socket.sendMessage(from, { text: '✅ Session deleted successfully' }, { quoted: msg });
        await socket.logout();
        activeSockets.delete(sessionNumber);
        break;
      }

      // ==================== BROADCAST COMMAND ====================
      if (command === 'broadcast') {
        if (senderNumber !== OWNER_NUMBER) {
          await socket.sendMessage(from, { text: '❌ Owner only command' }, { quoted: msg });
          break;
        }

        const message = args.join(' ');
        if (!message) {
          await socket.sendMessage(from, { text: '📢 *Usage:* .broadcast <message>' }, { quoted: msg });
          break;
        }

        const numbers = await getAllNumbersFromSupabase();
        for (const num of numbers) {
          try {
            const jid = `${num}@s.whatsapp.net`;
            await socket.sendMessage(jid, { text: `📢 *Broadcast*\n━━━━━━━━━━━━━━━━━━\n${message}\n━━━━━━━━━━━━━━━━━━\n${FOOTER}` });
          } catch (e) {}
        }

        await socket.sendMessage(from, { text: `✅ Broadcast sent to ${numbers.length} users` }, { quoted: msg });
        break;
      }

      // ==================== ADMIN COMMANDS ====================
      if (command === 'admin') {
        if (senderNumber !== OWNER_NUMBER) {
          await socket.sendMessage(from, { text: '❌ Owner only command' }, { quoted: msg });
          break;
        }

        const action = args[0];
        const target = args[1];

        if (action === 'add' && target) {
          await addAdminToSupabase(target);
          await socket.sendMessage(from, { text: `✅ ${target} added as admin` }, { quoted: msg });
        } else if (action === 'remove' && target) {
          await removeAdminFromSupabase(target);
          await socket.sendMessage(from, { text: `✅ ${target} removed from admins` }, { quoted: msg });
        } else if (action === 'list') {
          const admins = await loadAdminsFromSupabase();
          await socket.sendMessage(from, { text: `👥 *Admins*\n━━━━━━━━━━━━━━━━━━\n${admins.join('\n') || 'No admins'}\n━━━━━━━━━━━━━━━━━━\n${FOOTER}` }, { quoted: msg });
        } else {
          await socket.sendMessage(from, { text: '👥 *Admin Commands*\n.admin add <jid>\n.admin remove <jid>\n.admin list' }, { quoted: msg });
        }
        break;
      }

      // ==================== NEWSLETTER COMMANDS ====================
      if (command === 'newsletter') {
        if (senderNumber !== OWNER_NUMBER) {
          await socket.sendMessage(from, { text: '❌ Owner only command' }, { quoted: msg });
          break;
        }

        const action = args[0];
        const jid = args[1];
        const emojis = args.slice(2);

        if (action === 'add' && jid) {
          await addNewsletterToSupabase(jid, emojis);
          await socket.sendMessage(from, { text: `✅ Newsletter ${jid} added` }, { quoted: msg });
        } else if (action === 'remove' && jid) {
          await removeNewsletterFromSupabase(jid);
          await socket.sendMessage(from, { text: `✅ Newsletter ${jid} removed` }, { quoted: msg });
        } else if (action === 'list') {
          const newsletters = await listNewslettersFromSupabase();
          const listText = newsletters.map(n => `📰 ${n.jid}\n   Emojis: ${n.emojis.join(', ')}`).join('\n\n');
          await socket.sendMessage(from, { text: `📰 *Newsletters*\n━━━━━━━━━━━━━━━━━━\n${listText || 'No newsletters'}\n━━━━━━━━━━━━━━━━━━\n${FOOTER}` }, { quoted: msg });
        } else {
          await socket.sendMessage(from, { text: '📰 *Newsletter Commands*\n.newsletter add <jid> [emojis]\n.newsletter remove <jid>\n.newsletter list' }, { quoted: msg });
        }
        break;
      }

      // ==================== DEFAULT ====================
      default:
        break;
    }

  } catch (err) {
    console.error('Command error:', err);
    await socket.sendMessage(msg.key.remoteJid, { text: '❌ An error occurred' }).catch(() => {});
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

// ========== CALL REJECTION HANDLER ==========
async function setupCallRejection(socket, sessionNumber) {
  socket.ev.on('call', async (calls) => {
    const userConfig = await loadUserConfigFromSupabase(sessionNumber) || {};
    if (userConfig.ANTI_CALL !== 'on') return;

    for (const call of calls) {
      if (call.status !== 'offer') continue;
      await socket.rejectCall(call.id, call.from);
      await socket.sendMessage(call.from, { text: '🔕 Auto call rejection is enabled.' });
    }
  });
}

// ========== NEWSLETTER REACTION HANDLER ==========
async function setupNewsletterHandlers(socket, sessionNumber) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.key) return;
    const jid = msg.key.remoteJid;

    const newsletters = await listNewslettersFromSupabase();
    const isFollowed = newsletters.some(n => n.jid === jid);
    if (!isFollowed) return;

    const newsletter = newsletters.find(n => n.jid === jid);
    const emojis = newsletter.emojis.length ? newsletter.emojis : config.AUTO_LIKE_EMOJI;
    const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];

    try {
      await socket.sendMessage(jid, { react: { text: randomEmoji, key: msg.key } });
    } catch (err) {
      console.error('Newsletter reaction error:', err);
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
  setupCallRejection(socket, sanitizedNumber);
  setupNewsletterHandlers(socket, sanitizedNumber);

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

router.get('/connect-all', async (req, res) => {
  const numbers = await getAllNumbersFromSupabase();
  for (const num of numbers) {
    if (!activeSockets.has(num)) {
      const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
      await EmpirePair(num, mockRes);
      await delay(1000);
    }
  }
  res.json({ status: 'success', connected: Array.from(activeSockets.keys()) });
});

// ========== INIT SUPABASE TABLES ==========
async function initTables() {
  const createTables = `
  CREATE TABLE IF NOT EXISTS sessions (number TEXT PRIMARY KEY, creds JSONB NOT NULL, keys JSONB, updated_at TIMESTAMP DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS numbers (number TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS configs (number TEXT PRIMARY KEY, config JSONB NOT NULL, updated_at TIMESTAMP DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS admins (jid TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS newsletters (jid TEXT PRIMARY KEY, emojis TEXT[] DEFAULT '{}', added_at TIMESTAMP DEFAULT NOW());
  `;

  try {
    await supabase.rpc('exec_sql', { query: createTables });
    console.log('✅ Tables ready');
  } catch (err) {
    console.log('⚠️ Tables may already exist');
  }
}

initTables();

// ========== AUTO RESTART SESSIONS ==========
(async () => {
  const numbers = await getAllNumbersFromSupabase();
  for (const num of numbers) {
    if (!activeSockets.has(num)) {
      const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
      await EmpirePair(num, mockRes);
      await delay(2000);
    }
  }
})();

module.exports = router;