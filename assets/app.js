const DICT_KEY = 'realtimeJaEn.dictionary.v2';
const ROWS_KEY = 'realtimeJaEn.rows.v1';
const WORKER_KEY = 'realtimeJaEn.workerUrl.v1';
const MODE_KEY = 'realtimeJaEn.inputMode.v1';
const DEFAULT_DICT = [{ reading: 'たかえ', word: '貴恵' }];
const MODEL = 'gemini-3.5-live-translate-preview';
const DEFAULT_WORKER_URL = 'https://realtime-ja-en-token.wkengog.workers.dev';
const PUBLIC_APP_URL = 'https://wkengo.github.io/RealtimeJaEnTranslator/';
const WS_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const ROTATE_MS = 8 * 60 * 1000 + 30 * 1000;

const $ = s => document.querySelector(s);
const els = {
  start: $('#btnStart'), language: $('#btnLanguage'), latest: $('#btnLatest'), copyAll: $('#btnCopyAll'), saveCsv: $('#btnSaveCsv'), clear: $('#btnClear'), dictionary: $('#btnDictionary'), settings: $('#btnSettings'), filler: $('#chkFiller'),
  status: $('#status'), meterBar: $('#meterBar'), meterValue: $('#meterValue'), interim: $('#interim'), wrap: $('#tableWrap'), body: $('#resultBody'), empty: $('#emptyState'), rows: $('#rowCount'), engineInfo: $('#engineInfo'),
  ctx: $('#contextMenu'), ctxCopy: $('#ctxCopy'), dictDialog: $('#dictDialog'), dictBody: $('#dictBody'), addDict: $('#btnAddDict'), importDict: $('#btnImportDict'), exportDict: $('#btnExportDict'), dictFile: $('#dictFile'), saveDict: $('#btnSaveDict'), toast: $('#toast'),
  settingsDialog: $('#settingsDialog'), workerUrl: $('#workerUrl'), testWorker: $('#btnTestWorker'), saveSettings: $('#btnSaveSettings')
};

let dictionary = loadArray(DICT_KEY, loadArray('realtimeJaEn.dictionary.v1', DEFAULT_DICT));
let rows = loadArray(ROWS_KEY, []);
let workerUrl = localStorage.getItem(WORKER_KEY) || DEFAULT_WORKER_URL;
let inputMode = localStorage.getItem(MODE_KEY) === 'en' ? 'en' : 'ja';
let running = false;
let deliberateStop = false;
let websocket = null;
let setupReady = false;
let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let analyser = null;
let silentGainNode = null;
let meterRAF = null;
let rotateTimer = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let liveInput = '';
let liveOutput = '';
let liveInterim = '';
let contextText = '';
let commitTimer = null;

function loadArray(key, fallback){
  try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : fallback; } catch { return fallback; }
}
function saveRows(){ localStorage.setItem(ROWS_KEY, JSON.stringify(rows)); }
function saveDict(){ localStorage.setItem(DICT_KEY, JSON.stringify(dictionary)); }
function setStatus(text, isError=false){ els.status.textContent=text; els.status.classList.toggle('error',isError); }
function toast(text, ms=1600){ els.toast.textContent=text; els.toast.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>els.toast.hidden=true,ms); }
function escCsv(v){ return `"${String(v??'').replaceAll('"','""')}"`; }
function download(name, text, type='text/plain;charset=utf-8'){
  const blob=new Blob(['\uFEFF'+text],{type}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
async function copyText(text){
  try { await navigator.clipboard.writeText(text); toast('コピーしました'); }
  catch { const ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('コピーしました'); }
}
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

function renderRows(){
  els.body.innerHTML='';
  for(const r of rows) addRowDom(r, false);
  if(running && (liveInput || liveOutput || liveInterim)) addLiveRowDom();
  els.empty.style.display = rows.length || liveInput || liveOutput || liveInterim ? 'none' : 'flex';
  els.rows.textContent=`${rows.length} 行`;
}
function addRowDom(r, pending=false){
  const tr=document.createElement('tr');
  if(pending) tr.classList.add('pending');
  tr.appendChild(makeCell(r.japanese || (pending?'聞き取り中…':''),'ja'));
  tr.appendChild(makeCell(r.english || (pending?'翻訳中…':''),'en'));
  els.body.appendChild(tr);
}
function addLiveRowDom(){
  const source = liveInput || liveInterim;
  const target = liveOutput;
  if(inputMode==='ja') addRowDom({japanese:source, english:target}, true);
  else addRowDom({japanese:target, english:source}, true);
}
function makeCell(text, lang){
  const td=document.createElement('td'); td.dataset.lang=lang; td.dataset.text=text;
  const div=document.createElement('div'); div.className='cell';
  const span=document.createElement('span'); span.className='cellText'; span.textContent=text;
  const btn=document.createElement('button'); btn.type='button'; btn.className='copyCell'; btn.title='このセルをコピー'; btn.textContent='⧉'; btn.addEventListener('click',e=>{e.stopPropagation(); copyText(td.dataset.text);});
  div.append(span,btn); td.appendChild(div);
  td.addEventListener('contextmenu',e=>{e.preventDefault(); contextText=td.dataset.text; showContextMenu(e.clientX,e.clientY);});
  return td;
}
function showContextMenu(x,y){ els.ctx.hidden=false; const w=110,h=40; els.ctx.style.left=Math.min(x,innerWidth-w)+'px'; els.ctx.style.top=Math.min(y,innerHeight-h)+'px'; }
document.addEventListener('click',()=>els.ctx.hidden=true);
els.ctxCopy.addEventListener('click',()=>{ els.ctx.hidden=true; copyText(contextText); });

function normalizeKatakanaToHiragana(s){ return s.replace(/[ァ-ヶ]/g,ch=>String.fromCharCode(ch.charCodeAt(0)-0x60)); }
function dictionaryPreReplace(text){
  let out=text;
  for(const d of dictionary){
    const reading=(d.reading||'').trim(); const word=(d.word||'').trim(); if(!reading||!word) continue;
    const hira=normalizeKatakanaToHiragana(reading);
    const kata=[...hira].map(ch=>{const c=ch.charCodeAt(0); return c>=0x3041&&c<=0x3096?String.fromCharCode(c+0x60):ch;}).join('');
    for(const v of new Set([reading,hira,kata])) out=out.split(v).join(word);
  }
  return out;
}
function localFillerCleanup(text){
  if(!els.filler.checked) return text.trim();
  let s=text.trim();
  const lead=/^(?:(?:えー+|ええと|えっと+|あー+|あのー+|そのー+|うーん+|んー+|まあ)[、,\s]*)+/;
  s=s.replace(lead,'');
  s=s.replace(/([。！？、,]\s*)(?:えー+|ええと|えっと+|あー+|あのー+|そのー+|うーん+|んー+)(?=[、,\s]|$)/g,'$1');
  return s.replace(/\s{2,}/g,' ').trim();
}
function postProcessJapanese(text){ return localFillerCleanup(dictionaryPreReplace(text || '')); }
function customVocabulary(){
  const values=[];
  for(const d of dictionary){
    const reading=(d.reading||'').trim(), word=(d.word||'').trim();
    if(reading) values.push(reading);
    if(word) values.push(word);
  }
  return [...new Set(values)].slice(0,100);
}
function joinTranscript(base, next){
  base=(base||'').trim(); next=(next||'').trim(); if(!next) return base; if(!base) return next;
  if(next.startsWith(base)) return next;
  if(base.endsWith(next)) return base;
  const spacer=/[A-Za-z0-9.!?]$/.test(base) && /^[A-Za-z0-9]/.test(next) ? ' ' : '';
  return base + spacer + next;
}
function normalizeEnglish(text){
  return String(text||'').replace(/([.!?])(?=[A-Za-z])/g,'$1 ').replace(/\s{2,}/g,' ').trim();
}
function splitSentences(text){
  const s=String(text||'').trim();
  if(!s) return [];
  const parts=s.match(/[^。！？.!?]+(?:[。！？.!?]+|$)/g);
  return (parts||[s]).map(v=>v.trim()).filter(Boolean);
}
function appendCommittedRows(src,dst){
  let japanese='', english='';
  if(inputMode==='ja'){
    japanese=postProcessJapanese(src);
    english=normalizeEnglish(dst);
  }else{
    japanese=postProcessJapanese(dst);
    english=normalizeEnglish(src);
  }
  const jaParts=splitSentences(japanese);
  const enParts=splitSentences(english);
  if(jaParts.length>1 && jaParts.length===enParts.length){
    for(let i=0;i<jaParts.length;i++){
      rows.push({id:crypto.randomUUID?crypto.randomUUID():`${Date.now()}_${Math.random()}_${i}`, japanese:jaParts[i], english:enParts[i]});
    }
  }else if(japanese || english){
    rows.push({id:crypto.randomUUID?crypto.randomUUID():`${Date.now()}_${Math.random()}`, japanese, english});
  }
}

function updateLanguageUi(){
  const ja=inputMode==='ja';
  els.language.textContent=ja?'日本語':'英語';
  els.language.classList.toggle('english',!ja);
  els.interim.textContent=running ? `${ja?'日本語':'英語'}を聞き取り中…` : `ここに認識中の${ja?'日本語':'英語'}が表示されます`;
  els.empty.textContent=`「開始」を押して${ja?'日本語':'英語'}で話してください。`;
  els.engineInfo.textContent=`音声認識・翻訳：Gemini 3.5 Live Translate / 入力：${ja?'日本語':'英語'}`;
}

function commitLiveRow(){
  clearTimeout(commitTimer); commitTimer=null;
  const src=(liveInput||liveInterim||'').trim();
  const dst=(liveOutput||'').trim();
  if(!src && !dst) return;
  appendCommittedRows(src,dst);
  saveRows();
  liveInput=''; liveOutput=''; liveInterim='';
  renderRows(); scrollLatest(); updateLanguageUi();
}
function scheduleCommit(delay=850){ clearTimeout(commitTimer); commitTimer=setTimeout(commitLiveRow,delay); }

function friendlyError(err){
  const status=err?.status || 0;
  const code=err?.code || '';
  const msg=String(err?.message || err || '');
  if(status===429 || /429|quota|rate.?limit/i.test(msg)) return '現在の利用上限に達しました。少し待ってから、もう一度「開始」を押してください。';
  if(status===401 || status===403 || /api.?key|permission|unauthorized|forbidden/i.test(msg)) return '接続設定を確認してください。Cloudflare Worker側のGemini APIキー設定が必要です。';
  if(/worker.*未設定|worker.*url/i.test(msg)) return 'Cloudflare Workerが未設定です。「接続設定」からWorker URLを登録してください。';
  if(code==='API_KEY_MISSING') return 'Cloudflare WorkerにGemini APIキーが設定されていません。WorkerのSecret設定を確認してください。';
  if(code==='MIC_DENIED' || /permission|notallowed/i.test(msg)) return 'マイクを利用できません。Safari/ブラウザのマイク許可を確認してください。';
  if(/network|fetch|failed to fetch|offline/i.test(msg)) return '通信できませんでした。ネットワーク接続を確認してください。';
  if(status===500 || status===502 || status===503 || status===504) return 'Geminiが一時的に混雑しています。自動再接続できない場合は少し待ってから再開してください。';
  return '翻訳サービスへ接続できませんでした。少し待ってからもう一度お試しください。';
}

function normalizedWorkerUrl(){ return (workerUrl || DEFAULT_WORKER_URL).trim().replace(/\/+$/,''); }
async function fetchToken(){
  const base=normalizedWorkerUrl();
  if(!base) throw Object.assign(new Error('Worker URL未設定'),{code:'WORKER_URL'});
  const payload={mode:inputMode, vocabulary:customVocabulary(), smart:!!els.filler.checked};
  let lastErr;
  for(let attempt=0;attempt<3;attempt++){
    try{
      const res=await fetch(`${base}/token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store'});
      const data=await res.json().catch(()=>({}));
      if(res.ok && data.token) return data.token;
      const err=Object.assign(new Error(data.message||data.error||`HTTP ${res.status}`),{status:res.status,code:data.code||''});
      if(![500,502,503,504].includes(res.status)) throw err;
      lastErr=err;
    }catch(e){
      lastErr=e;
      if(e?.status && ![500,502,503,504].includes(e.status)) throw e;
    }
    if(attempt<2) await wait(1000 * (2**attempt));
  }
  throw lastErr || new Error('token fetch failed');
}

function buildSetup(){
  const sourceCode=inputMode==='ja'?'ja-JP':'en-US';
  const targetCode=inputMode==='ja'?'en':'ja';
  const inputAudioTranscription={languageCodes:[sourceCode]};
  const vocab=customVocabulary();
  if(vocab.length) inputAudioTranscription.customVocabulary=vocab;
  inputAudioTranscription.mode=els.filler.checked?'SMART':'VERBATIM';
  return {
    model:`models/${MODEL}`,
    generationConfig:{responseModalities:['AUDIO'],translationConfig:{targetLanguageCode:targetCode,echoTargetLanguage:false}},
    inputAudioTranscription,
    outputAudioTranscription:{languageCodes:[targetCode]},
    realtimeInputConfig:{activityHandling:'NO_INTERRUPTION'}
  };
}

async function connectLive(isReconnect=false){
  if(!running) return;
  setStatus(isReconnect?'再接続中…':'Geminiへ接続中…');
  const token=await fetchToken();
  if(!running) return;
  await new Promise((resolve,reject)=>{
    const ws=new WebSocket(`${WS_ENDPOINT}?access_token=${encodeURIComponent(token)}`);
    websocket=ws; setupReady=false;
    const timeout=setTimeout(()=>{ try{ws.close();}catch{} reject(new Error('接続タイムアウト')); },10000);
    ws.onopen=()=>{ ws.send(JSON.stringify({setup:buildSetup()})); };
    ws.binaryType='arraybuffer';
    ws.onmessage=async e=>{
      let raw=e.data;
      try{
        if(raw instanceof Blob) raw=await raw.text();
        else if(raw instanceof ArrayBuffer) raw=new TextDecoder().decode(raw);
      }catch{return;}
      let data; try{ data=JSON.parse(raw); }catch{return;}
      if(data.setupComplete){
        clearTimeout(timeout); setupReady=true; reconnectAttempt=0; setStatus(`翻訳中（${inputMode==='ja'?'日本語→English':'英語→日本語'}）`); scheduleRotation(); resolve(); return;
      }
      handleServerMessage(data);
    };
    ws.onerror=()=>{ clearTimeout(timeout); if(!setupReady) reject(new Error('WebSocket接続エラー')); };
    ws.onclose=e=>{
      clearTimeout(timeout); setupReady=false;
      if(websocket===ws) websocket=null;
      if(running && !deliberateStop) handleUnexpectedClose(e);
    };
  });
}

function handleServerMessage(data){
  const sc=data.serverContent;
  if(sc){
    if(sc.interimInputTranscription?.text){
      if(commitTimer && liveInput && liveOutput) commitLiveRow();
      liveInterim=sc.interimInputTranscription.text.trim();
      els.interim.textContent=liveInterim || `${inputMode==='ja'?'日本語':'英語'}を聞き取り中…`;
      renderRows(); scrollLatest();
    }
    if(sc.inputTranscription?.text){
      liveInput=joinTranscript(liveInput,sc.inputTranscription.text);
      liveInterim='';
      els.interim.textContent=liveInput;
      renderRows(); scrollLatest(); scheduleCommit(1100);
    }
    if(sc.outputTranscription?.text){
      liveOutput=joinTranscript(liveOutput,sc.outputTranscription.text);
      renderRows(); scrollLatest(); scheduleCommit(700);
    }
    if(sc.turnComplete || sc.generationComplete) scheduleCommit(sc.turnComplete?250:500);
  }
  if(data.goAway){
    setStatus('接続を更新しています…');
    restartConnection('goaway');
  }
}

async function handleUnexpectedClose(e){
  if(!running || deliberateStop) return;
  clearTimeout(rotateTimer);
  if(liveInput || liveOutput) commitLiveRow();
  if(reconnectAttempt>=3){
    setStatus('接続が切れました。「開始」を押して再接続してください。',true);
    running=false; await stopAudioCapture(); updateStartUi(); return;
  }
  const delay=1000*(2**reconnectAttempt); reconnectAttempt++;
  setStatus(`通信が切れました。${delay/1000}秒後に自動再接続します…`,true);
  clearTimeout(reconnectTimer);
  reconnectTimer=setTimeout(async()=>{
    try{ await connectLive(true); }
    catch(err){ setStatus(friendlyError(err),true); handleUnexpectedClose({}); }
  },delay);
}
function scheduleRotation(){
  clearTimeout(rotateTimer);
  rotateTimer=setTimeout(()=>restartConnection('rotation'),ROTATE_MS);
}
async function restartConnection(){
  if(!running) return;
  deliberateStop=true;
  if(liveInput || liveOutput) commitLiveRow();
  try{ websocket?.close(1000,'refresh'); }catch{}
  websocket=null; setupReady=false; deliberateStop=false;
  try{ await connectLive(true); }
  catch(err){ setStatus(friendlyError(err),true); handleUnexpectedClose({}); }
}

function floatTo16BitPCM(float32){
  const buffer=new ArrayBuffer(float32.length*2); const view=new DataView(buffer);
  for(let i=0;i<float32.length;i++){ const s=Math.max(-1,Math.min(1,float32[i])); view.setInt16(i*2,s<0?s*0x8000:s*0x7fff,true); }
  return new Uint8Array(buffer);
}
function resampleTo16k(input,inputRate){
  if(inputRate===16000) return input;
  const ratio=inputRate/16000; const newLen=Math.max(1,Math.round(input.length/ratio)); const out=new Float32Array(newLen);
  for(let i=0;i<newLen;i++){
    const pos=i*ratio, left=Math.floor(pos), right=Math.min(input.length-1,left+1), frac=pos-left;
    out[i]=input[left]*(1-frac)+input[right]*frac;
  }
  return out;
}
function bytesToBase64(bytes){
  let binary=''; const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk) binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+chunk,bytes.length)));
  return btoa(binary);
}

async function startAudioCapture(){
  try{
    mediaStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});
  }catch(e){ throw Object.assign(e,{code:'MIC_DENIED'}); }
  audioContext=new (window.AudioContext||window.webkitAudioContext)();
  await audioContext.resume();
  sourceNode=audioContext.createMediaStreamSource(mediaStream);
  analyser=audioContext.createAnalyser(); analyser.fftSize=512; sourceNode.connect(analyser);
  const bufferSize=2048;
  processorNode=audioContext.createScriptProcessor(bufferSize,1,1);
  silentGainNode=audioContext.createGain(); silentGainNode.gain.value=0;
  sourceNode.connect(processorNode); processorNode.connect(silentGainNode); silentGainNode.connect(audioContext.destination);
  processorNode.onaudioprocess=e=>{
    if(!running || !setupReady || !websocket || websocket.readyState!==WebSocket.OPEN) return;
    const input=e.inputBuffer.getChannelData(0);
    const resampled=resampleTo16k(input,audioContext.sampleRate);
    const pcm=floatTo16BitPCM(resampled);
    websocket.send(JSON.stringify({realtimeInput:{audio:{data:bytesToBase64(pcm),mimeType:'audio/pcm;rate=16000'}}}));
  };
  const meterData=new Uint8Array(analyser.fftSize);
  const tick=()=>{
    if(!analyser) return;
    analyser.getByteTimeDomainData(meterData); let sum=0; for(const v of meterData){const x=(v-128)/128;sum+=x*x;}
    const rms=Math.sqrt(sum/meterData.length); const pct=Math.min(100,Math.round(rms*320));
    els.meterBar.style.width=pct+'%'; els.meterValue.textContent=pct+'%'; meterRAF=requestAnimationFrame(tick);
  };
  tick();
}
async function stopAudioCapture(){
  if(meterRAF) cancelAnimationFrame(meterRAF); meterRAF=null;
  if(processorNode){processorNode.onaudioprocess=null;try{processorNode.disconnect();}catch{}processorNode=null;}
  if(sourceNode){try{sourceNode.disconnect();}catch{}sourceNode=null;}
  if(silentGainNode){try{silentGainNode.disconnect();}catch{}silentGainNode=null;}
  analyser=null;
  if(audioContext){try{await audioContext.close();}catch{}audioContext=null;}
  if(mediaStream){mediaStream.getTracks().forEach(t=>t.stop());mediaStream=null;}
  els.meterBar.style.width='0%'; els.meterValue.textContent='0%';
}

function updateStartUi(){
  els.start.textContent=running?'停止':'開始'; els.start.classList.toggle('primary',!running);
  els.language.disabled=false;
  if(!running) updateLanguageUi();
}
async function start(){
  if(location.protocol==='file:'){
    setStatus('ローカルファイルでは翻訳できないため、GitHub Pagesを開きます…');
    window.location.href=PUBLIC_APP_URL;
    return;
  }
  if(running){ await stop(); return; }
  if(!navigator.mediaDevices?.getUserMedia){ setStatus('このブラウザではマイクを利用できません。',true); return; }
  if(!normalizedWorkerUrl()){ openSettings(); setStatus('先にCloudflare Worker URLを設定してください。',true); return; }
  running=true; deliberateStop=false; reconnectAttempt=0; updateStartUi(); updateLanguageUi();
  try{
    await startAudioCapture();
    await connectLive(false);
  }catch(err){
    setStatus(friendlyError(err),true); toast(friendlyError(err),3000); await stop(false);
  }
}
async function stop(showStatus=true){
  running=false; deliberateStop=true; clearTimeout(rotateTimer); clearTimeout(reconnectTimer); clearTimeout(commitTimer);
  if(liveInput||liveOutput) commitLiveRow();
  if(websocket?.readyState===WebSocket.OPEN){ try{websocket.send(JSON.stringify({realtimeInput:{audioStreamEnd:true}}));}catch{} }
  try{websocket?.close(1000,'user stop');}catch{} websocket=null; setupReady=false;
  await stopAudioCapture(); deliberateStop=false; updateStartUi();
  liveInterim=''; if(showStatus)setStatus('待機中'); updateLanguageUi(); renderRows();
}
function scrollLatest(){ requestAnimationFrame(()=>{els.wrap.scrollTop=els.wrap.scrollHeight;}); }

els.start.addEventListener('click',start);
els.language.addEventListener('click',async()=>{
  const wasRunning=running;
  if(wasRunning) await stop(false);
  inputMode=inputMode==='ja'?'en':'ja'; localStorage.setItem(MODE_KEY,inputMode); updateLanguageUi(); renderRows();
  toast(`入力言語：${inputMode==='ja'?'日本語':'英語'}`);
  if(wasRunning) await start();
});
els.latest.addEventListener('click',scrollLatest);
els.copyAll.addEventListener('click',()=>copyText(rows.map(r=>`${r.japanese}\t${r.english}`).join('\n')));
els.saveCsv.addEventListener('click',()=>{ const csv=['日本語,English',...rows.map(r=>`${escCsv(r.japanese)},${escCsv(r.english)}`)].join('\r\n'); download(`日英翻訳_${new Date().toISOString().slice(0,10)}.csv`,csv,'text/csv;charset=utf-8'); });
els.clear.addEventListener('click',()=>{ if(!rows.length||confirm('表示中の記録をすべて削除しますか？')){ rows=[]; saveRows(); renderRows(); }});

function renderDict(){
  els.dictBody.innerHTML='';
  dictionary.forEach((d,i)=>{
    const tr=document.createElement('tr');
    const tdR=document.createElement('td'),tdW=document.createElement('td'),tdD=document.createElement('td');
    const r=document.createElement('input');r.value=d.reading||'';r.placeholder='たかえ';r.dataset.idx=i;r.dataset.field='reading';
    const w=document.createElement('input');w.value=d.word||'';w.placeholder='貴恵';w.dataset.idx=i;w.dataset.field='word';
    const del=document.createElement('button');del.type='button';del.className='dictDelete';del.textContent='削除';del.onclick=()=>{dictionary.splice(i,1);renderDict();};
    [r,w].forEach(inp=>inp.addEventListener('input',e=>{dictionary[+e.target.dataset.idx][e.target.dataset.field]=e.target.value;}));
    tdR.append(r);tdW.append(w);tdD.append(del);tr.append(tdR,tdW,tdD);els.dictBody.append(tr);
  });
}
els.dictionary.addEventListener('click',()=>{renderDict();els.dictDialog.showModal();});
els.addDict.addEventListener('click',()=>{dictionary.push({reading:'',word:''});renderDict();});
els.saveDict.addEventListener('click',()=>{dictionary=dictionary.filter(d=>d.reading?.trim()||d.word?.trim());saveDict();renderDict();toast('辞書を保存しました');});
els.exportDict.addEventListener('click',()=>{const csv=['よみがな,表記',...dictionary.map(d=>`${escCsv(d.reading)},${escCsv(d.word)}`)].join('\r\n');download('単語辞書.csv',csv,'text/csv;charset=utf-8');});
els.importDict.addEventListener('click',()=>els.dictFile.click());

function parseCsv(text){
  const rows=[]; let row=[],field='',quoted=false;
  text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(quoted){
      if(ch==='"'&&text[i+1]==='"'){field+='"';i++;}
      else if(ch==='"')quoted=false; else field+=ch;
    }else{
      if(ch==='"')quoted=true;
      else if(ch===','){row.push(field);field='';}
      else if(ch==='\n'){row.push(field);rows.push(row);row=[];field='';}
      else if(ch!=='\r')field+=ch;
    }
  }
  if(field.length||row.length){row.push(field);rows.push(row);}
  return rows;
}
els.dictFile.addEventListener('change',async e=>{
  const f=e.target.files?.[0]; if(!f)return;
  const buf=await f.arrayBuffer();
  let csvText=new TextDecoder('utf-8').decode(buf);
  if(csvText.includes('�')){ try{ csvText=new TextDecoder('shift_jis').decode(buf); }catch{} }
  const parsed=parseCsv(csvText);
  let start=0; if(parsed[0]&&/よみ|reading/i.test(parsed[0][0]||''))start=1;
  const incoming=[];
  for(let i=start;i<parsed.length;i++){
    const reading=(parsed[i][0]||'').trim(),word=(parsed[i][1]||'').trim();
    if(reading||word)incoming.push({reading,word});
  }
  if(!incoming.length){toast('読み込めるデータがありません');e.target.value='';return;}
  const merged=dictionary.map(d=>({...d}));
  for(const d of incoming){
    const key=d.reading.trim();
    const idx=key ? merged.findIndex(x=>(x.reading||'').trim()===key) : -1;
    if(idx>=0) merged[idx]=d; else merged.push(d);
  }
  dictionary=merged;
  saveDict();renderDict();toast(`${incoming.length}件を追加・更新しました`);e.target.value='';
  if(running){toast('辞書の変更は次回の接続から音声認識に反映されます',2600);}
});

function openSettings(){ els.workerUrl.value=workerUrl || DEFAULT_WORKER_URL; els.settingsDialog.showModal(); }
els.settings.addEventListener('click',openSettings);
els.saveSettings.addEventListener('click',()=>{
  workerUrl=els.workerUrl.value.trim().replace(/\/+$/,'') || DEFAULT_WORKER_URL; localStorage.setItem(WORKER_KEY,workerUrl); els.settingsDialog.close(); toast('接続設定を保存しました'); setStatus('待機中');
});
els.testWorker.addEventListener('click',async()=>{
  const url=els.workerUrl.value.trim().replace(/\/+$/,''); if(!url){toast('Worker URLを入力してください');return;}
  els.testWorker.disabled=true;
  try{
    const res=await fetch(`${url}/health`,{cache:'no-store'}); const data=await res.json().catch(()=>({}));
    if(res.ok&&data.ok&&data.apiKeyConfigured)toast('接続できました');
    else if(res.ok&&data.ok&&!data.apiKeyConfigured) throw Object.assign(new Error('WorkerにGEMINI_API_KEYが設定されていません。'),{code:'API_KEY_MISSING'});
    else throw Object.assign(new Error(data.message||'接続失敗'),{status:res.status,code:data.code||''});
  }catch(err){toast(friendlyError(err),3000);}finally{els.testWorker.disabled=false;}
});

window.addEventListener('beforeunload',()=>{try{websocket?.close();}catch{}});
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
updateLanguageUi();renderRows();
if(location.protocol==='file:') setStatus('ローカル表示です。「開始」を押すとGitHub Pagesを開きます。');
