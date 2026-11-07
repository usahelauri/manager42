import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {OrderManager,ensureWebhook} from '../src/worker.mjs';
import {classify} from '../src/rules.mjs';
import {contentRequest} from '../src/media.mjs';

class MemoryStorage {
  map=new Map(); alarmAt=null;
  async get(key) { return structuredClone(this.map.get(key)); }
  async put(key,value) { this.map.set(key,structuredClone(value)); }
  async delete(key) { return this.map.delete(key); }
  async list({prefix='',limit=1000,startAfter=''}={}) {
    return new Map([...this.map].filter(([k])=>k.startsWith(prefix) && k>startAfter).sort(([a],[b])=>a.localeCompare(b,'en')).slice(0,limit).map(([k,v])=>[k,structuredClone(v)]));
  }
  async setAlarm(at) { this.alarmAt=at; }
}
function fixture(t,overrides={}) {
  const storage=new MemoryStorage();
  const env={BOT_TOKEN:'TEST_TOKEN',WEBHOOK_SECRET:'a'.repeat(64),OWNER_ID:'100',MANAGERS_CHAT_ID:'-100500',DEBOUNCE_SECONDS:'30',...overrides};
  const bot=new OrderManager({storage},env),calls=[];
  let seq=1000, responseHook;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const method=String(url).split('/').at(-1),body=JSON.parse(options.body);
    calls.push({method,body});
    if (responseHook) { const response=await responseHook(method,body); if (response) return response; }
    return Response.json({ok:true,result:{message_id:seq++,chat:{id:body.chat_id},...(body.text ? {text:body.text} : {})}});
  });
  const connection={id:'business-1',user:{id:100},user_chat_id:100,rights:{can_reply:true},is_enabled:true,ts:Date.now()};
  storage.map.set('connection:business-1',connection);
  async function enqueue(update) { await bot.fetch(new Request('https://internal/enqueue',{method:'POST',body:JSON.stringify(update)})); await bot.alarm(); }
  async function flush() {
    for (const [key,value] of storage.map) if (key.startsWith('batch:') || key.startsWith('queue:')) await storage.put(key,{...value,due:Date.now()-1});
    await bot.alarm();
  }
  const incoming=(messageId,text='Пюре манго — 2 кг',chatId=200,extra={})=>({message_id:messageId,date:Math.floor(Date.now()/1000),business_connection_id:'business-1',chat:{id:chatId,type:'private',username:'client'},from:{id:chatId,is_bot:false},text,...extra});
  return {storage,env,bot,calls,enqueue,flush,incoming,setResponseHook(hook){responseHook=hook;}};
}

test('rules require product and quantity; questions, refunds, voice and unknown text need review',()=>{
  for (const text of ['Пюре манго — 2 кг','Сироп ваниль 3 шт','Манго — 4']) assert.equal(classify([{text}]),'order',text);
  for (const text of ['Пюре манго 2 кг, когда привезёте?','Пюре 2 кг, отмените','Нужен прайс','Заказ №123','Телефон 79991234567']) assert.equal(classify([{text}]),'review',text);
  assert.equal(classify([{text:'Спасибо!'}]),'ignore');
  assert.equal(classify([{voice:{file_id:'voice'}}]),'review');
  assert.equal(classify([{text:'Пюре 2 кг',has_protected_content:true}]),'review');
});

test('media copy preserves text, entities and file IDs without sender metadata',()=>{
  const original={text:'Манго 2 кг',entities:[{type:'bold',offset:0,length:5}],from:{username:'private_user'},chat:{id:200}};
  const [method,body]=contentRequest(original,-100500);
  assert.equal(method,'sendMessage');
  assert.deepEqual(body,{chat_id:-100500,text:original.text,entities:original.entities});
  const [photo,payload]=contentRequest({photo:[{file_id:'small'},{file_id:'large'}],caption:'Пюре 2 кг'},-100500,8);
  assert.equal(photo,'sendPhoto'); assert.equal(payload.photo,'large'); assert.equal(payload.message_thread_id,8);
});

test('webhook rejects forged requests and accepts a valid secret only after durable enqueue',async(t)=>{
  const f=fixture(t); let queued=0;
  f.env.MANAGER={idFromName:()=>1,get:()=>({fetch:async()=>{queued++;return Response.json({ok:true});}})};
  const request=(secret,body='{"update_id":1}')=>new Request('https://worker/telegram',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body});
  assert.equal((await worker.fetch(request('wrong'),f.env)).status,403);
  assert.equal((await worker.fetch(request(f.env.WEBHOOK_SECRET,'{}'),f.env)).status,400);
  assert.equal((await worker.fetch(request(f.env.WEBHOOK_SECRET),f.env)).status,200);
  assert.equal(queued,1);
});

test('scheduled setup registers the private webhook once when secrets and URL are ready',async(t)=>{
  const env={BOT_TOKEN:'TEST_TOKEN',WEBHOOK_SECRET:'z'.repeat(64),WEBHOOK_URL:'https://example.workers.dev/telegram'};
  let current={url:'',allowed_updates:[]};
  const requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const method=String(url).split('/').at(-1), body=JSON.parse(options.body);
    requests.push({method,body});
    if (method==='setWebhook') current={url:body.url,allowed_updates:body.allowed_updates};
    return Response.json({ok:true,result:method==='getWebhookInfo' ? current : true});
  });
  assert.equal(await ensureWebhook({...env,WEBHOOK_SECRET:undefined}),false);
  assert.equal(requests.length,0);
  assert.equal(await ensureWebhook(env),true);
  assert.deepEqual(requests.map(r=>r.method),['getWebhookInfo','setWebhook']);
  assert.equal(requests[1].body.url,env.WEBHOOK_URL);
  assert.equal(requests[1].body.secret_token,env.WEBHOOK_SECRET);
  assert.equal(requests[1].body.drop_pending_updates,false);
  await ensureWebhook(env);
  assert.deepEqual(requests.map(r=>r.method),['getWebhookInfo','setWebhook','getWebhookInfo']);
  await assert.rejects(ensureWebhook({...env,WEBHOOK_URL:'https://example.workers.dev/telegram?token=bad'}),/Invalid webhook URL/);
});

test('operator webhook check requires the secret and reports setup without exposing credentials',async(t)=>{
  const env={BOT_TOKEN:'TEST_TOKEN',WEBHOOK_SECRET:'z'.repeat(64),WEBHOOK_URL:'https://example.workers.dev/telegram'};
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const method=String(url).split('/').at(-1);
    calls.push(method);
    return Response.json({ok:true,result:method==='getMe' ? {username:'order_bot',can_connect_to_business:true}
      : method==='getWebhookInfo' ? {url:env.WEBHOOK_URL,allowed_updates:['message','business_connection','business_message','edited_business_message','deleted_business_messages'],pending_update_count:0}
      : true});
  });
  const request=(secret)=>new Request('https://example.workers.dev/ops/webhook',{method:'POST',headers:{'X-Setup-Secret':secret}});
  assert.equal((await worker.fetch(request('wrong'),env)).status,403);
  assert.deepEqual(calls,[]);
  const result=await worker.fetch(request(env.WEBHOOK_SECRET),env);
  assert.equal(result.status,200);
  const status=await result.json();
  assert.deepEqual(status,{ok:true,username:'order_bot',business_mode:true,webhook_url:env.WEBHOOK_URL,pending_updates:0,last_error:null});
  assert.ok(!JSON.stringify(status).includes(env.BOT_TOKEN));
  assert.ok(!JSON.stringify(status).includes(env.WEBHOOK_SECRET));
});

test('multi-message order is debounced, copied without metadata, then acknowledged once',async(t)=>{
  const f=fixture(t);
  await f.enqueue({update_id:1,business_message:f.incoming(10)});
  await f.enqueue({update_id:2,business_message:f.incoming(11,'Сироп ваниль 3 шт')});
  assert.equal(f.calls.length,0);
  await f.flush();
  const group=f.calls.filter(c=>c.body.chat_id===-100500),client=f.calls.filter(c=>c.body.chat_id===200);
  assert.equal(group.length,2); assert.equal(client.length,1);
  assert.equal(group[0].body.text,'Пюре манго — 2 кг');
  assert.equal(group[0].body.business_connection_id,undefined);
  assert.equal(client[0].body.business_connection_id,'business-1');
  assert.equal(f.calls.at(-1).body.text,'Здравствуйте, принял.');
  await f.enqueue({update_id:1,business_message:f.incoming(10)}); await f.flush();
  assert.equal(f.calls.length,3);
});

test('photos accompanying an order reuse file ID and do not append sender details',async(t)=>{
  const f=fixture(t);
  await f.enqueue({update_id:1,business_message:f.incoming(10,undefined,200,{text:undefined,caption:'Пюре манго 2 кг',photo:[{file_id:'photo-id'}]})});
  await f.flush();
  assert.equal(f.calls[0].method,'sendPhoto');
  assert.deepEqual(f.calls[0].body,{chat_id:-100500,caption:'Пюре манго 2 кг',photo:'photo-id'});
});

test('same order from two customers stays linked to the correct customer on manager reply',async(t)=>{
  const f=fixture(t);
  await f.enqueue({update_id:1,business_message:f.incoming(10,'Манго 2 кг',200)});
  await f.enqueue({update_id:2,business_message:f.incoming(10,'Манго 2 кг',201)});
  await f.flush();
  const route=[...f.storage.map].find(([k,v])=>k.startsWith('route:') && v.sessionId==='201');
  const destId=Number(route[0].split(':').at(-1));
  f.calls.length=0;
  await f.enqueue({update_id:3,message:{message_id:555,date:Date.now()/1000,chat:{id:-100500,type:'supergroup'},from:{id:300},text:'Нет в наличии',reply_to_message:{message_id:destId}}});
  assert.deepEqual(f.calls.map(c=>c.body.chat_id),[201,-100500,100]);
  assert.equal((await f.storage.get('session:201')).paused,true);
  assert.equal((await f.storage.get('session:200')).paused,false);
  assert.ok(!f.calls[1].body.text.includes('client'));
});

test('question sends waiting message and owner alert, pauses the session, and never copies to managers',async(t)=>{
  const f=fixture(t);
  await f.enqueue({update_id:1,business_message:f.incoming(10,'Когда доставка?')}); await f.flush();
  assert.deepEqual(f.calls.map(c=>c.body.chat_id),[200,100]);
  assert.equal((await f.storage.get('session:200')).paused,true);
  await f.enqueue({update_id:2,business_message:f.incoming(11)}); await f.flush();
  assert.equal(f.calls.length,2);
});

test('manual owner reply cancels pending order and pauses future automation',async(t)=>{
  const f=fixture(t);
  await f.enqueue({update_id:1,business_message:f.incoming(10)});
  await f.enqueue({update_id:2,business_message:f.incoming(11,'Я уточню',200,{from:{id:100}})});
  await f.flush();
  assert.equal(f.calls.length,0); assert.equal((await f.storage.get('session:200')).reason,'manual');
});

test('bot-generated outgoing messages do not trigger a manual pause',async(t)=>{
  const f=fixture(t);
  await f.enqueue({update_id:1,business_message:f.incoming(10)});
  await f.enqueue({update_id:2,business_message:f.incoming(11,'Автоответ',200,{from:{id:100},sender_business_bot:{id:999}})});
  await f.flush();
  assert.equal(f.calls.length,2); assert.equal((await f.storage.get('session:200')).paused,false);
});

test('only configured owner can resume, and old messages are not re-sent',async(t)=>{
  const f=fixture(t);
  await f.enqueue({update_id:1,business_message:f.incoming(10,'Когда?')}); await f.flush();
  const command=(id)=>({message_id:id,chat:{id,type:'private'},from:{id},text:'/resume 200'});
  await f.enqueue({update_id:2,message:command(999)});
  assert.equal((await f.storage.get('session:200')).paused,true);
  await f.enqueue({update_id:3,message:command(100)});
  assert.equal((await f.storage.get('session:200')).paused,false);
  assert.equal((await f.storage.list({prefix:'batch:'})).size,0);
});

test('edit before delivery updates pending content; edit after delivery escalates',async(t)=>{
  const f=fixture(t);
  await f.enqueue({update_id:1,business_message:f.incoming(10,'Манго 2 кг')});
  await f.enqueue({update_id:2,edited_business_message:f.incoming(10,'Манго 3 кг')}); await f.flush();
  assert.equal(f.calls[0].body.text,'Манго 3 кг');
  await f.enqueue({update_id:3,edited_business_message:f.incoming(10,'Манго 4 кг')});
  assert.equal(f.calls.at(-1).body.chat_id,100); assert.equal((await f.storage.get('session:200')).paused,true);
});

test('deleting pending content cancels it, while deleting delivered content alerts owner',async(t)=>{
  const f=fixture(t),deleted=(id)=>({business_connection_id:'business-1',chat:{id:200},message_ids:[id]});
  await f.enqueue({update_id:1,business_message:f.incoming(10)});
  await f.enqueue({update_id:2,deleted_business_messages:deleted(10)}); await f.flush();
  assert.equal(f.calls.length,0);
  await f.enqueue({update_id:3,business_message:f.incoming(11)}); await f.flush();
  await f.enqueue({update_id:4,deleted_business_messages:deleted(11)});
  assert.equal(f.calls.at(-1).body.chat_id,100); assert.equal((await f.storage.get('session:200')).reason,'deleted_message');
});

test('rate-limit recovery does not resend a confirmed earlier part of the order',async(t)=>{
  const f=fixture(t); let refused=false;
  f.setResponseHook((method,body)=>{
    if (!refused && body.text==='Сироп 3 шт') { refused=true; return Response.json({ok:false,error_code:429,parameters:{retry_after:5}},{status:429}); }
  });
  await f.enqueue({update_id:1,business_message:f.incoming(10)});
  await f.enqueue({update_id:2,business_message:f.incoming(11,'Сироп 3 шт')}); await f.flush();
  assert.equal(f.calls.filter(c=>c.body.chat_id===200).length,0);
  await f.flush();
  assert.equal(f.calls.filter(c=>c.body.text==='Пюре манго — 2 кг').length,1);
  assert.equal(f.calls.filter(c=>c.body.chat_id===200).length,1);
});

test('ambiguous transport failure never automatically resends an order or acknowledges receipt',async(t)=>{
  const f=fixture(t); let failed=false;
  f.setResponseHook((method,body)=>{if (!failed && body.chat_id===-100500) {failed=true;throw new Error('network interrupted');}});
  await f.enqueue({update_id:1,business_message:f.incoming(10)}); await f.flush(); await f.flush();
  assert.equal(f.calls.filter(c=>c.body.chat_id===-100500).length,1);
  assert.equal(f.calls.filter(c=>c.body.chat_id===200).length,0);
  assert.equal(f.calls.at(-1).body.chat_id,100);
  assert.equal((await f.storage.get('session:200')).paused,true);
});

test('missing reply rights does not claim an order was accepted',async(t)=>{
  const f=fixture(t),c=await f.storage.get('connection:business-1');
  await f.storage.put('connection:business-1',{...c,rights:{}});
  await f.enqueue({update_id:1,business_message:f.incoming(10)}); await f.flush();
  assert.deepEqual(f.calls.map(c=>c.body.chat_id),[100]);
});

test('expired Telegram 24-hour reply window reports that acknowledgement was not sent',async(t)=>{
  const f=fixture(t);
  await f.enqueue({update_id:1,business_message:f.incoming(10,undefined,200,{date:Math.floor(Date.now()/1000)-90000})}); await f.flush();
  assert.deepEqual(f.calls.map(c=>c.body.chat_id),[-100500,100]);
  assert.ok(f.calls.at(-1).body.text.includes('не разрешил подтверждение'));
});

test('configured owner mismatch ignores an unrelated business connection',async(t)=>{
  const f=fixture(t);
  await f.enqueue({update_id:1,business_connection:{id:'alien',user:{id:999},is_enabled:true,rights:{can_reply:true}}});
  assert.equal(await f.storage.get('connection:alien'),undefined); assert.equal(f.calls.length,0);
});

test('storage survives creating a new Durable Object instance between receipt and delivery',async(t)=>{
  const f=fixture(t);
  await f.enqueue({update_id:1,business_message:f.incoming(10)});
  const restarted=new OrderManager({storage:f.storage},f.env);
  const batch=await f.storage.get('batch:200'); await f.storage.put('batch:200',{...batch,due:Date.now()-1});
  await restarted.alarm();
  assert.deepEqual(f.calls.map(c=>c.body.chat_id),[-100500,200]);
});

test('a rate-limited first queued update schedules its retry without a hot alarm loop',async(t)=>{
  const f=fixture(t); let once=false;
  f.setResponseHook(()=>{if (!once) {once=true;return Response.json({ok:false,error_code:429,parameters:{retry_after:60}},{status:429});}});
  await f.bot.fetch(new Request('https://internal/enqueue',{method:'POST',body:JSON.stringify({update_id:1,message:{chat:{id:100,type:'private'},from:{id:100},text:'/id'}})}));
  await f.bot.fetch(new Request('https://internal/enqueue',{method:'POST',body:JSON.stringify({update_id:2,business_message:f.incoming(10)})}));
  await f.bot.alarm();
  assert.ok(f.storage.alarmAt>Date.now()+50000);
});

const adminIds=[10000000001,10000000002];
const privateCommand=(id,text)=>({message_id:1,chat:{id,type:'private'},from:{id},text});

test('both configured admin accounts receive escalation text and attachments',async(t)=>{
  const f=fixture(t,{ADMIN_IDS:adminIds.join(',')});
  await f.enqueue({update_id:1,business_message:f.incoming(10,undefined,200,{text:undefined,caption:'Когда доставка?',photo:[{file_id:'question-photo'}]})});
  await f.flush();
  for (const id of adminIds) {
    const alerts=f.calls.filter(c=>c.body.chat_id===id);
    assert.equal(alerts.length,2);
    assert.equal(alerts[0].method,'sendMessage');
    assert.ok(alerts[0].body.text.includes('Нужно подключиться'));
    assert.equal(alerts[1].method,'sendPhoto');
    assert.equal(alerts[1].body.photo,'question-photo');
  }
  assert.equal(f.calls.filter(c=>c.body.chat_id===100).length,0);
  assert.equal(f.calls.filter(c=>c.body.chat_id===-100500).length,0);
  assert.equal((await f.storage.get('session:200')).paused,true);
});

test('each administrator can pause, resume and inspect status from their own private chat',async(t)=>{
  const f=fixture(t,{ADMIN_IDS:adminIds.join(',')});
  await f.enqueue({update_id:1,business_message:f.incoming(10)});
  let uid=2;
  for (const id of adminIds) {
    await f.enqueue({update_id:uid++,message:privateCommand(id,'/pause 200')});
    assert.equal((await f.storage.get('session:200')).paused,true);
    assert.equal(f.calls.at(-1).body.chat_id,id);
    await f.enqueue({update_id:uid++,message:privateCommand(id,'/resume 200')});
    assert.equal((await f.storage.get('session:200')).paused,false);
    assert.equal(f.calls.at(-1).body.chat_id,id);
    await f.enqueue({update_id:uid++,message:privateCommand(id,'/status')});
    assert.equal(f.calls.at(-1).body.chat_id,id);
    for (const other of adminIds) assert.ok(f.calls.at(-1).body.text.includes(String(other)));
  }
  assert.equal((await f.storage.list({prefix:'batch:'})).size,0);
});

test('administration works before choosing the connected client account',async(t)=>{
  const f=fixture(t,{OWNER_ID:'',ADMIN_IDS:adminIds.join(',')});
  for (let i=0;i<adminIds.length;i++) {
    await f.enqueue({update_id:i+1,message:privateCommand(adminIds[i],'/status')});
    assert.equal(f.calls.at(-1).body.chat_id,adminIds[i]);
    assert.ok(f.calls.at(-1).body.text.includes('Аккаунт для клиентских переписок: не настроен'));
  }
  await f.enqueue({update_id:3,business_message:f.incoming(10)}); await f.flush();
  assert.equal(f.calls.length,2);
});

test('unlisted users, removed owner, group commands and mismatched private sender cannot control or read status',async(t)=>{
  const f=fixture(t,{ADMIN_IDS:adminIds.join(',')});
  await f.enqueue({update_id:1,business_message:f.incoming(10)});
  await f.bot.pause('200','manual');
  const messages=[
    privateCommand(999,'/resume 200'),
    privateCommand(100,'/resume 200'),
    {...privateCommand(adminIds[0],'/resume 200'),chat:{id:-100500,type:'supergroup'}},
    {...privateCommand(adminIds[0],'/resume 200'),chat:{id:adminIds[1],type:'private'}},
    privateCommand(999,'/status')
  ];
  for (let i=0;i<messages.length;i++) await f.enqueue({update_id:i+2,message:messages[i]});
  assert.equal((await f.storage.get('session:200')).paused,true);
  assert.equal(f.calls.length,0);
});

test('blocked first admin does not prevent delivery to second admin or pausing the client',async(t)=>{
  const f=fixture(t,{ADMIN_IDS:adminIds.join(',')});
  f.setResponseHook((method,body)=>body.chat_id===adminIds[0]
    ? Response.json({ok:false,error_code:403},{status:403}) : null);
  await f.enqueue({update_id:1,business_message:f.incoming(10,'Когда доставка?')}); await f.flush();
  assert.equal(f.calls.filter(c=>c.body.chat_id===adminIds[1]).length,1);
  assert.ok(f.calls.find(c=>c.body.chat_id===adminIds[1]).body.text.includes('Нужно подключиться'));
  assert.equal((await f.storage.get('session:200')).paused,true);
  assert.equal((await f.storage.list({prefix:'failed:notification:'})).size,1);
});

test('rate-limited admin is retried without duplicating delivery to the other admin or the client',async(t)=>{
  const f=fixture(t,{ADMIN_IDS:adminIds.join(',')});
  let limited=false;
  f.setResponseHook((method,body)=>{
    if (!limited && body.chat_id===adminIds[0]) {
      limited=true;
      return Response.json({ok:false,error_code:429,parameters:{retry_after:5}},{status:429});
    }
  });
  await f.enqueue({update_id:1,business_message:f.incoming(10,'Когда доставка?')}); await f.flush();
  assert.equal(f.calls.filter(c=>c.body.chat_id===adminIds[1]).length,1);
  await f.flush();
  assert.equal(f.calls.filter(c=>c.body.chat_id===adminIds[0]).length,2);
  assert.equal(f.calls.filter(c=>c.body.chat_id===adminIds[1]).length,1);
  assert.equal(f.calls.filter(c=>c.body.chat_id===200).length,1);
  assert.equal((await f.storage.get('session:200')).paused,true);
});

test('admin privileges do not authorize a different account business connection',async(t)=>{
  const f=fixture(t,{ADMIN_IDS:adminIds.join(',')});
  await f.enqueue({update_id:1,business_connection:{id:'secondary',user:{id:adminIds[1]},is_enabled:true,rights:{can_reply:true}}});
  assert.equal(await f.storage.get('connection:secondary'),undefined);
  assert.equal(f.calls.length,0);
  await f.enqueue({update_id:2,business_connection:{id:'primary',user:{id:100},is_enabled:true,rights:{can_reply:true}}});
  assert.deepEqual(f.calls.map(c=>c.body.chat_id),adminIds);
});
