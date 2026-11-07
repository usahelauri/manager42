// Recreate content from the received Business Message; do not use forwardMessage
// or assume copyMessage can access a private business chat in the bot's namespace.
// No names, usernames, IDs or profile links are appended to manager messages.
export function contentRequest(message, chatId, threadId) {
  if (message.has_protected_content) throw new Error('Protected content requires manual handling');
  const base = { chat_id: chatId };
  if (threadId) base.message_thread_id = Number(threadId);
  if (message.text) return ['sendMessage', { ...base, text: message.text, ...(message.entities ? { entities: message.entities } : {}) }];
  const caption = message.caption === undefined ? {} : {
    caption: message.caption,
    ...(message.caption_entities ? { caption_entities: message.caption_entities } : {}),
    ...(message.show_caption_above_media ? { show_caption_above_media: true } : {})
  };
  if (message.photo?.length) return ['sendPhoto', { ...base, ...caption, photo: message.photo.at(-1).file_id, ...(message.has_media_spoiler ? { has_spoiler: true } : {}) }];
  for (const [field, method] of [['animation','sendAnimation'], ['video','sendVideo'], ['audio','sendAudio'], ['document','sendDocument'], ['voice','sendVoice'], ['video_note','sendVideoNote'], ['sticker','sendSticker']]) {
    if (message[field]) return [method, { ...base, ...(field === 'sticker' || field === 'video_note' ? {} : caption), [field]: message[field].file_id }];
  }
  throw new Error('Unsupported message type requires manual handling');
}
