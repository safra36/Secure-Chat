export interface BotClientOptions {
    /** e.g. 'https://localhost:3000' */
    serverUrl: string;
    /** 64-char hex string (32 bytes), from admin */
    sharedKey: string;
    /** Path to persist Ed25519 keys (default: ./bot-keys.json) */
    keysFile?: string;
    /** Inbox poll interval in ms (default: 2000) */
    pollInterval?: number;
}

export interface ActivateOptions {
    /** 64-char hex invite token from admin */
    inviteToken: string;
    /** Bot display name (max 64 chars) */
    name: string;
    /** Short description (max 256 chars) */
    description?: string;
    /** Raw SVG markup for bot icon (max 16KB) */
    svgIcon?: string;
}

export interface Button {
    label: string;
    value: string;
}

export interface BotCommand {
    name: string;
    description: string;
}

export type MessageHandler     = (userId: string, content: string, messageId: string) => void | Promise<void>;
export type ErrorHandler        = (error: Error) => void;
export type JoinHandler         = (chatHandle: string, encryptionKey: string) => void | Promise<void>;
export type LeaveHandler        = (chatHandle: string) => void | Promise<void>;
export type ChatMessageHandler  = (chatHandle: string, content: string, senderUserId: string, messageId: string) => void | Promise<void>;
export type MentionHandler      = (chatHandle: string, content: string, senderUserId: string, messageId: string) => void | Promise<void>;

export declare class BotClient {
    readonly serverUrl: string;
    readonly sharedKey: string;
    readonly keysFile: string;
    readonly stateFile: string;
    readonly pollInterval: number;
    botId: string | null;

    /** The bot's display name (available after start() or activate()). */
    readonly name: string;

    constructor(opts: BotClientOptions);

    /**
     * One-time activation. Generates Ed25519 + P-256 ECDH keys, registers with server.
     * Saves keys to keysFile. After this, call start() for polling.
     */
    activate(opts: ActivateOptions): Promise<{ botId: string }>;

    /** Start polling the inbox. Loads keys from keysFile. */
    start(): Promise<void>;

    /** Stop polling. */
    stop(): void;

    // ── Direct message API ──────────────────────────────────────────────────

    /** Send a text reply to a user in a direct bot conversation. */
    reply(userId: string, content: string): Promise<void>;

    /** Send a rich reply with glass buttons to a user in a direct bot conversation. */
    replyRich(userId: string, content: string, buttons: Button[]): Promise<void>;

    // ── Chat API ────────────────────────────────────────────────────────────

    /** Send a text message to a regular chat the bot has joined. */
    sendToChat(chatHandle: string, content: string, encryptionKey: string): Promise<void>;

    /** Send a rich message with glass buttons to a regular chat the bot has joined. */
    sendRichToChat(chatHandle: string, content: string, buttons: Button[], encryptionKey: string): Promise<void>;

    /**
     * Signal typing state in a chat. Clears automatically after 6s if not refreshed.
     */
    setTyping(chatHandle: string, isTyping: boolean): Promise<void>;

    /**
     * Pre-load a chat encryption key (e.g. restored from persistent storage on restart).
     * Must be called before start() or after start() before messages arrive.
     */
    setChatKey(chatHandle: string, encryptionKey: string): void;

    /** Register slash commands shown in the client autocomplete. */
    setCommands(commands: BotCommand[]): Promise<void>;

    // ── Event handlers ──────────────────────────────────────────────────────

    /** Called for each direct message received from a user. */
    onMessage(fn: MessageHandler): void;

    /** Called on errors during polling or message handling. */
    onError(fn: ErrorHandler): void;

    /** Called when bot is added to a chat. Provides the plaintext encryptionKey — persist it. */
    onJoin(fn: JoinHandler): void;

    /** Called when bot is removed from a chat. */
    onLeave(fn: LeaveHandler): void;

    /** Called for each message in a chat the bot has joined. */
    onChatMessage(fn: ChatMessageHandler): void;

    /**
     * Called when the bot is @mentioned in a chat message.
     * Falls back to onChatMessage handler if not registered.
     */
    onMention(fn: MentionHandler): void;
}
