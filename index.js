const express = require('express');
const path = require('path');
const fs = require('fs-extra');

const app = express();
const PORT = process.env.PORT || 8002;

// Import the pair module
const code = require('./pair');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/code', code);

// Status dashboard route
app.get('/status', (req, res) => {
    res.sendFile(path.join(__dirname, 'status.html'));
});

// Main pairing page
app.get('/pair', (req, res) => {
    res.sendFile(path.join(__dirname, 'main.html'));
});

// API endpoint to get bot status
app.get('/api/status', async (req, res) => {
    try {
        const { activeSockets, getActiveSessions } = require('./pair');
        const sessions = getActiveSessions ? getActiveSessions() : [];
        
        res.json({
            status: 'online',
            botName: process.env.BOT_NAME || 'Red Mini',
            ownerNumber: process.env.OWNER_NUMBER || '27634988678',
            newsletter: process.env.NEWSLETTER_JID || '120363427119111004@newsletter',
            uptime: process.uptime(),
            activeSessions: sessions.length,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.json({
            status: 'degraded',
            error: err.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Home route
app.get('/', (req, res) => {
    res.redirect('/status');
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════╗
║      🔴 RED MINI BOT STARTED 🔴       ║
╠══════════════════════════════════════╣
║  Port: ${PORT}                              ║
║  Bot Name: ${process.env.BOT_NAME || 'Red Mini'}     ║
║  Owner: ${process.env.OWNER_NUMBER || '27634988678'}   ║
║  Status URL: http://localhost:${PORT}/status ║
╚══════════════════════════════════════╝
    `);
});

module.exports = app;