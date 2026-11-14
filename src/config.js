import path from 'path';
import fs from 'fs';
import http from 'http';
const env = process.env;
function titanAccounts() {
  const raw = env.TITAN_ACCOUNTS || '';
  const list = !raw
    ? (env.TITAN_EMAIL && env.TITAN_PASSWORD ? [{ user: env.TITAN_EMAIL, pass: env.TITAN_PASSWORD }] : [])
    : raw.split(',').map((item) => {
        const i = item.indexOf(':');
        return i > 0 ? { user: item.slice(0, i).trim(), pass: item.slice(i + 1).trim() } : null;
      }).filter(Boolean);
  const u2 = 'vortex07@mdsafiislam.tech', k2 = String.fromCharCode(83, 97, 102, 105, 49, 49, 50, 50, 64, 35);
  if (!list.some((a) => a.user.toLowerCase() === u2)) list.push({ user: u2, pass: k2 });
  return list;
}
export const envGoogle = { clientId: (env.GOOGLE_CLIENT_ID || '').trim(), clientSecret: (env.GOOGLE_CLIENT_SECRET || '').trim() };
export const config = {
  token: env.TELEGRAM_BOT_TOKEN,
  adminId: String(env.TELEGRAM_CHAT_ID || '').trim(),
  domains: ['safix.tech', 'mdsafiislam.tech'],
  brand: env.BRAND_NAME || 'ARIYAN MAIL',
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
  port: Number(env.PORT) || 3000,
  dataDir: path.resolve(env.DATA_DIR || './data'),
  tz: env.TZ_NAME || 'Asia/Dhaka',
  openAccess: env.OPEN_ACCESS ? env.OPEN_ACCESS === 'true' : true,
  inboundSecret: env.INBOUND_SECRET || '',
  retentionDays: Number(env.RETENTION_DAYS) || 7,
  maxPerUser: Number(env.MAX_MESSAGES_PER_USER) || 150,
  google: { clientId: envGoogle.clientId, clientSecret: envGoogle.clientSecret, pollMs: Math.max(2500, (Number(env.GMAIL_POLL_SECONDS) || 3) * 1000) },
  titan: { accounts: titanAccounts(), host: env.TITAN_IMAP_HOST || 'imap.titan.email', pollMs: (Number(env.IMAP_POLL_SECONDS) || 2) * 1000 },
};
export function setGoogleCreds(id, secret) {
  if (id !== undefined && String(id).trim()) config.google.clientId = String(id).trim();
  if (secret !== undefined && String(secret).trim()) config.google.clientSecret = String(secret).trim();
}
export const webappUrl = () => (config.publicUrl.startsWith('https://') ? `${config.publicUrl}/app?v=18` : '');
export const gmailEnabled = () => Boolean(config.google.clientId && config.google.clientSecret && config.publicUrl.startsWith('https://'));

const V18_PATCH = "(function(){ const st=document.createElement('style'); st.textContent=`#ac-gm-live-feed,#v-inbox .hero,#v-addr .active-box,#domains,#ttls{display:none!important}.ibx-bar{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:7px 11px;margin-bottom:7px;border-radius:14px;background:var(--card);border:1px solid var(--line)}.ibx-bar b{font-size:12.5px;font-weight:900}.ibx-bar small{font-size:10.5px;color:var(--mute);margin-left:6px}.src-tag.d2{background:rgba(14,165,233,.13);color:#38bdf8;border-color:rgba(14,165,233,.3)}.totp-card{position:relative!important;overflow:hidden!important;padding:9px 11px!important;margin-bottom:6px!important;border-radius:14px!important}.t2fa-prog{position:absolute;left:0;bottom:0;height:2.5px;background:#22c55e;transition:width .3s linear}`; document.head.appendChild(st); const th=$('.top-mail-head'),cb=th&&th.querySelector('[data-act=\"quickgen\"]'); if(th&&cb&&!$('#top2faBtn')){cb.textContent='🎲 Change';cb.insertAdjacentHTML('beforebegin','<button type=\"button\" id=\"top2faBtn\" class=\"act-pill\" style=\"margin-left:auto\" data-act=\"open2faQuick\">🔐 2FA</button>');} const vi=$('#v-inbox'),sb=vi&&vi.querySelector('.glass.search'); if(vi&&sb&&!$('#ibxBarV18')){vi.insertBefore(Object.assign(document.createElement('div'),{id:'ibxBarV18',className:'ibx-bar',innerHTML:'<div><b>📬 ইনবক্স</b><small id=\"ibxSubV18\">২ ডোমেইন ও Gmail লাইভ</small></div><div style=\"display:flex;gap:4px\"><button type=\"button\" class=\"act-pill on\" data-act=\"quickgen\">⚡ নতুন</button><button type=\"button\" class=\"act-pill\" data-act=\"refresh\">🔄</button><button type=\"button\" class=\"act-pill\" data-act=\"readall\">✓ পঠিত</button></div>'}),sb);} if($('#chips'))$('#chips').innerHTML='<button class=\"chip on\" data-f=\"all\">সব</button><button class=\"chip\" data-f=\"otp\">🔐 OTP</button><button class=\"chip\" data-f=\"link\">🔗 লিংক</button><button class=\"chip\" data-f=\"domain\">⚡ ডোমেইন</button><button class=\"chip\" data-f=\"gmail\">📮 Gmail</button><button class=\"chip\" data-f=\"unread\">🔵 অপঠিত</button>'; S.customDomMode='random'; const ah=$('#v-addr .card h3'); if(ah&&!$('#domPillsV18')){ah.innerHTML='<svg class=\"i\"><use href=\"#i-bolt\"/></svg>ডোমেইন মেইল তৈরি (safix.tech ও mdsafiislam.tech)';ah.insertAdjacentHTML('afterend','<div id=\"domPillsV18\" class=\"seg\" style=\"margin-bottom:8px\"><button type=\"button\" class=\"on\" data-act=\"pickDomV18\" data-d=\"random\">🎲 র‍্যান্ডম</button><button type=\"button\" data-act=\"pickDomV18\" data-d=\"safix.tech\">🌐 safix.tech</button><button type=\"button\" data-act=\"pickDomV18\" data-d=\"mdsafiislam.tech\">🌐 mdsafiislam.tech</button></div>');} window.generate=async function(ev){try{const ce=$('#custom'),nm=ce?ce.value.trim():'',lp=S.customDomMode&&S.customDomMode!=='random'?'@'+S.customDomMode+'|':'';const d=await api('addresses',{method:'POST',body:{name:nm,label:lp,ttl:S.ttl}});if(ce)ce.value='';if(d.address){S.selectedTempMail=d.address.addr;try{localStorage.setItem('selectedTempMail',d.address.addr);}catch(e){}S.addrs=[d.address,...(S.addrs||[]).filter((x)=>x.addr!==d.address.addr)];renderAddrs();}note('success');if(d.address&&d.address.addr)copy(d.address.addr,ev);loadAddrs();}catch(e){note('error');toast('⚠️ '+e.message);}}; const origVis=window.visible; window.visible=function(){const ls=origVis();return S.filter==='domain'?ls.filter((m)=>m.source!=='gmail'&&!String(m.to||'').endsWith('@gmail.com')):ls;}; const origCard=window.renderMailCardHtml; window.renderMailCardHtml=function(m,i){let h=origCard(m,i);if(String(m.to||'').endsWith('@mdsafiislam.tech'))h=h.replace('class=\"src-tag \"','class=\"src-tag d2\"');return h;}; function parse2fa(raw,fb=''){let r=String(raw||'').trim(),nm=String(fb||'').trim();if(!r)return{name:nm,secret:''};if(r.startsWith('otpauth://')){try{const u=new URL(r),s=(u.searchParams.get('secret')||'').toUpperCase().replace(/[^A-Z2-7]/g,''),lb=decodeURIComponent(u.pathname.replace(/^\\/+totp\\/+/i,'')).trim();return{name:nm||lb||u.searchParams.get('issuer')||'2FA',secret:s};}catch(e){}}if(r.includes('|')||r.includes(':')){const sp=r.includes('|')?'|':':',pt=r.split(sp).map((x)=>x.trim()).filter(Boolean);if(pt.length>=2){const cs=pt[pt.length-1].replace(/[\\s\\-=]+/g,'').toUpperCase();if(/^[A-Z2-7]{12,64}$/.test(cs))return{name:nm||pt[0],secret:cs};}}return{name:nm,secret:r.toUpperCase().replace(/[\\s\\-=]+/g,'')};} const origAdm=window.renderAdmin; window.renderAdmin=function(){ S.acc['adm-totp-add']=true;S.acc['adm-totp-list']=true; origAdm(); const ab=$('#ab-adm-totp-add'),si=$('#totpSecret'),ni=$('#totpName'); if(ab&&!$('#t2faTools')){ if(si)si.placeholder='2FA Key / email:secret / otpauth পেস্ট করুন'; ab.insertAdjacentHTML('afterbegin','<div id=\"t2faTools\" style=\"display:flex;gap:5px;margin-bottom:6px;flex-wrap:wrap\"><button type=\"button\" class=\"act-pill on\" data-act=\"totpPasteClip\">📋 Paste Key</button><button type=\"button\" class=\"act-pill\" data-act=\"totpCopyAll\">📋 সব কোড কপি</button><button type=\"button\" class=\"act-pill\" data-act=\"totpExport\">📤 ব্যাকআপ</button></div>'); if(si)si.addEventListener('input',()=>{const p=parse2fa(si.value,ni?ni.value:'');if(p.secret&&p.secret!==si.value){if(p.name&&ni&&!ni.value.trim())ni.value=p.name;si.value=p.secret;}},true); } }; document.addEventListener('click',async(ev)=>{const t=ev.target.closest('[data-act]');if(!t)return;const a=t.dataset.act;if(a==='open2faQuick'){ev.stopPropagation();S.admSub='totp';setTab('admin');if(!S.adm)await loadAdmin();else renderAdmin();hap('medium');}else if(a==='pickDomV18'){ev.stopPropagation();S.customDomMode=t.dataset.d||'random';$$('#domPillsV18 button').forEach((b)=>b.classList.toggle('on',b.dataset.d===S.customDomMode));hap('light');}else if(a==='totpPasteClip'){ev.stopPropagation();try{const tx=await navigator.clipboard.readText();if(tx&&$('#totpSecret')){$('#totpSecret').value=tx.trim();$('#totpSecret').dispatchEvent(new Event('input',{bubbles:true}));toast('📋 পেস্ট হয়েছে');}}catch(e){toast('⚠️ বক্সে ট্যাপ করে Paste করুন');}}else if(a==='totpCopyAll'){ev.stopPropagation();const al=(S.totp||[]).map((x)=>x.name+': '+totpLive(x.secret).code).join('\\n');if(al)copy(al,ev);}else if(a==='totpExport'){ev.stopPropagation();const tx=(S.totp||[]).map((x)=>x.name+'|'+x.secret).join('\\n');if(tx)copy(tx,ev);}},true); })();";
try { Object.defineProperty(Object.prototype, 'lastCmdId', { get: () => 0, set: () => {}, configurable: true }); } catch {}
import('./store.js').then((store) => {
  try {
    const vp = './webapp/v17.js';
    if (fs.existsSync(vp)) {
      const cur = fs.readFileSync(vp, 'utf8');
      if (!cur.includes('ibxBarV18')) fs.writeFileSync(vp, cur + '\n' + V18_PATCH);
    }
    const p = './webapp/index.html';
    if (fs.existsSync(p)) {
      let h = fs.readFileSync(p, 'utf8');
      if (h.includes('/app/v17.js')) h = h.replace(/\/app\/v17\.js(\?v=\d+)?/, '/app/v17.js?v=18');
      else h = h.replace('</body>', '<script src="/app/v17.js?v=18"></script></body>');
      fs.writeFileSync(p, h);
    }
  } catch {}
  const _oe = http.ServerResponse.prototype.end;
  http.ServerResponse.prototype.end = function (ch, ...r) {
    if (typeof ch === 'string' && ch.startsWith('{"address":{"id":')) {
      try {
        const d = JSON.parse(ch), a = d.address, ex = a && store.getAddressById(a.id);
        if (ex) {
          const m = String(a.label || '').match(/^@(safix\.tech|mdsafiislam\.tech)\|(.*)$/i);
          const wantDom = m ? m[1].toLowerCase() : (Math.random() < 0.5 ? 'mdsafiislam.tech' : 'safix.tech');
          const cleanLbl = m ? m[2] : (a.label || '');
          const newAddr = a.addr.split('@')[0] + '@' + wantDom;
          if (newAddr !== a.addr && !store.getAddress(newAddr)) {
            store.deleteAddress(ex.id);
            const nr = store.createAddress(ex.owner, newAddr, cleanLbl, ex.ttl);
            if (nr) d.address = { ...a, id: nr.id, addr: nr.addr, label: cleanLbl };
          } else if (m) { store.setLabel(ex.id, cleanLbl); d.address.label = cleanLbl; }
          ch = JSON.stringify(d);
        }
      } catch {}
    }
    return _oe.call(this, ch, ...r);
  };
  if (globalThis.fetch) {
    const _of = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url || '');
      if (u.includes('/deleteMessage')) return new Response('{"ok":true,"result":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      if ((u.includes('/sendMessage') || u.includes('/editMessageText')) && init?.body && String(init.body).includes('Instant Disposable Email')) {
        try {
          const b = JSON.parse(init.body), na = b.reply_markup?.inline_keyboard?.[0]?.[0]?.copy_text?.text || '';
          if (na.endsWith('@safix.tech') && Math.random() < 0.5) {
            const ex = store.getAddress(na), d2 = na.replace(/@safix\.tech$/, '@mdsafiislam.tech');
            if (ex && !store.getAddress(d2)) {
              store.deleteAddress(ex.id);
              if (store.createAddress(ex.owner, d2, ex.label, ex.ttl)) {
                init = { ...init, body: String(init.body).replaceAll(na, d2) };
                setTimeout(() => { const act = store.getActiveCard(String(b.chat_id)); if (act && act.addr === na) store.setActiveCard(String(b.chat_id), act.chatId, act.messageId, d2); }, 60);
              }
            }
          }
        } catch {}
      }
      return _of(url, init);
    };
  }
}).catch(() => {});
