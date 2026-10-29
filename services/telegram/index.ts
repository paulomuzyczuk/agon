// Public surface of the Telegram command layer.
export { parseCommand, CommandError, type ParsedCommand } from './commands';
export {
  executeCommand,
  handleCommandText,
  type CommandContext,
} from './handlers';
export {
  dispatchTelegramUpdate,
  summarizeVoiceResult,
  type TelegramDeps,
} from './dispatch';
export {
  sendMessage,
  getUpdates,
  downloadFile,
  getBotToken,
  telegramUpdateSchema,
  type TelegramUpdate,
  type TelegramFile,
} from './api';
export { checkSender, parseOwnerChatId, type Access } from './access';
