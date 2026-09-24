/** Hosted sign-in / sign-out pages, so an app with `auth:` needs no UI code at all. */

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const LABELS: Record<string, string> = { google: 'Google', github: 'GitHub', microsoft: 'Microsoft' };

const STYLE = `body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#101828}
main{width:min(22rem,calc(100% - 2rem));background:#fff;border:1px solid #e4e7ec;border-radius:14px;padding:1.75rem}
h1{font-size:1.2rem;margin:0 0 1rem}button,input{font:inherit;width:100%;box-sizing:border-box;border-radius:9px;padding:.6rem .8rem}
button{border:1px solid #d0d5dd;background:#fff;cursor:pointer;margin:.25rem 0;font-weight:600}button.primary{background:#101828;color:#fff;border-color:#101828}
input{border:1px solid #d0d5dd;margin:.25rem 0}.or{color:#667085;text-align:center;margin:.75rem 0;font-size:.85rem}#msg{color:#475467;font-size:.9rem;min-height:1.2em}`;

export function hostedLoginPage(o: { base: string; providers: string[]; email: string; appName: string; oidcName?: string }): string {
  const buttons = o.providers
    .map((p) => `<button data-p="${esc(p)}">Continue with ${esc(p === 'oidc' ? (o.oidcName ?? 'SSO') : (LABELS[p] ?? p))}</button>`)
    .join('');
  const email =
    o.email === 'magic-link'
      ? `<form id="ml"><input type="email" name="email" placeholder="you@example.com" required autocomplete="email"><button class="primary">Email me a sign-in link</button></form>`
      : o.email === 'password'
        ? `<form id="pw"><input type="email" name="email" placeholder="you@example.com" required autocomplete="email"><input type="password" name="password" placeholder="Password" required autocomplete="current-password"><button class="primary">Sign in</button><button type="button" id="signup">Create account</button></form>`
        : '';
  const or = buttons && email ? '<div class="or">or</div>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · ${esc(o.appName)}</title><style>${STYLE}</style></head><body><main><h1>Sign in to ${esc(o.appName)}</h1>${buttons}${or}${email}<p id="msg"></p></main>
<script>
const base=${JSON.stringify(o.base)};const qs=new URLSearchParams(location.search);
let cb=qs.get('callbackURL')||'/';if(!cb.startsWith('/')||cb.startsWith('//'))cb='/';
const msg=t=>{document.getElementById('msg').textContent=t};
async function post(p,b){const r=await fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(b)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||('Failed ('+r.status+')'));return j}
document.querySelectorAll('button[data-p]').forEach(b=>b.onclick=async()=>{try{const p=b.dataset.p;const j=p==='oidc'?await post('/sign-in/oauth2',{providerId:'oidc',callbackURL:cb}):await post('/sign-in/social',{provider:p,callbackURL:cb});if(j.url)location.assign(j.url)}catch(e){msg(e.message)}});
const ml=document.getElementById('ml');if(ml)ml.onsubmit=async e=>{e.preventDefault();try{await post('/sign-in/magic-link',{email:ml.email.value,callbackURL:cb});msg('Check your inbox for a sign-in link.')}catch(err){msg(err.message)}};
const pw=document.getElementById('pw');if(pw){pw.onsubmit=async e=>{e.preventDefault();try{await post('/sign-in/email',{email:pw.email.value,password:pw.password.value});location.assign(cb)}catch(err){msg(err.message)}};
document.getElementById('signup').onclick=async()=>{try{await post('/sign-up/email',{email:pw.email.value,password:pw.password.value,name:pw.email.value.split('@')[0]});location.assign(cb)}catch(err){msg(err.message)}}}
</script></body></html>`;
}

export function hostedLogoutPage(base: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signing out</title><style>${STYLE}</style></head><body><main><h1>Signing out…</h1><p id="msg"></p></main>
<script>fetch(${JSON.stringify(base)}+'/sign-out',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:'{}'}).finally(()=>{document.querySelector('h1').textContent='Signed out';document.getElementById('msg').innerHTML='<a href="'+${JSON.stringify(base)}+'/login">Sign in again</a>'})</script></body></html>`;
}
