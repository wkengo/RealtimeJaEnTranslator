const ALLOWED_ORIGINS = new Set([
  'https://wkengo.github.io'
]);
const MODEL = 'models/gemini-3.5-live-translate-preview';

function cors(origin){
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://wkengo.github.io',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(data,status,origin){
  return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8',...cors(origin),'Cache-Control':'no-store'}});
}
export default {
  async fetch(request, env) {
    const origin=request.headers.get('Origin')||'';
    if(request.method==='OPTIONS') return new Response(null,{status:204,headers:cors(origin)});
    if(origin && !ALLOWED_ORIGINS.has(origin)) return json({message:'このサイトからは利用できません。'},403,origin);

    const url=new URL(request.url);
    if(url.pathname==='/health' && request.method==='GET'){
      return json({ok:true,apiKeyConfigured:!!env.GEMINI_API_KEY,service:'RealtimeJaEnTranslator token worker'},200,origin);
    }
    if(url.pathname!=='/token' || request.method!=='POST') return json({message:'Not found'},404,origin);
    if(!env.GEMINI_API_KEY) return json({message:'WorkerにGEMINI_API_KEYが設定されていません。',code:'API_KEY_MISSING'},500,origin);

    // Keep the token constrained to the Live Translate model, but let the web app
    // provide language, dictionary and VAD settings. This avoids silently ignoring
    // client-side setup changes when an ephemeral token is used.
    try{ await request.json(); }catch{}
    const now=Date.now();
    const tokenRequest={
      uses:1,
      expireTime:new Date(now+20*60*1000).toISOString(),
      newSessionExpireTime:new Date(now+2*60*1000).toISOString(),
      fieldMask:'model',
      bidiGenerateContentSetup:{model:MODEL}
    };

    let upstream;
    try{
      upstream=await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens',{
        method:'POST',
        headers:{'x-goog-api-key':env.GEMINI_API_KEY,'Content-Type':'application/json'},
        body:JSON.stringify(tokenRequest)
      });
    }catch{
      return json({message:'Geminiへ接続できませんでした。',code:'UPSTREAM_NETWORK'},503,origin);
    }
    const data=await upstream.json().catch(()=>({}));
    if(!upstream.ok){
      let message='Geminiの一時トークンを発行できませんでした。';
      if(upstream.status===429) message='Geminiの利用上限に達しています。少し待ってからお試しください。';
      else if(upstream.status===401||upstream.status===403) message='Gemini APIキーまたはAPI利用権限を確認してください。';
      else if(upstream.status>=500) message='Geminiが一時的に混雑しています。少し待ってからお試しください。';
      return json({message,code:`UPSTREAM_${upstream.status}`},upstream.status,origin);
    }
    if(!data.name) return json({message:'Geminiから有効なトークンを取得できませんでした。'},502,origin);
    return json({token:data.name,model:MODEL,expireTime:data.expireTime||tokenRequest.expireTime},200,origin);
  }
};
