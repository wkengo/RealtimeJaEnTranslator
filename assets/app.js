import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app-check.js';
import { getAI, getGenerativeModel, GoogleAIBackend } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-ai.js';

const firebaseConfig = {
  apiKey: 'AIzaSyA3RhomFp4ArvhaS0tAm7PRarIrpRBW3TI',
  authDomain: 'realtimejaentranslator.firebaseapp.com',
  projectId: 'realtimejaentranslator',
  storageBucket: 'realtimejaentranslator.firebasestorage.app',
  messagingSenderId: '695875219323',
  appId: '1:695875219323:web:635338be2a5da60a7c97de'
};
const RECAPTCHA_SITE_KEY = '6Ld5wrctAAAAAAxaYikofQyxcKjhajH2Ga2PKNvU';
const DICT_KEY = 'realtimeJaEn.dictionary.v1';
const ROWS_KEY = 'realtimeJaEn.rows.v1';
const DEFAULT_DICT = [{ reading: 'たかえ', word: '貴恵' }];

const $ = s => document.querySelector(s);
const els = {
  start: $('#btnStart'), latest: $('#btnLatest'), copyAll: $('#btnCopyAll'), saveCsv: $('#btnSaveCsv'), clear: $('#btnClear'), dictionary: $('#btnDictionary'), filler: $('#chkFiller'),
  status: $('#status'), meterBar: $('#meterBar'), meterValue: $('#meterValue'), interim: $('#interim'), wrap: $('#tableWrap'), body: $('#resultBody'), empty: $('#emptyState'), rows: $('#rowCount'),
  ctx: $('#contextMenu'), ctxCopy: $('#ctxCopy'), dictDialog: $('#dictDialog'), dictBody: $('#dictBody'), addDict: $('#btnAddDict'), importDict: $('#btnImportDict'), exportDict: $('#btnExportDict'), dictFile: $('#dictFile'), saveDict: $('#btnSaveDict'), toast: $('#toast')
};

let dictionary = loadJson(DICT_KEY, DEFAULT_DICT);
let rows = loadJson(ROWS_KEY, []);
let running = false;
let recognition = null;
let shouldRestartRecognition = false;
let mediaStream = null;
let audioContext = null;
let analyser = null;
let meterRAF = null;
let contextText = '';
let processingCount = 0;

const app = initializeApp(firebaseConfig);
initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY),
  isTokenAutoRefreshEnabled: true,
});
const ai = getAI(app, { backend: new GoogleAIBackend() });
const pairSchema = {
  type: 'object',
  properties: {
    pairs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          japanese: { type: 'string' },
          english: { type: 'string' }
        },
        required: ['japanese','english']
      }
    }
  },
  required: ['pairs']
};
const model = getGenerativeModel(ai, {
  model: 'gemini-3.7-flash',
  generationConfig: {
    temperature: 0.1,
    responseMimeType: 'application/json',
    responseSchema: pairSchema
  }
});

function loadJson(key, fallback){
  try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : fallback; } catch { return fallback; }
}
function saveRows(){ localStorage.setItem(ROWS_KEY, JSON.stringify(rows)); }
function saveDict(){ localStorage.setItem(DICT_KEY, JSON.stringify(dictionary)); }
function setStatus(text, isError=false){ els.status.textContent=text; els.status.classList.toggle('error',isError); }
function toast(text){ els.toast.textContent=text; els.toast.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>els.toast.hidden=true,1300); }
function escCsv(v){ return `"${String(v??'').replaceAll('"','""')}"`; }
function download(name, text, type='text/plain;charset=utf-8'){
  const blob=new Blob(['\uFEFF'+text],{type}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
async function copyText(text){
  try { await navigator.clipboard.writeText(text); toast('コピーしました'); }
  catch { const ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('コピーしました'); }
}

function renderRows(){
  els.body.innerHTML='';
  for(const r of rows){ addRowDom(r); }
  els.empty.style.display = rows.length ? 'none' : 'flex';
  els.rows.textContent=`${rows.length} 行`;
}
function addRowDom(r){
  const tr=document.createElement('tr'); tr.dataset.id=r.id;
  if(r.pending) tr.classList.add('pending');
  if(r.error) tr.classList.add('errorRow');
  tr.appendChild(makeCell(r.japanese || '処理中…','ja'));
  tr.appendChild(makeCell(r.english || (r.pending?'翻訳中…':''),'en'));
  els.body.appendChild(tr);
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
function dictPrompt(){
  const valid=dictionary.filter(d=>d.reading?.trim()&&d.word?.trim());
  if(!valid.length) return '登録辞書なし';
  return valid.map(d=>`${d.reading.trim()} => ${d.word.trim()}`).join('\n');
}
async function correctAndTranslate(raw){
  const pre = localFillerCleanup(dictionaryPreReplace(raw));
  if(!pre) return [];
  const prompt = `あなたは日本語音声認識結果の校正と日英翻訳を行います。\n\n【必須ルール】\n1. 発話の意味を変えない。内容を追加しない。\n2. 下の単語辞書を最優先で参照し、同じ読み・同音の固有名詞や専門用語は指定表記へ補正する。例：辞書に「たかえ => 貴恵」があれば、認識結果が「たかえ」「タカエ」「高江」等でも文脈上その名前なら「貴恵」にする。\n3. ${els.filler.checked?'「あー」「えー」「えっと」「あのー」「そのー」「うーん」など、意味を持たないフィラーだけ除去する。':'フィラーを勝手に削除しない。'}\n4. 日本語を自然な句読点で整える。\n5. 文章ごとに分割し、各日本語文と対応する自然な英訳を同じ配列要素にする。\n6. 固有名詞は辞書の読みを参考に英語側でも自然に扱う。\n\n【単語辞書】\n${dictPrompt()}\n\n【音声認識結果】\n${pre}`;
  const result = await model.generateContent(prompt);
  const parsed=JSON.parse(result.response.text());
  return Array.isArray(parsed.pairs)?parsed.pairs.filter(p=>p.japanese||p.english):[];
}

async function processFinalTranscript(raw){
  const tempId=`p_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const temp={id:tempId,japanese:localFillerCleanup(dictionaryPreReplace(raw)),english:'',pending:true};
  rows.push(temp); saveRows(); renderRows(); scrollLatest(); processingCount++; updateRunningStatus();
  try{
    const pairs=await correctAndTranslate(raw);
    const idx=rows.findIndex(r=>r.id===tempId); if(idx<0) return;
    const newRows=(pairs.length?pairs:[{japanese:temp.japanese,english:'翻訳結果を取得できませんでした。'}]).map(p=>({id:crypto.randomUUID?crypto.randomUUID():`${Date.now()}_${Math.random()}`,japanese:(p.japanese||'').trim(),english:(p.english||'').trim()}));
    rows.splice(idx,1,...newRows); saveRows(); renderRows(); scrollLatest();
  }catch(err){
    const idx=rows.findIndex(r=>r.id===tempId); if(idx>=0){ rows[idx]={...temp,pending:false,error:true,english:`エラー: ${err?.message||err}`}; saveRows(); renderRows(); }
    setStatus('翻訳エラー',true);
  }finally{ processingCount=Math.max(0,processingCount-1); updateRunningStatus(); }
}

function updateRunningStatus(){
  if(!running){ setStatus('待機中'); return; }
  setStatus(processingCount?`録音中・翻訳処理 ${processingCount}件`:'録音・翻訳中');
}

function createRecognition(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR) return null;
  const r=new SR();
  r.lang='ja-JP'; r.continuous=true; r.interimResults=true; r.maxAlternatives=1;
  r.onstart=()=>{ els.interim.textContent='聞き取り中…'; updateRunningStatus(); };
  r.onresult=e=>{
    let interim='';
    for(let i=e.resultIndex;i<e.results.length;i++){
      const t=e.results[i][0]?.transcript?.trim()||'';
      if(e.results[i].isFinal){ if(t) processFinalTranscript(t); }
      else interim+=t;
    }
    els.interim.textContent=interim||'聞き取り中…';
  };
  r.onerror=e=>{
    if(e.error==='no-speech') return;
    if(e.error==='aborted') return;
    setStatus(`音声認識エラー: ${e.error}`,true);
  };
  r.onend=()=>{
    if(shouldRestartRecognition&&running){ setTimeout(()=>{try{r.start();}catch{}},250); }
  };
  return r;
}

async function startMicMeter(){
  mediaStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  audioContext=new (window.AudioContext||window.webkitAudioContext)();
  const src=audioContext.createMediaStreamSource(mediaStream); analyser=audioContext.createAnalyser(); analyser.fftSize=512; src.connect(analyser);
  const data=new Uint8Array(analyser.fftSize);
  const tick=()=>{ if(!analyser) return; analyser.getByteTimeDomainData(data); let sum=0; for(const v of data){const x=(v-128)/128; sum+=x*x;} const rms=Math.sqrt(sum/data.length); const pct=Math.min(100,Math.round(rms*320)); els.meterBar.style.width=pct+'%'; els.meterValue.textContent=pct+'%'; meterRAF=requestAnimationFrame(tick); };
  tick();
}
function stopMicMeter(){
  if(meterRAF) cancelAnimationFrame(meterRAF); meterRAF=null; analyser=null;
  if(audioContext){audioContext.close().catch(()=>{});audioContext=null;}
  if(mediaStream){mediaStream.getTracks().forEach(t=>t.stop());mediaStream=null;}
  els.meterBar.style.width='0%'; els.meterValue.textContent='0%';
}

async function start(){
  if(running) return stop();
  try{
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザではマイクを利用できません。');
    recognition=createRecognition();
    if(!recognition) throw new Error('このブラウザは音声認識に対応していません。iPhoneはSafari、PCはChrome/Edge最新版で開いてください。');
    await startMicMeter();
    running=true; shouldRestartRecognition=true; els.start.textContent='停止'; els.start.classList.remove('primary');
    recognition.start(); updateRunningStatus();
  }catch(err){ stop(); setStatus(err?.message||String(err),true); }
}
function stop(){
  running=false; shouldRestartRecognition=false; els.start.textContent='開始'; els.start.classList.add('primary');
  try{recognition?.stop();}catch{} recognition=null; stopMicMeter(); els.interim.textContent='ここに認識中の日本語が表示されます'; updateRunningStatus();
}
function scrollLatest(){ requestAnimationFrame(()=>{els.wrap.scrollTop=els.wrap.scrollHeight;}); }

els.start.addEventListener('click',start);
els.latest.addEventListener('click',scrollLatest);
els.copyAll.addEventListener('click',()=>copyText(rows.filter(r=>!r.pending).map(r=>`${r.japanese}\t${r.english}`).join('\n')));
els.saveCsv.addEventListener('click',()=>{ const csv=['日本語,English',...rows.filter(r=>!r.pending).map(r=>`${escCsv(r.japanese)},${escCsv(r.english)}`)].join('\r\n'); download(`日英翻訳_${new Date().toISOString().slice(0,10)}.csv`,csv,'text/csv;charset=utf-8'); });
els.clear.addEventListener('click',()=>{ if(!rows.length||confirm('表示中の記録をすべて削除しますか？')){ rows=[]; saveRows(); renderRows(); }});

function renderDict(){
  els.dictBody.innerHTML='';
  dictionary.forEach((d,i)=>{
    const tr=document.createElement('tr');
    const tdR=document.createElement('td'), tdW=document.createElement('td'), tdD=document.createElement('td');
    const r=document.createElement('input'); r.value=d.reading||''; r.placeholder='たかえ'; r.dataset.idx=i; r.dataset.field='reading';
    const w=document.createElement('input'); w.value=d.word||''; w.placeholder='貴恵'; w.dataset.idx=i; w.dataset.field='word';
    const del=document.createElement('button'); del.type='button'; del.className='dictDelete'; del.textContent='削除'; del.onclick=()=>{dictionary.splice(i,1);renderDict();};
    [r,w].forEach(inp=>inp.addEventListener('input',e=>{dictionary[+e.target.dataset.idx][e.target.dataset.field]=e.target.value;}));
    tdR.append(r);tdW.append(w);tdD.append(del);tr.append(tdR,tdW,tdD);els.dictBody.append(tr);
  });
}
els.dictionary.addEventListener('click',()=>{renderDict();els.dictDialog.showModal();});
els.addDict.addEventListener('click',()=>{dictionary.push({reading:'',word:''});renderDict();});
els.saveDict.addEventListener('click',()=>{dictionary=dictionary.filter(d=>d.reading?.trim()||d.word?.trim());saveDict();renderDict();toast('辞書を保存しました');});
els.exportDict.addEventListener('click',()=>{const csv=['よみがな,表記',...dictionary.map(d=>`${escCsv(d.reading)},${escCsv(d.word)}`)].join('\r\n');download('単語辞書.csv',csv,'text/csv;charset=utf-8');});
els.importDict.addEventListener('click',()=>els.dictFile.click());
els.dictFile.addEventListener('change',async e=>{
  const f=e.target.files?.[0]; if(!f)return; const text=await f.text(); const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean); const out=[];
  for(let i=0;i<lines.length;i++){ if(i===0&&/よみがな/.test(lines[i]))continue; const m=lines[i].match(/^\s*"?([^",]*)"?\s*,\s*"?([^"].*?|)"?\s*$/); if(m)out.push({reading:m[1].replaceAll('""','"').trim(),word:m[2].replace(/"$/,'').replaceAll('""','"').trim()}); }
  if(out.length){dictionary=out;saveDict();renderDict();toast(`${out.length}件読み込みました`);} else toast('読み込めるデータがありません'); e.target.value='';
});

window.addEventListener('beforeunload',()=>stop());
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
renderRows();
