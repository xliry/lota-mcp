// ── Telegram API ────────────────────────────────────────────────

interface TelegramConfig {
  telegramBotToken: string;
  telegramChatId: string;
  configPath: string;
}

async function tgApi(botToken: string, method: string, body?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as { ok: boolean; result?: unknown; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

export async function tgSend(config: TelegramConfig, text: string, inlineKeyboard?: unknown[][]): Promise<unknown> {
  if (!config.telegramBotToken || !config.telegramChatId) return null;
  const body: Record<string, unknown> = {
    chat_id: config.telegramChatId,
    text,
    parse_mode: "Markdown",
  };
  if (inlineKeyboard) {
    body.reply_markup = { inline_keyboard: inlineKeyboard };
  }
  return await tgApi(config.telegramBotToken, "sendMessage", body);
}

export async function tgSetupChatId(config: TelegramConfig): Promise<string> {
  const { readFileSync, writeFileSync } = await import("node:fs");

  // Poll for /start message to discover chat_id
  console.log("\n  Waiting for you to send /start to your Telegram bot...");
  let lastUpdateId = 0;
  for (let attempt = 0; attempt < 60; attempt++) { // 5 minutes max
    const data = await tgApi(config.telegramBotToken, "getUpdates", {
      offset: lastUpdateId + 1,
      timeout: 5,
    }) as Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }>;

    for (const update of data) {
      lastUpdateId = update.update_id;
      if (update.message?.text === "/start") {
        const chatId = String(update.message.chat.id);
        // Save to .mcp.json
        if (config.configPath) {
          let cfg: { mcpServers?: { lota?: { env?: Record<string, string> } } };
          try { cfg = JSON.parse(readFileSync(config.configPath, "utf-8")); } catch { continue; }
          if (cfg.mcpServers?.lota?.env) {
            cfg.mcpServers.lota.env.TELEGRAM_CHAT_ID = chatId;
            writeFileSync(config.configPath, JSON.stringify(cfg, null, 2) + "\n");
          }
        }
        // Send confirmation
        await tgApi(config.telegramBotToken, "sendMessage", {
          chat_id: chatId,
          text: "✅ Connected to Lota! You'll receive task notifications and approval requests here.",
        });
        return chatId;
      }
    }
  }
  throw new Error("Telegram setup timed out. Send /start to your bot and try again.");
}

export async function tgWaitForApproval(config: TelegramConfig, taskId: number, taskTitle: string): Promise<boolean> {
  // Send approval request with inline buttons
  await tgSend(config, `📋 *Plan ready for approval*\n\nTask #${taskId}: ${taskTitle}\n\nReview the plan and approve or reject:`, [
    [
      { text: "✅ Approve", callback_data: `approve_${taskId}` },
      { text: "❌ Reject", callback_data: `reject_${taskId}` },
    ],
  ]);

  // Poll for callback response (30 min timeout to prevent infinite hang)
  const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  let lastUpdateId = 0;
  while (Date.now() < deadline) {
    const data = await tgApi(config.telegramBotToken, "getUpdates", {
      offset: lastUpdateId + 1,
      timeout: 30, // long poll
    }) as Array<{
      update_id: number;
      callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
    }>;

    for (const update of data) {
      lastUpdateId = update.update_id;
      const cb = update.callback_query;
      if (!cb?.data) continue;

      // Acknowledge the button press
      await tgApi(config.telegramBotToken, "answerCallbackQuery", { callback_query_id: cb.id });

      if (cb.data === `approve_${taskId}`) {
        await tgSend(config, `🚀 Task #${taskId} approved! Executing now.`);
        return true;
      }
      if (cb.data === `reject_${taskId}`) {
        await tgSend(config, `⏸ Task #${taskId} rejected. Add a comment on GitHub with feedback.`);
        return false;
      }
    }
  }

  // Timeout reached — reject by default
  await tgSend(config, `⏸ Task #${taskId} approval timed out (30 min). Skipping.`);
  return false;
}
