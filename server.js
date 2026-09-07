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
   type:'object',additionalProperties:false,required:['type','heading','intro','items','rows','resultLabel','factIds'],
   properties:{type:{type:'string',enum:types},heading:{type:'string'},intro:{type:'string'},items:{type:'array',items:{type:'string'}},rows:{type:'array',items:{type:'array',items:{type:'string'}}},resultLabel:{type:'string'},factIds:{type:'array',items:{type:'string'}}}
  }}
 }
};
function textOf(o){if(o.status&&o.status!=='completed')throw Error('模型未完成生成，请重试。');const c=(o.output||[]).filter(x=>x.type==='message').flatMap(x=>x.content||[]);if(c.some(x=>x.type==='refusal'))throw Error('模型无法处理这条需求。');return c.filter(x=>x.type==='output_text').map(x=>x.text).join('')}
function jsonOf(o,label){try{return JSON.parse(textOf(o))}catch{throw Error(`${label}格式无效，请重试。`)}}
function clean(value,max){let text=String(value||'').replace(/\s+/g,' ').trim();const whole=text.match(/^(.{1,12})\1{2,}$/);if(whole)text=whole[1];text=text.replace(/(.{2,6})\1{3,}/g,'$1');return text.slice(0,max)}
function parsePlan(o){const p=jsonOf(o,'方案'),v=p?.variants,f=p?.sharedFacts;if(!p||typeof p.title!=='string'||typeof p.taskType!=='string'||!Array.isArray(p.constraints)||!p.constraints.every(x=>typeof x==='string')||!Array.isArray(f)||!f.every(x=>x&&typeof x.id==='string'&&typeof x.statement==='string'&&['user','fact','assumption','calculation'].includes(x.kind)&&['provided','verified','unverified'].includes(x.status)&&typeof x.source==='string')||!Array.isArray(v)||v.length!==7||!v.every(x=>x&&['title','audience','focus','outcome'].every(k=>typeof x[k]==='string'&&x[k].trim())&&layouts.includes(x.layout)&&Array.isArray(x.outline)&&x.outline.length>=3&&x.outline.length<=6&&x.outline.every(y=>typeof y==='string')&&Array.isArray(x.components)&&x.components.length&&x.components.every(y=>types.includes(y)))||new Set(v.map(x=>clean(x.title,30))).size!==7||new Set(v.map(x=>clean(x.focus,100))).size!==7)throw Error('七个内容方案不完整或重复，请重试。');p.title=clean(p.title,50);p.taskType=clean(p.taskType,24);p.constraints=p.constraints.slice(0,12).map(x=>clean(x,100));p.sharedFacts=p.sharedFacts.slice(0,20).map(x=>({...x,id:clean(x.id,30),statement:clean(x.statement,160),source:clean(x.source,100)}));p.variants=p.variants.map(x=>({...x,title:clean(x.title,30),audience:clean(x.audience,70),focus:clean(x.focus,100),outcome:clean(x.outcome,80),outline:x.outline.map(y=>clean(y,70))}));return p}
function parsePage(o){const p=jsonOf(o,'页面');if(!p||!['title','subtitle','summary'].every(k=>typeof p[k]==='string')||!Array.isArray(p.sections)||p.sections.length<3||p.sections.length>8||!p.sections.every(s=>s&&types.includes(s.type)&&typeof s.heading==='string'&&typeof s.intro==='string'&&Array.isArray(s.items)&&s.items.every(x=>typeof x==='string')&&Array.isArray(s.rows)&&s.rows.every(r=>Array.isArray(r)&&r.every(x=>typeof x==='string'))&&typeof s.resultLabel==='string'&&Array.isArray(s.factIds)&&s.factIds.every(x=>typeof x==='string')))throw Error('页面配置不完整，请重试。');for(const s of p.sections){s.formula=['sum','product','weightedSum'].includes(s.items[0])?s.items[0]:'none';s.fields=s.type==='calculator'?s.rows.slice(1).map(r=>({label:r[0]||'项目',value:Number(r[1])||0,min:Number(r[2])||0,max:Number(r[3])||100,step:Number(r[4])||1,unit:r[5]||''})):[]}return p}
async function requestModel(input,instructions,schema,parser){const endpoint=isGemini?`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`:'https://api.openai.com/v1/responses';const body=isGemini?{systemInstruction:{parts:[{text:instructions}]},contents:[{role:'user',parts:[{text:input}]}],generationConfig:{responseMimeType:'application/json',responseJsonSchema:schema}}:{model,instructions,input,text:{format:{type:'json_schema',name:'liquid_page',strict:true,schema}}};const r=await fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(90000),headers:isGemini?{'Content-Type':'application/json','x-goog-api-key':apiKey()}:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey()}`},body:JSON.stringify(body)});if(!r.ok){let detail='';try{const data=await r.json();detail=data.error?.message||''}catch{}const m={400:'模型或请求配置不受支持。',401:'API Key 无效。',403:'当前项目没有访问权限。',404:'模型不存在或无法访问。',429:'API 配额不足或请求过于频繁。',503:'模型服务繁忙，请稍后重试。'};const error=Error(m[r.status]||`模型服务暂时不可用（${r.status}）。`);error.detail=detail;console.error('Model API error:',r.status,detail);throw error}const o=await r.json();if(isGemini){const c=o.candidates?.[0];if(c?.finishReason!=='STOP')throw Error('模型未完成生成，请重试。');return parser({output:[{type:'message',content:(c.content?.parts||[]).filter(p=>p.text&&!p.thought).map(p=>({type:'output_text',text:p.text}))}]})}return parser(o)}
const planPrompt='把一次完整 Query 策划为恰好七个可独立完成用户目标的网页方案。七个方案必须有不同决策路径、内容、适合人群和交付结果，不能只是七套视觉风格，也不能把一篇内容切成七章。提取共同硬约束。sharedFacts 是七页共用的事实账本：用户内容标 user/provided，无法联网核实的外部事实标 fact/unverified，假设标 assumption/unverified；不得伪造 verified 或来源。每个事实用稳定短 id。每个方案选择真正有用的组件，至少一个交互组件。方案随 Query 变化。严格限制文字：title 20字、audience 35字、focus 55字、outcome 35字、每条 outline 30字以内。禁止重复字符、重复词语、重复句子和凑字数。用中文，不追问。';
const pagePrompt='生成所选方案的完整独立网页。覆盖 outline，优先使用 components，保留所有用户条件。事实只能来自 sharedFacts，factIds 引用事实 id，不得新增未经标注的外部事实。缺失信息写待核实。不同方案要有不同正文、表格维度和交互。calculator 用 rows 表示输入字段，第一行固定为[名称,初值,最小值,最大值,步长,单位]，后续行填可解析数字；items 第一项填 sum、product 或 weightedSum。comparison/table/barChart 使用 rows 且第一行表头，barChart 第二列为数字。checklist/timeline/steps/cards 用 items。未使用字段返回空数组。用中文。';
const planQuery=q=>requestModel(q,planPrompt,planSchema,parsePlan);
const generatePage=(q,p,v)=>requestModel(JSON.stringify({originalQuery:q,sharedConstraints:p.constraints,sharedFacts:p.sharedFacts,selectedVariant:v,otherVariants:p.variants.map(x=>({title:x.title,focus:x.focus}))}),pagePrompt,pageSchema,parsePage);
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
     if(!session.pages.has(index)){
      const pending=generatePage(session.query,session.plan,session.plan.variants[index]).then(value=>{session.pages.set(index,value);return value}).catch(error=>{session.pages.delete(index);throw error});
      session.pages.set(index,pending)
     }
     return send(res,200,await session.pages.get(index))
    }
    if(typeof payload.query!=='string'||!payload.query.trim())return send(res,400,{error:'Query 不能为空。'});
    const plan=await planQuery(payload.query.trim());return send(res,200,await generatePage(payload.query.trim(),plan,plan.variants[0]))
   }catch(error){return send(res,502,{error:error.name==='TimeoutError'?'生成超时，请重试。':error.message==='fetch failed'?'无法连接模型服务。':error.message})}
  })
 }
 const file=route==='/'?'/index.html':route;
 if(!['GET','HEAD'].includes(req.method)||!['/index.html','/app.js','/styles.css','/evaluation-cases.json'].includes(file)){res.writeHead(404);return res.end('Not found')}
 res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});if(req.method==='HEAD')return res.end();fs.createReadStream(path.join(root,file)).pipe(res)
})}
if(require.main===module)createServer().listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log(`Liquid web: http://localhost:${process.env.PORT||3000}`));
module.exports={createServer,parsePage,parsePlan,allowRequest};
