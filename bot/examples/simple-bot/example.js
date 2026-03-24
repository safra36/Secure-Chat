'use strict';
/**
 * Demo Bot — commands, trivia quiz, calculator, dice roller.
 * Works in both direct bot chats and regular chats (after being added via "Add Bot to Chat").
 *
 * Setup (one-time):
 *   1. Admin generates invite via the Bots UI (+) button → copy inviteToken + sharedKey
 *   2. Set INVITE_TOKEN and SHARED_KEY below (or use env vars)
 *   3. Run: node example.js --activate
 *
 * Running:
 *   node example.js
 */

const { BotClient } = require('../../bot-sdk');
const fs = require('fs');
const path = require('path');

const SERVER_URL   = process.env.BOT_SERVER_URL   || 'https://localhost:3000';
const SHARED_KEY   = process.env.BOT_SHARED_KEY   || '7365a8a50bce2ca5ddefeb07608cd75bec082d3e83bb7669866c66881b4f4a24';
const INVITE_TOKEN = process.env.BOT_INVITE_TOKEN || '46a4bf94406496865e30ed980103e85e4c236d89c3030a85fcd1c93756bd6c2f';

const bot = new BotClient({
    serverUrl: SERVER_URL,
    sharedKey: SHARED_KEY,
    keysFile: './bot-keys.json',
});

// ── Trivia questions ───────────────────────────────────────────────────────────

const QUESTIONS = [
    {
        q: 'What is 7 × 8?',
        choices: ['A. 48', 'B. 56', 'C. 54', 'D. 63'],
        answer: 'B',
    },
    {
        q: 'Which planet is closest to the Sun?',
        choices: ['A. Venus', 'B. Earth', 'C. Mercury', 'D. Mars'],
        answer: 'C',
    },
    {
        q: 'What is the capital of Japan?',
        choices: ['A. Beijing', 'B. Seoul', 'C. Bangkok', 'D. Tokyo'],
        answer: 'D',
    },
    {
        q: 'How many bytes are in a kilobyte?',
        choices: ['A. 512', 'B. 100', 'C. 1024', 'D. 2048'],
        answer: 'C',
    },
    {
        q: 'Which language runs natively in the browser?',
        choices: ['A. Python', 'B. Ruby', 'C. PHP', 'D. JavaScript'],
        answer: 'D',
    },
];

// ── Chat key persistence ───────────────────────────────────────────────────────

const CHATS_FILE = path.join(process.cwd(), 'bot-chats.json');

function loadChatKeys() {
    try {
        if (!fs.existsSync(CHATS_FILE)) return {};
        return JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8'));
    } catch (e) {
        console.warn('[Demo] Failed to load chat keys:', e.message);
        return {};
    }
}

function saveChatKey(chatHandle, encryptionKey) {
    const keys = loadChatKeys();
    keys[chatHandle] = encryptionKey;
    fs.writeFileSync(CHATS_FILE, JSON.stringify(keys, null, 2));
}

function removeChatKey(chatHandle) {
    const keys = loadChatKeys();
    delete keys[chatHandle];
    fs.writeFileSync(CHATS_FILE, JSON.stringify(keys, null, 2));
}

// ── Per-user sessions ──────────────────────────────────────────────────────────

// Map<sessionKey, { state, quizIndex, quizScore, totalScore, gamesPlayed }>
// sessionKey = userId for direct, `${chatHandle}:${userId}` for chat
const sessions = new Map();

function getSession(key) {
    if (!sessions.has(key)) {
        sessions.set(key, { state: 'idle', quizIndex: 0, quizScore: 0, totalScore: 0, gamesPlayed: 0 });
    }
    return sessions.get(key);
}

// ── Safe calculator ────────────────────────────────────────────────────────────

function safeCalc(expr) {
    if (!/^[\d\s+\-*/().^%]+$/.test(expr)) return 'Invalid expression';
    try {
        const result = Function('"use strict"; return (' + expr.replace(/\^/g, '**') + ')')();
        if (typeof result !== 'number' || !isFinite(result)) return 'Math error';
        return Math.round(result * 1e10) / 1e10;
    } catch { return 'Invalid expression'; }
}

// ── Quiz helpers ───────────────────────────────────────────────────────────────

function quizButtons(qIndex) {
    return QUESTIONS[qIndex].choices.map(c => ({ label: c, value: c[0] }));
}

// send/sendRich abstracted over direct vs chat context
async function send(ctx, text) {
    if (ctx.chatHandle) {
        await bot.sendToChat(ctx.chatHandle, text, ctx.encryptionKey);
    } else {
        await bot.reply(ctx.userId, text);
    }
}

async function sendRich(ctx, text, buttons) {
    if (ctx.chatHandle) {
        await bot.sendRichToChat(ctx.chatHandle, text, buttons, ctx.encryptionKey);
    } else {
        await bot.replyRich(ctx.userId, text, buttons);
    }
}

async function sendQuestion(ctx, qIndex) {
    const q = QUESTIONS[qIndex];
    await sendRich(ctx, `❓ Question ${qIndex + 1}/5: ${q.q}`, quizButtons(qIndex));
}

// ── Shared command handler (direct + chat) ─────────────────────────────────────

async function handleMessage(ctx, content) {
    const text = (content || '').trim();
    const sessKey = ctx.chatHandle ? `${ctx.chatHandle}:${ctx.userId}` : ctx.userId;
    const sess = getSession(sessKey);
    console.log(`[Demo] ${ctx.chatHandle || 'direct'} / ${ctx.userId} [${sess.state}]: ${text}`);

    if (sess.state === 'quiz') {
        const ans = text.toUpperCase();
        if (['A', 'B', 'C', 'D'].includes(ans)) {
            const q = QUESTIONS[sess.quizIndex];
            const correct = ans === q.answer;
            if (correct) sess.quizScore++;
            const feedback = correct
                ? '✅ Correct!'
                : `❌ Wrong! The answer was ${q.answer}. ${q.choices.find(c => c[0] === q.answer)}`;
            sess.quizIndex++;
            if (sess.quizIndex < QUESTIONS.length) {
                await send(ctx, feedback);
                await sendQuestion(ctx, sess.quizIndex);
            } else {
                sess.totalScore += sess.quizScore;
                sess.gamesPlayed++;
                const score = sess.quizScore;
                sess.state = 'idle';
                sess.quizIndex = 0;
                sess.quizScore = 0;
                await sendRich(ctx,
                    `${feedback}\n\n🏁 Quiz complete! You scored ${score}/${QUESTIONS.length}.\nType /quiz to play again or /score for stats.`,
                    [{ label: '🔁 Play again', value: '/quiz' }, { label: '📊 My score', value: '/score' }]
                );
            }
            return;
        }
    }

    const lower = text.toLowerCase();

    if (lower === '/help' || lower === 'help') {
        await sendRich(ctx, '👋 Hi! I\'m the Demo Bot. Here\'s what I can do:', [
            { label: '🧠 Start Quiz', value: '/quiz' },
            { label: '🧮 Calculator', value: '/calc 12*34' },
            { label: '🎲 Roll Dice', value: '/roll 20' },
            { label: '📊 My Score', value: '/score' },
        ]);
        return;
    }

    if (lower === '/quiz' || lower === 'quiz') {
        sess.state = 'quiz';
        sess.quizIndex = 0;
        sess.quizScore = 0;
        await send(ctx, '🧠 Starting trivia quiz! 5 questions. Choose A, B, C, or D.');
        await sendQuestion(ctx, 0);
        return;
    }

    if (lower.startsWith('/calc ') || lower.startsWith('calc ')) {
        const expr = text.replace(/^\/?(calc\s+)/i, '').trim();
        await send(ctx, `🧮 ${expr} = ${safeCalc(expr)}`);
        return;
    }

    if (lower.startsWith('/roll') || lower.startsWith('roll')) {
        const parts = text.split(/\s+/);
        const sides = parseInt(parts[1]) || 6;
        if (sides < 2 || sides > 10000) { await send(ctx, 'Die must be between 2 and 10000 sides.'); return; }
        await send(ctx, `🎲 You rolled a ${Math.floor(Math.random() * sides) + 1} (d${sides})`);
        return;
    }

    if (lower.startsWith('/delay') || lower.startsWith('delay')) {
        if (!ctx.chatHandle) { await send(ctx, '⏳ /delay only works in chats.'); return; }
        const secs = Math.min(Math.max(parseInt(text.split(/\s+/)[1]) || 3, 1), 10);
        await bot.setTyping(ctx.chatHandle, true).catch(() => {});
        await new Promise(r => setTimeout(r, secs * 1000));
        await bot.setTyping(ctx.chatHandle, false).catch(() => {});
        await send(ctx, `⏳ Waited ${secs}s — here I am!`);
        return;
    }

    if (lower === '/score' || lower === 'score') {
        if (sess.gamesPlayed === 0) {
            await send(ctx, '📊 No quiz games played yet. Try /quiz!');
        } else {
            const avg = (sess.totalScore / (sess.gamesPlayed * QUESTIONS.length) * 100).toFixed(0);
            await send(ctx, `📊 Your stats: ${sess.totalScore} points across ${sess.gamesPlayed} game(s) (${avg}% avg). Type /quiz to play!`);
        }
        return;
    }

    await sendRich(ctx, `I don't understand "${text}". Try one of these:`, [
        { label: '❓ Help', value: '/help' },
        { label: '🧠 Quiz', value: '/quiz' },
    ]);
}

// ── Handlers ───────────────────────────────────────────────────────────────────

bot.onMessage(async (userId, content, messageId) => {
    await handleMessage({ userId }, content);
});

bot.onJoin(async (chatHandle, encryptionKey) => {
    console.log(`[Demo] Joined chat: ${chatHandle}`);
    saveChatKey(chatHandle, encryptionKey);
    await bot.sendToChat(chatHandle, '👋 Demo Bot here! Type /help to see what I can do.', encryptionKey);
});

bot.onLeave(async (chatHandle) => {
    console.log(`[Demo] Left chat: ${chatHandle}`);
    removeChatKey(chatHandle);
});

bot.onChatMessage(async (chatHandle, content, senderUserId, messageId) => {
    const encryptionKey = loadChatKeys()[chatHandle];
    if (!encryptionKey) return;
    await handleMessage({ chatHandle, userId: senderUserId, encryptionKey }, content);
});

bot.onMention(async (chatHandle, content, senderUserId, messageId) => {
    const encryptionKey = loadChatKeys()[chatHandle];
    if (!encryptionKey) return;
    // Strip leading @BotName prefix so commands work normally
    const mention = '@' + bot.name;
    const stripped = content.toLowerCase().startsWith(mention.toLowerCase())
        ? content.slice(mention.length).trimStart()
        : content.trim();
    await handleMessage({ chatHandle, userId: senderUserId, encryptionKey }, stripped);
});

bot.onError((err) => {
    console.error('[Demo] Error:', err.message);
});

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
    if (process.argv.includes('--activate')) {
        if (!INVITE_TOKEN || !SHARED_KEY) {
            console.error('Set BOT_INVITE_TOKEN and BOT_SHARED_KEY env vars before activating.');
            process.exit(1);
        }
        await bot.activate({
            inviteToken: INVITE_TOKEN,
            name: 'Demo Bot',
            description: 'Commands, trivia quiz, calculator, and dice roller.',
            svgIcon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
        });
        console.log('Activation complete. Run without --activate to start.');
        return;
    }

    await bot.start();

    // Restore chat keys from disk so onChatMessage works after restart
    const savedChats = loadChatKeys();
    for (const [chatHandle, encryptionKey] of Object.entries(savedChats)) {
        bot.setChatKey(chatHandle, encryptionKey);
        console.log(`[Demo] Restored key for chat: ${chatHandle}`);
    }

    await bot.setCommands([
        { name: 'help',  description: 'Show available commands' },
        { name: 'quiz',  description: 'Start a 5-question trivia quiz' },
        { name: 'calc',  description: 'Calculate an expression, e.g. /calc 12*34' },
        { name: 'roll',  description: 'Roll a die, e.g. /roll 20' },
        { name: 'delay', description: 'Simulate typing delay, e.g. /delay 3' },
        { name: 'score', description: 'Show your quiz stats' },
    ]).catch(e => console.warn('[Demo] setCommands failed:', e.message));

    process.on('SIGINT', () => { bot.stop(); process.exit(0); });
}

main().catch(e => { console.error(e); process.exit(1); });
