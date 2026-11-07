// Run locally. The token is read from the environment, never from CLI arguments.
import { existsSync } from 'node:fs';
if (existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');
const action=process.argv[2];
const token=process.env.BOT_TOKEN;
if (!token || token.startsWith('REPLACE')) throw new Error('Set BOT_TOKEN in .dev.vars or your environment.');
async function api(method,body={}) {
  let result;
  try {
    const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    result=await r.json();
  } catch { throw new Error('Telegram request failed. Check your network; secrets were not printed.'); }
  if (!result.ok) throw new Error(`Telegram rejected ${method}: code ${result.error_code}`);
  return result.result;
}
if (action==='check') {
  const bot=await api('getMe'),webhook=await api('getWebhookInfo');
  console.log(JSON.stringify({username:bot.username,business_mode:bot.can_connect_to_business,webhook_url:webhook.url,pending_updates:webhook.pending_update_count,last_error:webhook.last_error_message},null,2));
} else if (action==='webhook') {
  const url=process.env.WEBHOOK_URL,secret=process.env.WEBHOOK_SECRET;
  if (!url || !/^https:\/\//.test(url) || new URL(url).pathname!=='/telegram') throw new Error('Set HTTPS WEBHOOK_URL ending in /telegram.');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret || '') || secret.startsWith('REPLACE')) throw new Error('Set a random WEBHOOK_SECRET (32–256 allowed characters).');
  await api('setWebhook',{url,secret_token:secret,max_connections:1,drop_pending_updates:false,allowed_updates:['message','business_connection','business_message','edited_business_message','deleted_business_messages']});
  console.log('Webhook registered. Use npm run telegram:check to inspect status.');
} else throw new Error('Use: npm run telegram:check or npm run telegram:webhook');
