const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=__dirname;if(fs.existsSync(path.join(root,'.env')))process.loadEnvFile(path.join(root,'.env'));
const model=process.env.GEMINI_MODEL||process.env.OPENAI_MODEL||'gpt-4.1-mini',isGemini=model.startsWith('gemini-');
const apiKey=()=>isGemini?(process.env.GEMINI_API_KEY||process.env.OPENAI_API_KEY):process.env.OPENAI_API_KEY;
const requestLimit=Math.max(1,Number(process.env.REQUESTS_PER_HOUR)||30),rateWindow=60*60*1000,requestLog=new Map();
const layouts=['hand','terminal','magazine','ice','minimal','app','neon'];
const types=['narrative','steps','cards','table','checklist','timeline','comparison','calculator','barChart'];
const factSchema={type:'object',additionalProperties:false,required:['id','statement','kind','status','source'],properties:{id:{type:'string'},statement:{type:'string'},kind:{type:'string',enum:['user','fact','assumption','calculation']},status:{type:'string',enum:['provided','verified','unverified']},source:{type:'string'}}};
const planSchema={
 type:'object',additionalProperties:false,required:['title','taskType','constraints','sharedFacts','variants'],
 properties:{
  title:{type:'string'},taskType:{type:'string'},constraints:{type:'array',items:{type:'string'}},sharedFacts:{type:'array',items:factSchema},
  variants:{type:'array',minItems:7,maxItems:7,items:{
   type:'object',additionalProperties:false,required:['title','audience','focus','outcome','outline','layout','components'],
   properties:{title:{type:'string'},audience:{type:'string'},focus:{type:'string'},outcome:{type:'string'},outline:{type:'array',minItems:3,maxItems:6,items:{type:'string'}},layout:{type:'string',enum:layouts},components:{type:'array',minItems:1,maxItems:4,items:{type:'string',enum:types}}}
  }}
 }
};
const pageSchema={
 type:'object',additionalProperties:false,required:['title','subtitle','summary','sections'],
 properties:{
  title:{type:'string'},subtitle:{type:'string'},summary:{type:'string'},
  sections:{type:'array',minItems:3,maxItems:8,items:{
   type:'object',additionalProperties:false,required:['type','heading','intro','items','rows','resultLabel','factIds','links'],
   properties:{type:{type:'string',enum:types},heading:{type:'string'},intro:{type:'string'},items:{type:'array',items:{type:'string'}},rows:{type:'array',items:{type:'array',items:{type:'string'}}},resultLabel:{type:'string'},factIds:{type:'array',items:{type:'string'}},links:{type:'array',maxItems:9,items:{type:'object',additionalProperties:false,required:['label','query','channel'],properties:{label:{type:'string'},query:{type:'string'},channel:{type:'string',enum:['official','jd','taobao']}}}}}
  }}
 }
};
function textOf(o){if(o.status&&o.status!=='completed')throw Error('模型未完成生成，请重试。');const c=(o.output||[]).filter(x=>x.type==='message').flatMap(x=>x.content||[]);if(c.some(x=>x.type==='refusal'))throw Error('模型无法处理这条需求。');return c.filter(x=>x.type==='output_text').map(x=>x.text).join('')}
function jsonOf(o,label){try{return JSON.parse(textOf(o))}catch{throw Error(`${label}格式无效，请重试。`)}}
function clean(value,max){let text=String(value||'').replace(/\s+/g,' ').trim();const whole=text.match(/^(.{1,12})\1{2,}$/);if(whole)text=whole[1];text=text.replace(/(.{2,6})\1{3,}/g,'$1');return text.slice(0,max)}
function sourceType(title='',url=''){const host=String(url).toLowerCase(),name=String(title).toLowerCase();if(/gov|edu|官方|旗舰店|alpicool|tesla|apple/.test(host+name))return'official';if(/jd\.com|taobao\.com|tmall\.com|amazon/.test(host))return'platform';if(/news|36kr|ithome|thepaper|media/.test(host))return'media';if(/zhihu|xiaohongshu|weibo|reddit|bbs|forum/.test(host))return'community';return'web'}
function evidenceOfGemini(o){const now=new Date().toISOString(),out=[];for(const c of o.candidates||[]){const meta=c.groundingMetadata||{},chunks=meta.groundingChunks||[];for(const s of meta.groundingSupports||[]){const text=s.segment?.text||'';for(const i of s.groundingChunkIndices||[]){const web=chunks[i]?.web||chunks[i]||{},url=web.uri||web.url;if(url)out.push({title:clean(web.title||new URL(url).hostname,80),url,snippet:clean(text,220),sourceType:sourceType(web.title,url),retrievedAt:now})}}}return out.filter((x,i,a)=>a.findIndex(y=>y.url===x.url&&y.snippet===x.snippet)===i).slice(0,20)}
function normalizeEvidence(list=[]){return Array.isArray(list)?list.filter(x=>x&&typeof x.url==='string'&&/^https?:\/\//.test(x.url)).slice(0,6).map(x=>({title:clean(x.title||x.url,80),url:x.url,snippet:clean(x.snippet||'',220),sourceType:clean(x.sourceType||sourceType(x.title,x.url),30),retrievedAt:clean(x.retrievedAt||new Date().toISOString(),40)})) : []}
function attachEvidence(p,evidence=[]){if(!Array.isArray(p?.sharedFacts)||!evidence.length)return p;const pool=normalizeEvidence(evidence);p.sharedFacts=p.sharedFacts.map(f=>{if(f.kind!=='fact')return f;const current=normalizeEvidence(f.evidence);const ev=current.length?current:pool.filter(e=>!e.snippet||e.snippet.includes(f.statement.slice(0,12))||f.statement.includes(e.snippet.slice(0,12))).slice(0,3);const attached=ev.length?ev:pool.slice(0,2);return attached.length?{...f,status:'verified',source:attached[0].title,evidence:attached}:f});return p}
function parsePlan(o){const p=jsonOf(o,'方案'),v=p?.variants,f=p?.sharedFacts;if(!p||typeof p.title!=='string'||typeof p.taskType!=='string'||!Array.isArray(p.constraints)||!p.constraints.every(x=>typeof x==='string')||!Array.isArray(f)||!f.every(x=>x&&typeof x.id==='string'&&typeof x.statement==='string'&&['user','fact','assumption','calculation'].includes(x.kind)&&['provided','verified','unverified'].includes(x.status)&&typeof x.source==='string')||!Array.isArray(v)||v.length!==7||!v.every(x=>x&&['title','audience','focus','outcome'].every(k=>typeof x[k]==='string'&&x[k].trim())&&layouts.includes(x.layout)&&Array.isArray(x.outline)&&x.outline.length>=3&&x.outline.length<=6&&x.outline.every(y=>typeof y==='string')&&Array.isArray(x.components)&&x.components.length&&x.components.every(y=>types.includes(y))))throw Error('七种页面形态不完整，请重试。');p.title=clean(p.title,50);p.taskType=clean(p.taskType,24);p.constraints=p.constraints.slice(0,12).map(x=>clean(x,100));p.sharedFacts=p.sharedFacts.slice(0,20).map(x=>{const ev=normalizeEvidence(x.evidence);const fact={...x,id:clean(x.id,30),statement:clean(x.statement,160),source:clean(x.source,100)};if(ev.length)fact.evidence=ev;return fact});p.variants=p.variants.map((x,i)=>({...x,layout:layouts[i],title:clean(x.title,30),audience:clean(x.audience,70),focus:clean(x.focus,100),outcome:clean(x.outcome,80),outline:x.outline.map(y=>clean(y,70))}));return p}
function parsePage(o){const p=jsonOf(o,'页面');if(!p||!['title','subtitle','summary'].every(k=>typeof p[k]==='string')||!Array.isArray(p.sections)||p.sections.length<3||p.sections.length>8||!p.sections.every(s=>s&&types.includes(s.type)&&typeof s.heading==='string'&&typeof s.intro==='string'&&Array.isArray(s.items)&&s.items.every(x=>typeof x==='string')&&Array.isArray(s.rows)&&s.rows.every(r=>Array.isArray(r)&&r.every(x=>typeof x==='string'))&&typeof s.resultLabel==='string'&&Array.isArray(s.factIds)&&s.factIds.every(x=>typeof x==='string')&&Array.isArray(s.links)&&s.links.every(x=>x&&typeof x.label==='string'&&typeof x.query==='string'&&['official','jd','taobao'].includes(x.channel))))throw Error('页面配置不完整，请重试。');for(const s of p.sections){s.formula=['sum','product'].includes(s.items[0])?s.items[0]:'none';s.fields=s.type==='calculator'?s.rows.slice(1).map(r=>({label:r[0]||'项目',value:Number(r[1])||0,min:Number(r[2])||0,max:Number(r[3])||100,step:Number(r[4])||1,unit:r[5]||''})):[]}return p}
async function requestModel(input,instructions,schema,parser,ground=false){const endpoint=isGemini?`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`:'https://api.openai.com/v1/responses';const base=isGemini?{systemInstruction:{parts:[{text:instructions}]},contents:[{role:'user',parts:[{text:input}]}],generationConfig:{responseMimeType:'application/json',responseJsonSchema:schema}}:{model,instructions,input,text:{format:{type:'json_schema',name:'liquid_page',strict:true,schema}}};const payloads=isGemini&&ground?[{...base,tools:[{googleSearch:{}}]},base]:[base];let r,o,lastDetail='';for(const payload of payloads){for(let attempt=0;attempt<3;attempt++){r=await fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(90000),headers:isGemini?{'Content-Type':'application/json','x-goog-api-key':apiKey()}:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey()}`},body:JSON.stringify(payload)});if(r.ok)break;if(![429,500,502,503,504].includes(r.status)||attempt===2)break;await new Promise(resolve=>setTimeout(resolve,800*2**attempt+Math.random()*300))}if(r.ok){o=await r.json();break}try{const data=await r.json();lastDetail=data.error?.message||''}catch{}if(!(isGemini&&payload.tools&&r.status===400))break}if(!r?.ok){const m={400:'模型或请求配置不受支持。',401:'API Key 无效。',403:'当前项目没有访问权限。',404:'模型不存在或无法访问。',429:'API 配额不足或请求过于频繁。',503:'模型服务繁忙，请稍后重试。'};const error=Error(m[r.status]||`模型服务暂时不可用（${r.status}）。`);error.detail=lastDetail;console.error('Model API error:',r.status,lastDetail);throw error}if(isGemini){const c=o.candidates?.[0];if(c?.finishReason!=='STOP')throw Error('模型未完成生成，请重试。');const wrapped={output:[{type:'message',content:(c.content?.parts||[]).filter(p=>p.text&&!p.thought).map(p=>({type:'output_text',text:p.text}))}]};return attachEvidence(parser(wrapped),evidenceOfGemini(o))}return parser(o)}
const planPrompt='理解用户真正要完成的任务，提取全部硬约束，并规划恰好七种呈现同一份最终答案的网页形态。七种形态依次对应 hand、terminal、magazine、ice、minimal、app、neon；它们只改变叙事顺序、视觉重点与交互方式，不得改变事实、计算、候选项或最终结论。sharedFacts 是统一事实账本：用户内容标 user/provided，无法核实的外部信息标 fact/unverified，假设标 assumption/unverified，计算标 calculation/provided；只有能由搜索引用元数据支撑的外部事实才允许最终升级为 verified；不得伪造来源、价格、库存、参数或商品详情 URL。每个形态给出适合的阅读场景、重点、相同交付目标、3至6节统一内容大纲与有效组件。严格限制文字，中文，不追问。';
const pagePrompt='生成一份真正完成用户任务的统一内容结果，之后会被七种界面共同渲染。必须保留全部约束，先给关键判断，再展示思考路径、可比较的信息、可执行步骤与最终选择。若任务涉及购买、品牌或服务选择：至少列出3个不同品牌或候选项，分别写清适用人群、关键区别、风险和待核实参数；在相关section的links中为每个候选项给出搜索入口，label写候选名称，query写完整品牌型号关键词，channel在official、jd、taobao中选择，至少同时覆盖京东和淘宝。系统会安全生成站内搜索链接，不得编造商品详情URL。非购买任务的links返回空数组。所有外部事实必须来自sharedFacts；无法核实的参数或价格明确写待核实，不得伪造来源或精确数据。内容要具体。calculator用rows表示输入字段，第一行固定为[名称,初值,最小值,最大值,步长,单位]；items第一项只用sum或product。comparison/table/barChart使用rows且第一行表头，barChart第二列为数字。checklist/timeline/steps/cards用items。未使用字段返回空数组。用中文。';
const planQuery=q=>requestModel(q,planPrompt,planSchema,parsePlan,isGemini);
const generatePage=(q,p)=>requestModel(JSON.stringify({originalQuery:q,sharedConstraints:p.constraints,sharedFacts:p.sharedFacts,contentOutline:p.variants[0].outline,suggestedComponents:[...new Set(p.variants.flatMap(x=>x.components))]}),pagePrompt,pageSchema,parsePage);
const sessions=new Map(),ttl=2*60*60*1000;function prune(){for(const[id,s]of sessions)if(Date.now()-s.created>ttl)sessions.delete(id);while(sessions.size>=100)sessions.delete(sessions.keys().next().value)}
function clientIp(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim()}
function allowRequest(req,now=Date.now()){const ip=clientIp(req),recent=(requestLog.get(ip)||[]).filter(time=>now-time<rateWindow);if(recent.length>=requestLimit){requestLog.set(ip,recent);return false}recent.push(now);requestLog.set(ip,recent);if(requestLog.size>10000)for(const[key,times]of requestLog)if(!times.some(time=>now-time<rateWindow))requestLog.delete(key);return true}
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data))};
function body(req,res,cb){let b='',done=false;req.on('data',c=>{if(done)return;b+=c;if(Buffer.byteLength(b)>32768){done=true;send(res,413,{error:'输入内容过长。'})}});req.on('end',()=>{if(!done)cb(b)})}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
function createServer(){return http.createServer((req,res)=>{
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
 const route=req.url.split('?')[0];
 if(req.method==='GET'&&route==='/api/health')return send(res,200,{ready:Boolean(apiKey()&&apiKey()!=='your_api_key_here'),model,provider:isGemini?'Gemini':'OpenAI'});
 if(req.method==='GET'&&route.startsWith('/api/session/')){
  const id=decodeURIComponent(route.slice(13)),session=sessions.get(id);
  if(!session||Date.now()-session.created>ttl)return send(res,410,{error:'方案已过期，请重新提交 Query。'});
  return send(res,200,{sessionId:id,query:session.query,...session.plan,pages:Object.fromEntries([...session.pages].filter(([,value])=>!(value instanceof Promise)))})
 }
 if(req.method==='POST'&&['/api/generate','/api/plan','/api/page'].includes(route)){
  if(!allowRequest(req)){res.setHeader('Retry-After','3600');return send(res,429,{error:'请求过于频繁，请稍后再试。'})}
  return body(req,res,async raw=>{
   let payload;try{payload=JSON.parse(raw)}catch{return send(res,400,{error:'请求格式无效。'})}
   if(!apiKey()||apiKey()==='your_api_key_here')return send(res,502,{error:'请在 .env 配置模型 API Key。'});
   try{
    if(route==='/api/plan'){
     if(typeof payload.query!=='string'||!payload.query.trim()||payload.query.length>6000)return send(res,400,{error:'Query 必须是 1–6000 字符。'});
     const plan=await planQuery(payload.query.trim());prune();const id=crypto.randomUUID();
     sessions.set(id,{query:payload.query.trim(),plan,pages:new Map(),created:Date.now()});
     return send(res,200,{sessionId:id,...plan})
    }
    if(route==='/api/page'){
     if(typeof payload.sessionId!=='string'||!Number.isInteger(payload.variantIndex)||payload.variantIndex<0||payload.variantIndex>6)return send(res,400,{error:'方案参数无效。'});
     const session=sessions.get(payload.sessionId);
     if(!session||Date.now()-session.created>ttl)return send(res,410,{error:'方案已过期，请重新提交 Query。'});
     const index=payload.variantIndex;
     if(!session.canonicalPage)session.canonicalPage=generatePage(session.query,session.plan).then(value=>{for(let i=0;i<7;i++)session.pages.set(i,value);return value}).catch(error=>{delete session.canonicalPage;throw error});
     return send(res,200,await session.canonicalPage)
    }
    if(typeof payload.query!=='string'||!payload.query.trim())return send(res,400,{error:'Query 不能为空。'});
    const plan=await planQuery(payload.query.trim());return send(res,200,await generatePage(payload.query.trim(),plan))
   }catch(error){return send(res,502,{error:error.name==='TimeoutError'?'生成超时，请重试。':error.message==='fetch failed'?'无法连接模型服务。':error.message})}
  })
 }
 const file=route==='/'?'/index.html':route;
 if(!['GET','HEAD'].includes(req.method)||!['/index.html','/app.js','/styles.css','/product-links.css','/loading.css','/evidence.css','/evaluation-cases.json'].includes(file)){res.writeHead(404);return res.end('Not found')}
 res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});if(req.method==='HEAD')return res.end();fs.createReadStream(path.join(root,file)).pipe(res)
})}
if(require.main===module)createServer().listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log(`Liquid web: http://localhost:${process.env.PORT||3000}`));
module.exports={createServer,parsePage,parsePlan,allowRequest};
