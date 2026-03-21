'use strict';
/**
 * Demo Bot — commands, trivia quiz, calculator, dice roller.
 *
 * Setup (one-time):
 *   1. Admin generates invite via the Bots UI (+) button → copy inviteToken + sharedKey
 *   2. Set INVITE_TOKEN and SHARED_KEY below (or use env vars)
 *   3. Run: node example.js --activate
 *
 * Running:
 *   node example.js
 */

const { BotClient } = require('./bot-sdk');

const SERVER_URL   = process.env.BOT_SERVER_URL   || 'https://localhost:3000';
const SHARED_KEY   = process.env.BOT_SHARED_KEY   || '8d58fbab313ab5d0e434a63ce806dba4515e8991389155051ab80dd670748a81';
const INVITE_TOKEN = process.env.BOT_INVITE_TOKEN || 'e8cea16da41f7f7342fe3852d0f128377c4d82ce65d4d65ccd638517c493a86e';

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

// ── Per-user sessions ──────────────────────────────────────────────────────────

// Map<userId, { state, quizIndex, quizScore, totalScore, gamesPlayed }>
const sessions = new Map();

function getSession(userId) {
    if (!sessions.has(userId)) {
        sessions.set(userId, { state: 'idle', quizIndex: 0, quizScore: 0, totalScore: 0, gamesPlayed: 0 });
    }
    return sessions.get(userId);
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

async function sendQuestion(userId, qIndex) {
    const q = QUESTIONS[qIndex];
    await bot.replyRich(
        userId,
        `❓ Question ${qIndex + 1}/5: ${q.q}`,
        quizButtons(qIndex)
    );
}

// ── Message handler ────────────────────────────────────────────────────────────

bot.onMessage(async (userId, content, messageId) => {
    const text = (content || '').trim();
    const sess = getSession(userId);
    console.log(`[Demo] ${userId} [${sess.state}]: ${text}`);

    // ── Quiz answer handling ────────────────────────────────────────────────
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
                await bot.reply(userId, feedback);
                await sendQuestion(userId, sess.quizIndex);
            } else {
                sess.totalScore += sess.quizScore;
                sess.gamesPlayed++;
                const score = sess.quizScore;
                sess.state = 'idle';
                sess.quizIndex = 0;
                sess.quizScore = 0;
                await bot.replyRich(
                    userId,
                    `${feedback}\n\n🏁 Quiz complete! You scored ${score}/${QUESTIONS.length}.\nType /quiz to play again or /score for stats.`,
                    [{ label: '🔁 Play again', value: '/quiz' }, { label: '📊 My score', value: '/score' }]
                );
            }
            return;
        }
        // If not a valid answer letter, fall through to command handling
    }

    // ── Commands ────────────────────────────────────────────────────────────
    const lower = text.toLowerCase();

    if (lower === '/help' || lower === 'help') {
        await bot.replyRich(
            userId,
            '👋 Hi! I\'m the Demo Bot. Here\'s what I can do:',
            [
                { label: '🧠 Start Quiz', value: '/quiz' },
                { label: '🧮 Calculator', value: '/calc 12*34' },
                { label: '🎲 Roll Dice', value: '/roll 20' },
                { label: '📊 My Score', value: '/score' },
            ]
        );
        return;
    }

    if (lower === '/quiz' || lower === 'quiz') {
        sess.state = 'quiz';
        sess.quizIndex = 0;
        sess.quizScore = 0;
        await bot.reply(userId, '🧠 Starting trivia quiz! 5 questions. Choose A, B, C, or D.');
        await sendQuestion(userId, 0);
        return;
    }

    if (lower.startsWith('/calc ') || lower.startsWith('calc ')) {
        const expr = text.replace(/^\/?(calc\s+)/i, '').trim();
        const result = safeCalc(expr);
        await bot.reply(userId, `🧮 ${expr} = ${result}`);
        return;
    }

    if (lower.startsWith('/roll') || lower.startsWith('roll')) {
        const parts = text.split(/\s+/);
        const sides = parseInt(parts[1]) || 6;
        if (sides < 2 || sides > 10000) {
            await bot.reply(userId, 'Die must be between 2 and 10000 sides.');
            return;
        }
        const rolled = Math.floor(Math.random() * sides) + 1;
        await bot.reply(userId, `🎲 You rolled a ${rolled} (d${sides})`);
        return;
    }

    if (lower === '/score' || lower === 'score') {
        if (sess.gamesPlayed === 0) {
            await bot.reply(userId, '📊 No quiz games played yet. Try /quiz!');
        } else {
            const avg = (sess.totalScore / (sess.gamesPlayed * QUESTIONS.length) * 100).toFixed(0);
            await bot.reply(userId, `📊 Your stats: ${sess.totalScore} points across ${sess.gamesPlayed} game(s) (${avg}% avg). Type /quiz to play!`);
        }
        return;
    }

    // Default
    await bot.replyRich(
        userId,
        `I don't understand "${text}". Try one of these:`,
        [
            { label: '❓ Help', value: '/help' },
            { label: '🧠 Quiz', value: '/quiz' },
        ]
    );
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

    await bot.setCommands([
        { name: 'help',  description: 'Show available commands' },
        { name: 'quiz',  description: 'Start a 5-question trivia quiz' },
        { name: 'calc',  description: 'Calculate an expression, e.g. /calc 12*34' },
        { name: 'roll',  description: 'Roll a die, e.g. /roll 20' },
        { name: 'score', description: 'Show your quiz stats' },
    ]).catch(e => console.warn('[Demo] setCommands failed:', e.message));

    process.on('SIGINT', () => { bot.stop(); process.exit(0); });
}

main().catch(e => { console.error(e); process.exit(1); });
