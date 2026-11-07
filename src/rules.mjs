export const DEFAULT_PRODUCTS = 'пюре,сироп,манго,маракуйя,маракуйи,малина,клубника,персик,вишня,личи,гуава,ананас,облепиха,смородина';
const QUESTION = /\?|(?:^|\s)(?:как|когда|почему|сколько|можно\s+ли|подскажите|уточните|есть\s+ли)(?:\s|[,.!?:]|$)|нет\s+в\s+наличии|не\s+привезли|не\s+доставили|замен[аыу]|возврат|претенз|отмен|цена|стоимость|прайс|скидк|долг|сч[её]т\s+на\s+оплату/iu;
const SIMPLE = /^(?:(?:здравствуйте|здравствуй|добрый\s+(?:день|вечер)|доброе\s+утро|привет|спасибо|благодарю|пожалуйста|ок|окей|хорошо|понял[аи]?|принято|до\s+свидания)[\s,.!🙏👍]*)+$/iu;
const UNIT_QUANTITY = /(?<!\d)\d{1,4}(?:[.,]\d{1,2})?\s*(?:шт(?:ук[аи]?)?|кг|килограмм\p{L}*|л(?:итр\p{L}*)?|уп(?:ак\p{L}*)?|бут\p{L}*|пак\p{L}*|кор\p{L}*|кан\p{L}*)(?!\p{L})/iu;
const LINE_QUANTITY = /(?:[-—–:=]\s*|\s)\d{1,3}(?:[.,]\d{1,2})?\s*(?:шт\.?|кг|л)?\s*[,.!;]?$/iu;
export function classify(messages, productWords = DEFAULT_PRODUCTS) {
  if (messages.some(m => m.has_protected_content)) return 'review';
  const text = messages.map(m => m.text || m.caption || '').join('\n').trim();
  if (messages.some(m => m.voice || m.video_note || m.sticker || m.contact || m.location || m.poll || m.rich_message)) return 'review';
  if (!text) return 'review';
  if (QUESTION.test(text)) return 'review';
  const products = productWords.toLocaleLowerCase('ru').split(',').map(x => x.trim()).filter(Boolean);
  const lines = text.toLocaleLowerCase('ru').split('\n');
  const isOrder = lines.some(line => products.some(p => line.includes(p)) && (UNIT_QUANTITY.test(line) || LINE_QUANTITY.test(line)));
  if (isOrder) return 'order';
  if (SIMPLE.test(text) && messages.every(m => m.text && !m.photo && !m.document)) return 'ignore';
  return 'review';
}
export function benignManagerReply(text) {
  return /^(?:ок(?:ей)?|хорошо|спасибо|принят[оа]?|оформлен[оа]?|готов[оа]?|отгружен[оа]?|сделан[оа]?)[\s.!👍✅]*$/iu.test((text || '').trim());
}
export function plainPreview(messages, limit = 2200) {
  return messages.map(m => m.text || m.caption || (m.voice ? '[Голосовое сообщение]' : m.photo ? '[Фото]' : m.document ? '[Документ]' : '[Вложение]')).join('\n\n').slice(0, limit);
}
