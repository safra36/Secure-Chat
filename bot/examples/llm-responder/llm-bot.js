'use strict';
/**
 * LLM Responder Bot — powered by Qwen3-30B via ArvanCloud AI Gateway.
 *
 * Direct chats : full conversation context, auto-summarized at ~25 K tokens.
 * Group chats  : responds ONLY on @mention, no history collected.
 *
 * Setup (one-time):
 *   1. Admin generates invite → copy inviteToken + sharedKey
 *   2. Set env vars or edit the constants below
 *   3. node llm-bot.js --activate
 *
 * Running:
 *   node llm-bot.js
 */

const { BotClient } = require('./bot-sdk');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const SERVER_URL   = process.env.BOT_SERVER_URL   || '';
const SHARED_KEY   = process.env.BOT_SHARED_KEY   || '';
const INVITE_TOKEN = process.env.BOT_INVITE_TOKEN || '';

const LLM_BASE     = '';
const LLM_API_KEY  = '';
const LLM_MODEL    = '';

// Compact history when total characters exceed this (~25 K tokens)
const COMPACT_THRESHOLD = 100_000;
// Keep this many recent messages intact when compacting
const KEEP_RECENT = 6;

const SYSTEM_PROMPT = `You are a helpful, friendly AI assistant inside a secure chat application.

CRITICAL RULE: You MUST always respond with a single valid JSON object. Never output plain text outside JSON.

=== RESPONSE SCHEMA ===
{
  "content":     string  (REQUIRED) — main reply text; markdown supported,
  "title":       string  (optional) — short heading shown above the message,
  "footer":      string  (optional) — small note shown below the message,
  "imageUrl":    string  (optional) — direct image URL (only if you have a real URL),
  "layout":      "default" | "card" | "compact"  (optional, default "default"),
  "singleSelect": boolean  (optional, default true),
  "buttons": [{ "label": string, "value": string, "type": "reply" | "link" }]  (optional),
  "elements": [ ...interactive elements... ]  (optional)
}

=== CONTENT FIELD ===
- Always required; never empty.
- Markdown supported: **bold**, *italic*, ~~strike~~, \`inline code\`, \`\`\`lang\\ncode\`\`\`, [text](url), - unordered list, 1. ordered list, > blockquote, ## heading (H1–H6)
- NEVER use empty code fences (\`\`\`\`\`\`) as separators or dividers — they render as blank boxes
- Use line breaks (\\n) for structure. Prefer short paragraphs.
- Be honest: if unsure say so — never invent facts.

=== LAYOUT ===
"default"  → standard bubble (most replies, conversational answers)
"card"     → visible card border; use for structured info, reference material, comparisons, code guides
"compact"  → tight small buttons; use when offering 4+ short quick-reply choices

=== TITLE (optional) ===
- Add when layout is "card" or the response has a clear topic heading.
- Keep short: 3–8 words. Examples: "Python Quick Reference", "3 Options", "How it works"

=== BUTTONS (optional) ===
- "reply" type: clicking sends the button's value as a chat message. Use for: follow-up questions,
  menu choices, /commands, topic selection.
- "link" type: clicking opens value URL in a new tab. Use for: docs, external resources, source links.
- 2–5 buttons max. Labels: 1–4 words. Values: what makes sense to say/open.
- singleSelect: true (default) — disables all buttons after one is clicked (use for single-choice menus)
- singleSelect: false — keeps buttons active after click (use for persistent navigation like "View docs")

=== FOOTER (optional) ===
- Use for: disclaimers, "info as of [date]", source attribution, helpful hints.
- 1 short sentence max.

=== LIMITATIONS (be upfront, never pretend you can do these) ===
- Images: cannot view, analyze, or generate images. If asked, say so clearly.
- URLs/links: cannot visit, fetch, or read any URL. Do not pretend to browse the web.
- Files: cannot create, download, read, or save files of any kind.
- Real-time data: no live search, no current news, no stock prices, weather, etc. Knowledge has a cutoff.
- If asked to do any of the above, acknowledge the limitation honestly and offer what you *can* do instead.

=== INTERACTIVE ELEMENTS (optional) ===
Add an "elements" array to collect structured input from the user.

Element types:
- { "type": "input", "id": "name", "label": "Your name", "placeholder": "Enter...", "multiline": false, "required": true, "maxLength": 200 }
- { "type": "select", "id": "lang", "label": "Language", "placeholder": "Choose...", "options": [{"label":"Python","value":"python"}], "required": true }
- { "type": "toggle", "id": "anon", "label": "Submit anonymously", "default": false }
- { "type": "form", "id": "my-form", "submitLabel": "Send", "elements": [ ...inputs/selects/toggles... ] }

Standalone elements (not in a form) are rendered inline — the user can fill them in but there is no submit action. Wrap them in a "form" element when you need a submit button.

When submitted, the client sends: [form:my-form] {"name":"Alice","lang":"python","anon":false}

=== HANDLING FORM SUBMISSIONS ===
If a user message starts with [form:id], parse it and respond to the data. Example:
User: "[form:feedback-form] {"rating":"5","comment":"Great!"}"
→ Extract the JSON, acknowledge the submission, and act on the values.

=== WHEN TO USE ELEMENTS ===
✓ Collecting structured input (surveys, settings, preferences)
✓ When a free-text answer would be ambiguous (use select)
✓ Multi-field data collection (use form wrapper)
✗ Don't add forms just to look fancy — only when structured input genuinely helps

=== WHEN TO USE BUTTONS ===
✓ User asks an open question where you can offer to go deeper on sub-topics
✓ Multiple distinct options exist (e.g. language choice, action choice)
✓ Navigational follow-ups ("Want an example?", "Which part?")
✗ Don't add buttons just to fill space — only when they genuinely help

=== EXAMPLES ===

Simple factual answer:
{"content": "The capital of France is **Paris**."}

Conversational with follow-ups:
{"content": "I can help with that! What would you like to know?", "buttons": [{"label": "Explain concept", "value": "explain the concept", "type": "reply"}, {"label": "Show example", "value": "show me an example", "type": "reply"}, {"label": "Something else", "value": "I need help with something else", "type": "reply"}]}

Code reference card:
{"content": "Use \`Array.map()\` to transform every element:\\n\`\`\`js\\nconst doubled = [1,2,3].map(x => x * 2);\\n// [2, 4, 6]\`\`\`", "title": "JavaScript: Array.map()", "layout": "card", "footer": "map() always returns a new array of the same length.", "buttons": [{"label": "More examples", "value": "show more map examples", "type": "reply"}, {"label": "MDN Docs", "value": "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map", "type": "link"}], "singleSelect": false}

Multi-topic compact menu:
{"content": "I can help with several things. Pick a topic:", "layout": "compact", "buttons": [{"label": "Python", "value": "help me with Python", "type": "reply"}, {"label": "JavaScript", "value": "help me with JavaScript", "type": "reply"}, {"label": "SQL", "value": "help me with SQL", "type": "reply"}, {"label": "Other", "value": "I need help with something else", "type": "reply"}]}

Uncertain answer:
{"content": "I'm not sure about that — I don't have reliable information on this topic. Here's what I do know: ..."}

Feedback form:
{"content": "Please share your feedback:", "elements": [{"type": "form", "id": "feedback", "submitLabel": "Send Feedback", "elements": [{"type": "input", "id": "name", "label": "Name", "placeholder": "Your name"}, {"type": "select", "id": "rating", "label": "Rating", "options": [{"label": "⭐", "value": "1"}, {"label": "⭐⭐", "value": "2"}, {"label": "⭐⭐⭐", "value": "3"}, {"label": "⭐⭐⭐⭐", "value": "4"}, {"label": "⭐⭐⭐⭐⭐", "value": "5"}]}, {"type": "input", "id": "comment", "label": "Comment", "multiline": true, "placeholder": "Tell us more..."}, {"type": "toggle", "id": "anonymous", "label": "Submit anonymously", "default": false}]}]}
`;

// ── Bot client ────────────────────────────────────────────────────────────────

const bot = new BotClient({
    serverUrl: SERVER_URL,
    sharedKey: SHARED_KEY,
    keysFile: './llm-bot-keys.json',
});

// ── Chat key persistence ──────────────────────────────────────────────────────

const CHATS_FILE = path.join(process.cwd(), 'llm-bot-chats.json');

function loadChatKeys() {
    try { return fs.existsSync(CHATS_FILE) ? JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')) : {}; }
    catch { return {}; }
}
function saveChatKey(handle, key) {
    const m = loadChatKeys(); m[handle] = key;
    fs.writeFileSync(CHATS_FILE, JSON.stringify(m, null, 2));
}
function removeChatKey(handle) {
    const m = loadChatKeys(); delete m[handle];
    fs.writeFileSync(CHATS_FILE, JSON.stringify(m, null, 2));
}

// ── Conversation history (direct chats only) ──────────────────────────────────

// Map<userId, { messages: Array<{role,content}>, summary: string|null }>
const histories = new Map();

// ── Group chat short-term context (mention threads) ───────────────────────────

// Map<chatHandle, Array<{role,content}>> — rolling window, no compaction needed
const chatHistories = new Map();
const CHAT_HISTORY_MAX = 12;

function getChatHistory(chatHandle) {
    if (!chatHistories.has(chatHandle)) chatHistories.set(chatHandle, []);
    return chatHistories.get(chatHandle);
}

function getHistory(userId) {
    if (!histories.has(userId)) histories.set(userId, { messages: [], summary: null });
    return histories.get(userId);
}

function charCount(h) {
    return (h.summary ? h.summary.length : 0) +
        h.messages.reduce((n, m) => n + m.content.length, 0);
}

// ── LLM HTTP call ─────────────────────────────────────────────────────────────

const RETRYABLE = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

async function callLLM(messages, label, structured = false, _attempt = 1) {
    try {
        return await _callLLMOnce(messages, label, structured);
    } catch (e) {
        if (_attempt < 3 && (RETRYABLE.has(e.code) || /timed out/i.test(e.message))) {
            const delay = _attempt * 3000;
            console.warn(`[LLM${label ? '/' + label : ''}] Retrying (attempt ${_attempt + 1}) after ${delay}ms — ${e.message}`);
            await new Promise(r => setTimeout(r, delay));
            return callLLM(messages, label, structured, _attempt + 1);
        }
        throw e;
    }
}

function _callLLMOnce(messages, label, structured = false) {
    return new Promise((resolve, reject) => {
        const payload = { model: LLM_MODEL, messages, max_tokens: structured ? 2048 : 1024, temperature: 0.7 };
        if (structured) payload.response_format = { type: 'json_object' };
        const body    = JSON.stringify(payload);
        const parsed  = new URL(`${LLM_BASE}/chat/completions`);
        const tag     = `[LLM${label ? '/' + label : ''}]`;

        console.log(`${tag} → ${messages.length} messages, ~${body.length} chars`);
        messages.forEach((m, i) => {
            const preview = m.content.length > 100 ? m.content.slice(0, 100) + '…' : m.content;
            console.log(`  [${i}] ${m.role}: ${preview}`);
        });

        const t0      = Date.now();
        let settled   = false;
        const done    = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };

        const timer = setTimeout(() => {
            done(() => {
                console.error(`${tag} ✖ Timeout after 90s`);
                req.destroy();
                reject(new Error('LLM request timed out after 90s'));
            });
        }, 90_000);

        const req = https.request({
            hostname: parsed.hostname,
            path:     parsed.pathname,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'apikey ' + LLM_API_KEY },
        }, res => {
            let data = '';
            res.on('data', c => (data += c));
            res.on('end', () => {
                const ms = Date.now() - t0;
                console.log(`${tag} ← HTTP ${res.statusCode} in ${ms}ms`);
                done(() => {
                    try {
                        const json = JSON.parse(data);
                        if (json.choices?.[0]?.message?.content) {
                            const reply   = json.choices[0].message.content.trim();
                            const usage   = json.usage ? ` | prompt=${json.usage.prompt_tokens} completion=${json.usage.completion_tokens}` : '';
                            const preview = reply.length > 100 ? reply.slice(0, 100) + '…' : reply;
                            console.log(`${tag}   reply (${reply.length} chars${usage}): ${preview}`);
                            return resolve(reply);
                        }
                        if (json.error) return reject(new Error(json.error.message || 'API error'));
                        reject(new Error('Unexpected response: ' + data.slice(0, 200)));
                    } catch (e) { reject(e); }
                });
            });
        });
        req.on('error', e => done(() => reject(e)));
        req.write(body);
        req.end();
    });
}

// ── Rich response parser ──────────────────────────────────────────────────────

function parseRichResponse(raw) {
    try {
        // Strip Qwen3 thinking blocks if present
        const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        const obj = JSON.parse(stripped);
        const content = (typeof obj.content === 'string' && obj.content.trim()) ? obj.content.trim() : raw;
        const rc = {};
        if (obj.title)                           rc.title       = String(obj.title);
        if (obj.footer)                          rc.footer      = String(obj.footer);
        if (obj.imageUrl)                        rc.imageUrl    = String(obj.imageUrl);
        if (obj.layout && obj.layout !== 'default') rc.layout  = obj.layout;
        if (obj.singleSelect === false)          rc.singleSelect = false;
        if (Array.isArray(obj.buttons) && obj.buttons.length > 0) rc.buttons = obj.buttons;
        if (Array.isArray(obj.elements) && obj.elements.length > 0) rc.elements = obj.elements;
        return { content, richContent: Object.keys(rc).length > 0 ? rc : null };
    } catch {
        return { content: raw, richContent: null };
    }
}

// ── Compaction ────────────────────────────────────────────────────────────────

async function maybeCompact(h) {
    if (charCount(h) <= COMPACT_THRESHOLD) return;
    const old  = h.messages.slice(0, -KEEP_RECENT);
    if (old.length < 2) return;
    const text = old.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
    const prev = h.summary ? `Previous summary:\n${h.summary}\n\n` : '';
    try {
        console.log('[LLM Bot] Compacting history...');
        h.summary  = await callLLM([
            { role: 'system', content: 'Summarize the following conversation concisely, retaining key facts, topics, and context needed to continue naturally.' },
            { role: 'user',   content: `${prev}Conversation:\n${text}` },
        ], 'compact');
        h.messages = h.messages.slice(-KEEP_RECENT);
        console.log('[LLM Bot] History compacted. Summary length:', h.summary.length);
    } catch (e) { console.error('[LLM Bot] Compaction failed:', e.message); }
}

// ── Response helpers ──────────────────────────────────────────────────────────

const ERR_MSG = "I'm sorry, I ran into a problem reaching the AI service. Please try again in a moment.";

async function answerDirect(userId, text) {
    const h = getHistory(userId);
    h.messages.push({ role: 'user', content: text });
    console.log(`[Direct] user=${userId}  history=${h.messages.length} msgs  chars=${charCount(h)}`);
    await maybeCompact(h);

    const msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (h.summary) msgs.push({ role: 'system', content: `Context from earlier:\n${h.summary}` });
    msgs.push(...h.messages);

    try {
        const raw = await callLLM(msgs, 'direct', true);
        const { content, richContent } = parseRichResponse(raw);
        h.messages.push({ role: 'assistant', content });
        return { content, richContent };
    } catch (e) {
        console.error('[Direct] LLM error:', e.message);
        h.messages.pop();
        return { content: ERR_MSG, richContent: null };
    }
}

async function answerInChat(chatHandle, text, replyTo) {
    // No reply = new topic; wipe context so previous chain doesn't bleed in
    if (!replyTo) chatHistories.delete(chatHandle);
    const buf = getChatHistory(chatHandle);

    // Store clean text — reply prefix is transient context, not history
    buf.push({ role: 'user', content: text });
    if (buf.length > CHAT_HISTORY_MAX) buf.splice(0, buf.length - CHAT_HISTORY_MAX);

    // Build LLM call: apply reply prefix only to the current (last) user message
    const msgs = [{ role: 'system', content: SYSTEM_PROMPT }, ...buf.slice(0, -1)];
    let lastContent = text;
    if (replyTo && replyTo.preview) {
        const who = replyTo.senderName || 'someone';
        lastContent = `[Replying to ${who}: "${replyTo.preview}"]\n${text}`;
    }
    msgs.push({ role: 'user', content: lastContent });

    console.log(`[Mention] chat=${chatHandle}  ctx=${buf.length} msgs  text: ${text.length > 80 ? text.slice(0, 80) + '…' : text}`);
    try {
        const raw = await callLLM(msgs, 'mention', true);
        const { content, richContent } = parseRichResponse(raw);
        buf.push({ role: 'assistant', content });
        if (buf.length > CHAT_HISTORY_MAX) buf.splice(0, buf.length - CHAT_HISTORY_MAX);
        return { content, richContent };
    } catch (e) {
        console.error('[Mention] LLM error:', e.message);
        buf.pop(); // remove failed user turn
        return { content: ERR_MSG, richContent: null };
    }
}

// ── Event handlers ────────────────────────────────────────────────────────────

// Parse [form:id] {json} into a readable description for the LLM
function _formatFormSubmission(text) {
    const m = text.match(/^\[form:([^\]]+)\]\s*(\{[\s\S]*\})$/);
    if (!m) return text;
    try {
        const values = JSON.parse(m[2]);
        const lines = Object.entries(values).map(([k, v]) => `• ${k}: ${v}`).join('\n');
        return `[Form submission: ${m[1]}]\n${lines}`;
    } catch { return text; }
}

bot.onMessage(async (userId, content) => {
    const text = (content || '').trim();
    if (!text) return;

    if (text.toLowerCase() === '/clear') {
        histories.delete(userId);
        console.log(`[Direct] Cleared history for user=${userId}`);
        await bot.replyRich(userId, 'Conversation history cleared.', {
            title: 'History Cleared',
            layout: 'card',
            buttons: [{ label: 'Start fresh', value: 'Hello!', type: 'reply' }],
        });
        return;
    }

    const { content: reply, richContent } = await answerDirect(userId, _formatFormSubmission(text));
    console.log(`[Direct] Sending reply to user=${userId}  len=${reply.length}`);
    try {
        await bot.replyRich(userId, reply, richContent || {});
        console.log(`[Direct] Reply delivered OK`);
    } catch (e) {
        console.error(`[Direct] bot.replyRich() FAILED:`, e.message);
    }
});

bot.onJoin(async (chatHandle, encryptionKey) => {
    console.log(`[LLM Bot] Joined chat: ${chatHandle}`);
    saveChatKey(chatHandle, encryptionKey);
    await bot.sendRichToChat(
        chatHandle,
        `Hi! I'm an AI assistant. Mention me with **@${bot.name}** and I'll do my best to help.`,
        {
            title: 'AI Assistant joined',
            layout: 'card',
            footer: 'Powered by Qwen3. Only responds to @mentions.',
            buttons: [{ label: `@${bot.name} hello`, value: `@${bot.name} hello`, type: 'reply' }],
            singleSelect: false,
        },
        encryptionKey,
    );
});

bot.onLeave(async (chatHandle) => {
    console.log(`[LLM Bot] Left chat: ${chatHandle}`);
    removeChatKey(chatHandle);
    chatHistories.delete(chatHandle);
});

// No onChatMessage — only respond to mentions in group chats

bot.onMention(async (chatHandle, content, senderUserId, messageId, replyTo, senderName) => {
    const encryptionKey = loadChatKeys()[chatHandle];
    if (!encryptionKey) return;

    // Strip leading @BotName
    const mention  = '@' + bot.name;
    const stripped = content.toLowerCase().startsWith(mention.toLowerCase())
        ? content.slice(mention.length).trimStart()
        : content.trim();
    if (!stripped) return;

    console.log(`[Mention] chat=${chatHandle}  from=${senderUserId}${replyTo ? '  [reply]' : ''}`);
    await bot.setTyping(chatHandle, true).catch(() => {});
    const _typingKeepAlive = setInterval(() => bot.setTyping(chatHandle, true).catch(() => {}), 5000);
    const { content: reply, richContent } = await answerInChat(chatHandle, _formatFormSubmission(stripped), replyTo);
    clearInterval(_typingKeepAlive);
    await bot.setTyping(chatHandle, false).catch(() => {});
    console.log(`[Mention] Sending reply to chat=${chatHandle}  len=${reply.length}`);
    await bot.sendRichToChat(chatHandle, reply, richContent || {}, encryptionKey, {
        messageId,
        preview: stripped,
        senderName: senderName || senderUserId,
    });
});

bot.onError(e => console.error('[LLM Bot] Error:', e.message));

// ── SVG icon ──────────────────────────────────────────────────────────────────

const BOT_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="4" y="6" width="16" height="13" rx="3"/>
  <line x1="8"  y1="6"  x2="8"  y2="3"/>
  <line x1="12" y1="6"  x2="12" y2="2"/>
  <line x1="16" y1="6"  x2="16" y2="3"/>
  <circle cx="12" cy="2" r="0.8" fill="currentColor" stroke="none"/>
  <circle cx="9"  cy="12" r="1.6" fill="currentColor" stroke="none"/>
  <circle cx="15" cy="12" r="1.6" fill="currentColor" stroke="none"/>
  <path d="M9 16 Q12 18.2 15 16" stroke-width="1.5"/>
  <line x1="4" y1="11" x2="2" y2="11"/>
  <line x1="4" y1="14" x2="2" y2="14"/>
  <line x1="20" y1="11" x2="22" y2="11"/>
  <line x1="20" y1="14" x2="22" y2="14"/>
</svg>`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    if (process.argv.includes('--activate')) {
        if (!INVITE_TOKEN || !SHARED_KEY) {
            console.error('Set BOT_INVITE_TOKEN and BOT_SHARED_KEY before activating.');
            process.exit(1);
        }
        await bot.activate({
            inviteToken: INVITE_TOKEN,
            name:        'AI Assistant',
            description: 'Intelligent assistant powered by Qwen3. Chat directly for context-aware conversations, or @mention in group chats.',
            svgIcon:     BOT_ICON,
        });
        console.log('Activation complete. Run without --activate to start.');
        return;
    }

    await bot.start();

    // Restore persisted chat keys
    for (const [handle, key] of Object.entries(loadChatKeys())) {
        bot.setChatKey(handle, key);
        console.log(`[LLM Bot] Restored key for: ${handle}`);
    }

    await bot.setCommands([
        { name: 'clear', description: 'Clear your conversation history (direct chat only)' },
    ]).catch(e => console.warn('[LLM Bot] setCommands failed:', e.message));

    process.on('SIGINT', () => { bot.stop(); process.exit(0); });
    console.log('[LLM Bot] Running.');
}

main().catch(e => { console.error(e); process.exit(1); });
