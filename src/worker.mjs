import { classify, benignManagerReply, plainPreview } from './rules.mjs';
import { contentRequest } from './media.mjs';

const DAY = 86400000;
const HELP = 'Копирую заказы в рабочую группу. /id — ID пользователя и чата. Администраторам в личном чате: /status, /pause ID_КЛИЕНТА, /resume ID_КЛИЕНТА. Менеджерам: отвечайте реплаем на скопированный заказ. Нестандартные сообщения передаются администраторам.';
const json = (value, status = 200) => Response.json(value, { status });
const keyOf = (prefix, id) => `${prefix}:${id}`;
class Retry extends Error { constructor(seconds = 10) { super('retry'); this.seconds = seconds; } }
class Review extends Error { constructor(reason) { super(reason); } }

export async function validSecret(actual, expected) {
  if (!actual || !expected) return false;
  const bytes = new TextEncoder();
  const [a,b] = await Promise.all([actual,expected].map(s => crypto.subtle.digest('SHA-256',bytes.encode(s))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let difference = 0;
  for (let i=0;i<aa.length;i++) difference |= aa[i] ^ bb[i];
  return difference === 0;
}

const WEBHOOK_UPDATES = ['message','business_connection','business_message','edited_business_message','deleted_business_messages'];

// Cloudflare's cron registers the bot after runtime secrets are configured.
// The Telegram token never has to be copied into a build variable or a URL.
export async function ensureWebhook(env) {
  if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !env.WEBHOOK_URL) return false;
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.WEBHOOK_SECRET)) throw new Error('Invalid webhook secret');
  let target;
  try { target = new URL(env.WEBHOOK_URL); } catch { throw new Error('Invalid webhook URL'); }
  if (target.protocol !== 'https:' || target.pathname !== '/telegram' || target.search || target.hash || target.username || target.password) throw new Error('Invalid webhook URL');
  const api = async (method, body = {}) => {
    const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(`Telegram ${method} failed`);
    return result.result;
  };
  const current = await api('getWebhookInfo');
  if (current.url === target.href && WEBHOOK_UPDATES.every(update => current.allowed_updates?.includes(update))) return true;
  await api('setWebhook', {url:target.href, secret_token:env.WEBHOOK_SECRET, max_connections:1, drop_pending_updates:false, allowed_updates:WEBHOOK_UPDATES});
  return true;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(ensureWebhook(env));
  },
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return json({service:'telegram-order-manager', running:true});
    if (path !== '/telegram' || request.method !== 'POST') return new Response('Not found',{status:404});
    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !env.MANAGER) return new Response('Setup incomplete',{status:503});
    if (!await validSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.WEBHOOK_SECRET)) return new Response('Forbidden',{status:403});
    if (Number(request.headers.get('Content-Length') || 0) > 1048576) return new Response('Too large',{status:413});
    const text = await request.text();
    if (text.length > 1048576) return new Response('Too large',{status:413});
    let update;
    try { update = JSON.parse(text); } catch { return new Response('Invalid JSON',{status:400}); }
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return new Response('Invalid update',{status:400});
    const stub = env.MANAGER.get(env.MANAGER.idFromName('orders-v1'));
    return stub.fetch(new Request('https://internal/enqueue',{method:'POST',body:JSON.stringify(update)}));
  }
};

export class OrderManager {
  constructor(ctx, env) { this.ctx=ctx; this.db=ctx.storage; this.env=env; this.tail=Promise.resolve(); }
  serial(fn) { const task=this.tail.then(fn); this.tail=task.catch(()=>{}); return task; }
  async fetch(request) {
    return this.serial(async()=>{
      const update=await request.json(), id=String(update.update_id).padStart(16,'0');
      if (!await this.db.get(`done:${id}`) && !await this.db.get(`queue:${id}`)) {
        await this.db.put(`queue:${id}`,{update,due:Date.now(),attempts:0,ts:Date.now()});
      }
      // Always re-arm, including redelivery after a crash between put and setAlarm.
      await this.arm();
      return json({ok:true});
    });
  }
  async alarm() {
    return this.serial(async()=>{
      this.deadline=Date.now()+20000;
      // Recovery alarm is persisted before any network side effect.
      await this.db.setAlarm(Date.now()+60000);
      const queued=await this.db.list({prefix:'queue:',limit:50});
      for (const [key,job] of queued) {
        if (Date.now()>this.deadline || job.due>Date.now()) break;
        await this.runTask(key,job,()=>this.handleUpdate(job.update));
      }
      // Drain received updates before dispatching a batch, so edits and manual
      // replies already in the inbox can cancel a queued automatic response.
      const remaining=await this.db.list({prefix:'queue:',limit:1});
      if (!remaining.size) {
        const batches=await this.db.list({prefix:'batch:',limit:1000});
        for (const [key,job] of batches) {
          if (Date.now()>this.deadline) break;
          if (job.due<=Date.now()) await this.runTask(key,job,()=>this.flush(job));
        }
      }
      await this.cleanup();
      await this.arm();
    });
  }
  async runTask(key,job,fn) {
    try {
      await fn();
      if (key.startsWith('queue:')) await this.db.put(key.replace('queue:','done:'),{ts:Date.now()});
      await this.db.delete(key);
    } catch(error) {
      if (error instanceof Retry) {
        job.due=Date.now()+Math.max(1,error.seconds)*1000;
        await this.db.put(key,job);
        return;
      }
      const failure={ts:Date.now(),reason:error instanceof Review ? error.message : 'Internal processing error',key};
      await this.db.put(`failed:${key}`,failure);
      if (key.startsWith('queue:')) await this.db.put(key.replace('queue:','done:'),{ts:Date.now()});
      await this.db.delete(key);
      const managerMessage=job.update?.message;
      const route=managerMessage?.chat?.id===this.managers() && managerMessage.reply_to_message
        ? await this.db.get(`route:${this.managers()}:${managerMessage.reply_to_message.message_id}`) : null;
      const sessionId=job.sessionId || route?.sessionId || (job.update?.business_message?.chat?.id ? String(job.update.business_message.chat.id) : null);
      if (sessionId) await this.pause(sessionId,'delivery_error');
      try {
        if (sessionId) await this.alert(`failure:${key}`,sessionId,`Ошибка отправки: ${failure.reason}. Проверь доставку вручную.`,job.messages || [job.update?.business_message || managerMessage].filter(Boolean));
        else await this.notifyAdmins(`failure:${key}`,'sendMessage',{text:`Нужно проверить работу бота. Задача: ${key}. Причина: ${failure.reason}. Автоповтор отправки остановлен, чтобы не дублировать заказ. /status`});
      } catch { /* Failure remains visible through /status; never log secrets. */ }
    }
  }
  async arm() {
    let due=Date.now()+DAY;
    const queued=await this.db.list({prefix:'queue:',limit:1});
    if (queued.size) due=Math.min(due,queued.values().next().value.due);
    else for (const job of (await this.db.list({prefix:'batch:',limit:1000})).values()) due=Math.min(due,job.due);
    const cleanup=await this.db.get('cleanup');
    due=Math.min(due,cleanup?.next || Date.now()+DAY);
    await this.db.setAlarm(Math.max(Date.now()+50,due));
  }
  owner() { return /^\d+$/.test(this.env.OWNER_ID || '') ? Number(this.env.OWNER_ID) : null; }
  admins() {
    // Explicit administrators are separate from the one connected business account.
    // Keep OWNER_ID as the fallback for existing single-owner deployments.
    const raw=this.env.ADMIN_IDS === undefined ? this.env.OWNER_ID || '' : this.env.ADMIN_IDS;
    return [...new Set(String(raw).split(',').map(s=>s.trim())
      .filter(s=>/^\d+$/.test(s)).map(Number)
      .filter(id=>Number.isSafeInteger(id) && id>0))];
  }
  isAdmin(id) { return this.admins().includes(id); }
  managers() { return /^-\d+$/.test(this.env.MANAGERS_CHAT_ID || '') ? Number(this.env.MANAGERS_CHAT_ID) : null; }
  async notifyAdmins(effectId,method,body) {
    let delivered=0,retry;
    for (const id of this.admins()) {
      try {
        await this.send(`${effectId}:admin:${id}`,method,{...body,chat_id:id});
        delivered++;
      } catch(error) {
        if (error instanceof Retry) { retry=error; continue; }
        // A blocked or unavailable account must not suppress other recipients.
        await this.db.put(`failed:notification:${effectId}:admin:${id}`,{
          ts:Date.now(),reason:error instanceof Review ? error.message : 'Notification failed',adminId:id
        });
      }
    }
    // Confirmed deliveries have individual checkpoints and will not be duplicated.
    if (retry) throw retry;
    if (!delivered) throw new Review('Не удалось уведомить ни одного администратора');
  }
  async send(effectId, method, body) {
    if (Date.now()>(this.deadline || Infinity)-2000) throw new Retry(1);
    const key=`effect:${effectId}`;
    const previous=await this.db.get(key);
    if (previous?.state==='done') return previous.result;
    if (previous) throw new Review(`Результат ${method} не подтверждён; нужна ручная проверка`);
    await this.db.put(key,{state:'started',ts:Date.now()});
    let response, payload;
    try {
      response=await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
      if (response.status>=500) throw new Error('ambiguous server error');
      payload=await response.json();
    } catch {
      await this.db.put(key,{state:'uncertain',ts:Date.now()});
      throw new Review(`Telegram не подтвердил ${method}; проверь отправку вручную`);
    }
    if (!payload.ok) {
      if (payload.error_code===429) {
        await this.db.delete(key);
        throw new Retry(payload.parameters?.retry_after || 30);
      }
      await this.db.put(key,{state:'failed',ts:Date.now(),code:payload.error_code});
      throw new Review(`Telegram отклонил ${method}, код ${payload.error_code || response.status}`);
    }
    await this.db.put(key,{state:'done',ts:Date.now(),result:payload.result});
    return payload.result;
  }
  async connection(id) {
    const stored=await this.db.get(`connection:${id}`);
    if (stored) return stored;
    const c=await this.send(`lookup:${id}`,'getBusinessConnection',{business_connection_id:id});
    if (c.user?.id!==this.owner()) throw new Review('Business connection belongs to another account');
    await this.db.put(`connection:${id}`,{...c,ts:Date.now()});
    return c;
  }
  async handleUpdate(u) {
    if (u.message) return this.ordinary(u.message,u.update_id);
    if (u.business_connection) {
      const c=u.business_connection;
      if (!this.owner() || c.user?.id!==this.owner()) return;
      await this.db.put(`connection:${c.id}`,{...c,ts:Date.now()});
      await this.db.put('activeConnection',{id:c.id,ts:Date.now()});
      await this.notifyAdmins(`connection:${u.update_id}`,'sendMessage',{text:c.is_enabled ? `Подключение принято. Ответы клиентам: ${c.rights?.can_reply ? 'разрешены' : 'нужно разрешение на ответы'}.` : 'Подключение к аккаунту отключено.'});
      return;
    }
    if (u.business_message) return this.business(u.business_message);
    if (u.edited_business_message) return this.edited(u.edited_business_message,u.update_id);
    if (u.deleted_business_messages) {
      const d=u.deleted_business_messages;
      const c=await this.connection(d.business_connection_id);
      if (c.user?.id!==this.owner()) return;
      const id=String(d.chat.id), batch=await this.db.get(`batch:${id}`);
      let sent=false;
      for (const mid of d.message_ids) {
        if (await this.db.get(`source:${d.business_connection_id}:${id}:${mid}`)) sent=true;
      }
      if (batch) {
        batch.messages=batch.messages.filter(m=>!d.message_ids.includes(m.message_id));
        if (batch.messages.length) await this.db.put(`batch:${id}`,batch); else await this.db.delete(`batch:${id}`);
      }
      if (sent) {
        await this.pause(id,'deleted_message');
        await this.db.delete(`batch:${id}`);
        await this.alert(`deleted:${u.update_id}`,id,'Клиент удалил сообщение. Проверь, нужно ли изменить уже отправленный заказ.',[]);
      }
    }
  }
  async business(m) {
    if (!this.owner() || !this.managers()) return;
    const c=await this.connection(m.business_connection_id);
    if (c.user?.id!==this.owner() || !c.is_enabled) return;
    const id=String(m.chat.id);
    if (m.sender_business_bot) return;
    if (m.from?.id===this.owner()) { await this.pause(id,'manual'); await this.db.delete(`batch:${id}`); return; }
    if (m.chat.type!=='private' || m.from?.is_bot) return;
    if (m.chat.id===this.owner()) return;
    let session=await this.db.get(`session:${id}`) || {id,paused:false};
    // A business connection can change when the owner reconnects their bot.
    if (session.connectionId && session.connectionId!==c.id) {
      await this.db.delete(`batch:${id}`);
      session={id,paused:true,reason:'connection_changed'};
    }
    session={...session,connectionId:c.id,lastInboundAt:m.date*1000,username:m.chat.username || m.from?.username || null,ts:Date.now()};
    await this.db.put(`session:${id}`,session);
    if (session.paused) return;
    const key=`batch:${id}`;
    let batch=await this.db.get(key) || {sessionId:id,connectionId:c.id,messages:[],firstAt:Date.now(),attempts:0,ts:Date.now()};
    if (!batch.messages.some(x=>x.message_id===m.message_id)) batch.messages.push(m);
    batch.messages.sort((a,b)=>a.message_id-b.message_id);
    const quiet=Math.max(1,Number(this.env.DEBOUNCE_SECONDS)||30)*1000;
    const max=Math.max(quiet,(Number(this.env.MAX_BATCH_SECONDS)||120)*1000);
    batch.due=Math.min(Date.now()+quiet,batch.firstAt+max);
    await this.db.put(key,batch);
  }
  async pause(id,reason) {
    const key=`session:${id}`,session=await this.db.get(key) || {id};
    await this.db.put(key,{...session,paused:true,reason,ts:Date.now()});
  }
  async businessText(effect,id,text) {
    const s=await this.db.get(`session:${id}`);
    if (!s?.connectionId || Date.now()-s.lastInboundAt>=DAY) return {skipped:'24h'};
    const c=await this.connection(s.connectionId);
    if (!c.is_enabled || !c.rights?.can_reply) return {skipped:'permissions'};
    return this.send(effect,'sendMessage',{chat_id:Number(id),business_connection_id:s.connectionId,text});
  }
  async alert(effect,id,reason,messages) {
    const s=await this.db.get(`session:${id}`);
    const link=s?.username ? `https://t.me/${s.username}` : `tg://user?id=${id}`;
    const body=`Нужно подключиться. ${reason}\nКлиент: ${link}\nID: ${id}\n\n${plainPreview(messages)}\n\nАвтоответы приостановлены. Вернуть: /resume ${id}`;
    await this.notifyAdmins(effect,'sendMessage',{text:body,link_preview_options:{is_disabled:true}});
  }
  async flush(batch) {
    const id=batch.sessionId,s=await this.db.get(`session:${id}`);
    if (!s || s.paused || s.connectionId!==batch.connectionId) return;
    const c=await this.connection(s.connectionId);
    if (!c.is_enabled || !c.rights?.can_reply) {
      await this.pause(id,'permissions');
      await this.alert(`rights:${id}:${batch.firstAt}`,id,'Telegram не разрешает автоматический ответ.',batch.messages);
      return;
    }
    const first=batch.messages[0];
    if (!first) return;
    const orderId=`${batch.connectionId}:${id}:${first.message_id}`;
    let kind=classify(batch.messages,this.env.PRODUCT_WORDS);
    // Preflight every attachment before any order content is sent to managers.
    if (kind==='order') {
      try { for (const m of batch.messages) contentRequest(m,this.managers(),this.env.MANAGERS_THREAD_ID); }
      catch { kind='review'; }
    }
    if (kind==='ignore') return;
    if (kind==='review') {
      // Persist the decision without setting paused until side effects finish;
      // a rate-limit retry must resume this same job, not drop the alert.
      const wait=await this.businessText(`wait:${orderId}`,id,this.env.WAIT_TEXT || 'Пожалуйста, дайте немного времени на уточнение. Скоро вернусь с ответом.');
      await this.alert(`review:${orderId}`,id,`Нестандартное сообщение или вопрос.${wait?.skipped ? ' Автоответ не отправлен: ограничение Telegram.' : ''}`,batch.messages);
      for (const m of batch.messages) {
        if (m.text || m.has_protected_content) continue;
        try {
          const [method,body]=contentRequest(m,this.admins()[0]);
          await this.notifyAdmins(`review-media:${orderId}:${m.message_id}`,method,body);
        } catch(e) { if (e instanceof Retry) throw e; /* Text alert already delivered. */ }
      }
      await this.pause(id,'question');
      return;
    }
    for (const m of batch.messages) {
      const [method,body]=contentRequest(m,this.managers(),this.env.MANAGERS_THREAD_ID);
      const sent=await this.send(`copy:${orderId}:${m.message_id}`,method,body);
      await this.db.put(`route:${this.managers()}:${sent.message_id}`,{sessionId:id,connectionId:batch.connectionId,sourceMessageId:m.message_id,orderId,ts:Date.now()});
      await this.db.put(`source:${batch.connectionId}:${id}:${m.message_id}`,{orderId,ts:Date.now()});
    }
    // Acknowledgement is sent only after every manager message is confirmed.
    const ack=await this.businessText(`accept:${orderId}`,id,this.env.ACCEPT_TEXT || 'Здравствуйте, принял.');
    if (ack?.skipped) await this.alert(`ack-skipped:${orderId}`,id,'Заказ передан менеджерам, но Telegram не разрешил подтверждение клиенту.',batch.messages);
  }
  async ordinary(m,uid) {
    const text=(m.text || '').trim(), command=text.split(/\s/)[0].split('@')[0];
    if (['/start','/help','/id'].includes(command)) {
      const response=command==='/id' ? `Ваш ID: ${m.from?.id || 'нет'}\nID чата: ${m.chat.id}${m.message_thread_id ? `\nID темы: ${m.message_thread_id}` : ''}` : HELP;
      await this.send(`public:${uid}`,'sendMessage',{chat_id:m.chat.id,text:response,...(m.message_thread_id ? {message_thread_id:m.message_thread_id} : {})});
      return;
    }
    if (this.isAdmin(m.from?.id) && m.chat.type==='private' && m.chat.id===m.from.id) {
      if (command==='/status') {
        const sessions=await this.db.list({prefix:'session:',limit:1000}),failed=await this.db.list({prefix:'failed:',limit:1000});
        const paused=[...sessions.values()].filter(s=>s.paused).map(s=>`${s.id}: ${s.reason}`).slice(0,30);
        const c=await this.db.get('activeConnection');
        await this.send(`status:${uid}`,'sendMessage',{chat_id:m.chat.id,text:`Аккаунт для клиентских переписок: ${this.owner() || 'не настроен'}\nАдминистраторы: ${this.admins().join(', ') || 'не настроены'}\nГруппа: ${this.managers() || 'не настроена'}\nПодключение: ${c ? 'получено' : 'не получено'}\nСбоев за период хранения: ${failed.size}\nПаузы:\n${paused.join('\n') || 'нет'}`});
      } else if (['/pause','/resume'].includes(command)) {
        const id=text.split(/\s+/)[1];
        const s=/^\d+$/.test(id || '') ? await this.db.get(`session:${id}`) : null;
        if (!s) { await this.send(`control:${uid}`,'sendMessage',{chat_id:m.chat.id,text:'Укажи ID клиента из уведомления: /resume 123456789'}); return; }
        await this.db.delete(`batch:${id}`);
        await this.db.put(`session:${id}`,{...s,paused:command==='/pause',reason:command==='/pause' ? 'manual' : null,ts:Date.now()});
        await this.send(`control:${uid}`,'sendMessage',{chat_id:m.chat.id,text:command==='/pause' ? `Диалог ${id}: пауза.` : `Диалог ${id}: автоматизация включена для новых сообщений. Старые сообщения повторно не отправляются.`});
      }
      return;
    }
    if (m.chat.id!==this.managers() || m.from?.is_bot || !m.reply_to_message) return;
    // With privacy mode on, replies to this bot's own messages still arrive.
    const route=await this.db.get(`route:${this.managers()}:${m.reply_to_message.message_id}`);
    if (!route || benignManagerReply(m.text || m.caption)) return;
    const s=await this.db.get(`session:${route.sessionId}`);
    if (s?.connectionId!==route.connectionId) return;
    const manual=s?.paused && s.reason==='manual';
    if (!manual) {
      const result=await this.businessText(`manager-client:${uid}`,route.sessionId,this.env.WAIT_TEXT || 'Пожалуйста, дайте немного времени на уточнение. Скоро вернусь с ответом.');
      if (result?.skipped) route.waitSkipped=true;
    }
    await this.send(`manager-wait:${uid}`,'sendMessage',{chat_id:this.managers(),text:this.env.MANAGER_WAIT_TEXT || 'Принял, уточню и вернусь с ответом.',reply_parameters:{message_id:m.message_id,allow_sending_without_reply:true},...(m.message_thread_id ? {message_thread_id:m.message_thread_id} : {})});
    await this.alert(`manager-alert:${uid}`,route.sessionId,`Менеджер ответил на заказ.${route.waitSkipped ? ' Клиенту не удалось отправить автоответ из-за ограничения Telegram.' : ''}`,[m]);
    if (!manual) await this.pause(route.sessionId,'manager_question');
  }
  async edited(m,uid) {
    if (!this.owner() || m.sender_business_bot || m.from?.id===this.owner()) return;
    const c=await this.connection(m.business_connection_id);
    if (c.user?.id!==this.owner()) return;
    const id=String(m.chat.id),batch=await this.db.get(`batch:${id}`);
    if (batch?.messages.some(x=>x.message_id===m.message_id)) {
      // An edit to a partly delivered batch is escalated instead of silently
      // changing the content behind a completed delivery checkpoint.
      const source=await this.db.get(`source:${m.business_connection_id}:${id}:${m.message_id}`);
      if (!source) {
        batch.messages=batch.messages.map(x=>x.message_id===m.message_id ? m : x);
        await this.db.put(`batch:${id}`,batch);
        return;
      }
    }
    await this.pause(id,'edited_order');
    await this.db.delete(`batch:${id}`);
    await this.alert(`edited:${uid}`,id,'Клиент изменил сообщение. Проверь заказ и при необходимости сообщи менеджерам.',[m]);
  }
  async cleanup() {
    const meta=await this.db.get('cleanup');
    if (meta?.next>Date.now()) return;
    const cutoff=Date.now()-Math.max(1,Number(this.env.RETENTION_DAYS)||30)*DAY;
    let more=false;
    const cursors={...(meta?.cursors || {})};
    for (const prefix of ['done:','effect:','failed:','route:','source:','session:']) {
      const cursor=cursors[prefix];
      if (cursor==='complete') continue;
      const rows=await this.db.list({prefix,limit:100,startAfter:cursor || prefix});
      let last=cursor;
      for (const [key,value] of rows) {
        last=key;
        // A manual pause never silently expires. Retain only control metadata
        // for old paused sessions and remove cached profile information.
        if (value.ts<cutoff) {
          if (prefix==='session:' && value.paused) {
            const {username,...control}=value;
            await this.db.put(key,control);
          } else await this.db.delete(key);
        }
      }
      cursors[prefix]=rows.size===100 ? last : 'complete';
      if (rows.size===100) more=true;
    }
    await this.db.put('cleanup',{next:Date.now()+(more ? 60000 : DAY),cursors:more ? cursors : {},ts:Date.now()});
  }
}
