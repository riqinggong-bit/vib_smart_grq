const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),dns=require('dns').promises,net=require('net');
const root=__dirname;if(fs.existsSync(path.join(root,'.env')))process.loadEnvFile(path.join(root,'.env'));
const model=process.env.GEMINI_MODEL||process.env.OPENAI_MODEL||'gpt-4.1-mini',isGemini=model.startsWith('gemini-');
const apiKey=()=>isGemini?(process.env.GEMINI_API_KEY||process.env.OPENAI_API_KEY):process.env.OPENAI_API_KEY;
const geminiBase=(process.env.GEMINI_BASE_URL||'https://generativelanguage.googleapis.com').replace(/\/+$/,'');
const geminiGrounding=process.env.GEMINI_ENABLE_GROUNDING==='true'||(!process.env.GEMINI_BASE_URL&&process.env.GEMINI_ENABLE_GROUNDING!=='false');
const isCloseAI=isGemini&&/openai-proxy\.org/.test(geminiBase);
const closeAIBase=(process.env.CLOSEAI_BASE_URL||'https://api.openai-proxy.org/v1').replace(/\/+$/,'');
const requestLimit=Math.max(1,Number(process.env.REQUESTS_PER_HOUR)||30),rateWindow=60*60*1000,requestLog=new Map();

// Product-image search is intentionally separated from the main page-generation model.
// It uses the official Gemini Interactions API because Google Image Search grounding
// is currently exposed there for gemini-3.1-flash-image.
const geminiImageSearchModel=process.env.GEMINI_IMAGE_SEARCH_MODEL||'gemini-3.1-flash-image';
const groundedImageCache=new Map();
const groundedImageTtl=6*60*60*1000;

const layouts=['hand','terminal','magazine','ice','minimal','app','neon'];
const types=['narrative','steps','cards','table','checklist','timeline','comparison','calculator','barChart','image','image_gallery','product_image'];

const factSchema={
 type:'object',
 additionalProperties:false,
 required:['id','statement','kind','status','source'],
 properties:{
  id:{type:'string'},
  statement:{type:'string'},
  kind:{type:'string',enum:['user','fact','assumption','calculation']},
  status:{type:'string',enum:['provided','verified','unverified']},
  source:{type:'string'}
	 }
};

const planSchema={
 type:'object',
 additionalProperties:false,
 required:['title','taskType','constraints','sharedFacts','variants'],
 properties:{
  title:{type:'string'},
  taskType:{type:'string'},
  constraints:{type:'array',items:{type:'string'}},
  sharedFacts:{type:'array',items:factSchema},
  variants:{
   type:'array',
   minItems:7,
   maxItems:7,
   items:{
    type:'object',
    additionalProperties:false,
    required:[
     'title',
     'audience',
     'focus',
     'outcome',
     'outline',
     'layout',
     'components'
    ],
    properties:{
     title:{type:'string'},
     audience:{type:'string'},
     focus:{type:'string'},
     outcome:{type:'string'},
     outline:{
      type:'array',
      minItems:3,
      maxItems:6,
      items:{type:'string'}
     },
     layout:{
      type:'string',
      enum:layouts
     },
     components:{
      type:'array',
      minItems:1,
      maxItems:4,
      items:{
       type:'string',
       enum:types
      }
     }
    }
   }
	 }
		}
	};

const pageSchema={
 type:'object',
 additionalProperties:false,
 required:['title','subtitle','summary','sections'],
 properties:{
  title:{type:'string'},
  subtitle:{type:'string'},
  summary:{type:'string'},
  sections:{
   type:'array',
   minItems:3,
   maxItems:8,
   items:{
    type:'object',
    additionalProperties:false,
    required:[
     'type',
     'heading',
     'intro',
     'items',
     'rows',
     'resultLabel',
     'factIds',
     'links',
     'media'
    ],
    properties:{
     type:{
      type:'string',
      enum:types
     },
     heading:{type:'string'},
     intro:{type:'string'},
     items:{
      type:'array',
      items:{type:'string'}
     },
     rows:{
      type:'array',
      items:{
       type:'array',
       items:{type:'string'}
      }
     },
     resultLabel:{type:'string'},
     factIds:{
      type:'array',
      items:{type:'string'}
     },
     links:{
      type:'array',
      maxItems:9,
      items:{
       type:'object',
       additionalProperties:false,
       required:['label','query','channel'],
       properties:{
        label:{type:'string'},
        query:{type:'string'},
        channel:{
         type:'string',
         enum:['official','jd','taobao']
        }
       }
      }
     },
     media:{
      type:'array',
      maxItems:12,
      items:{
       type:'object',
       additionalProperties:false,
       required:[
        'url',
        'title',
        'caption',
        'source',
        'sourceUrl',
        'entity',
        'factIds'
       ],
       properties:{
        url:{type:'string'},
        title:{type:'string'},
        caption:{type:'string'},
        source:{type:'string'},
        sourceUrl:{type:'string'},
        entity:{type:'string'},
        factIds:{
         type:'array',
         items:{type:'string'}
        }
       }
     }
    }
   }
  }
 }
}
};

function textOf(o){
 if(o.status&&o.status!=='completed'){
  throw Error('模型未完成生成，请重试。');
 }

 const c=(o.output||[])
  .filter(x=>x.type==='message')
  .flatMap(x=>x.content||[]);

 if(c.some(x=>x.type==='refusal')){
  throw Error('模型无法处理这条需求。');
 }

 return c
  .filter(x=>x.type==='output_text')
  .map(x=>x.text)
  .join('');
}

function jsonOf(o,label){
 try{
  return JSON.parse(textOf(o));
 }catch{
  throw Error(`${label}格式无效，请重试。`);
 }
}

function clean(value,max){
 let text=String(value||'')
  .replace(/\s+/g,' ')
  .trim();

 const whole=text.match(/^(.{1,12})\1{2,}$/);

 if(whole){
  text=whole[1];
 }

 text=text.replace(/(.{2,6})\1{3,}/g,'$1');

 return text.slice(0,max);
}

function sourceType(title='',url=''){
 const host=String(url).toLowerCase();
 const name=String(title).toLowerCase();

 if(/gov|edu|官方|旗舰店|alpicool|tesla|apple/.test(host+name)){
  return'official';
 }

 if(/jd\.com|taobao\.com|tmall\.com|amazon/.test(host)){
  return'platform';
 }

 if(/news|36kr|ithome|thepaper|media/.test(host)){
  return'media';
 }

 if(/zhihu|xiaohongshu|weibo|reddit|bbs|forum/.test(host)){
  return'community';
 }

 return'web';
}

function evidenceOfGemini(o){
 const now=new Date().toISOString();
 const out=[];

 for(const c of o.candidates||[]){
  const meta=c.groundingMetadata||{};
  const chunks=meta.groundingChunks||[];

  for(const s of meta.groundingSupports||[]){
   const text=s.segment?.text||'';

   for(const i of s.groundingChunkIndices||[]){
    const web=chunks[i]?.web||chunks[i]||{};
    const url=web.uri||web.url;

    if(url){
     out.push({
      title:clean(
       web.title||new URL(url).hostname,
       80
      ),
      url,
      snippet:clean(text,220),
      sourceType:sourceType(
       web.title,
       url
      ),
      retrievedAt:now
     });
    }
   }
  }
 }

 return out
  .filter((x,i,a)=>
   a.findIndex(y=>
    y.url===x.url&&
    y.snippet===x.snippet
   )===i
  )
  .slice(0,20);
}

function normalizeEvidence(list=[]){
 return Array.isArray(list)
  ? list
   .filter(x=>
    x&&
    typeof x.url==='string'&&
    /^https?:\/\//.test(x.url)
   )
   .slice(0,6)
   .map(x=>({
    title:clean(
     x.title||x.url,
     80
    ),
    url:x.url,
    snippet:clean(
     x.snippet||'',
     220
    ),
    sourceType:clean(
     x.sourceType||
     sourceType(
      x.title,
      x.url
     ),
     30
    ),
    retrievedAt:clean(
     x.retrievedAt||
     new Date().toISOString(),
     40
    )
   }))
  : [];
}

function attachEvidence(p,evidence=[]){
 if(
  !Array.isArray(p?.sharedFacts)||
  !evidence.length
 ){
  return p;
 }

 const pool=normalizeEvidence(evidence);

 p.sharedFacts=p.sharedFacts.map(f=>{
  if(f.kind!=='fact'){
   return f;
  }

  const current=
   normalizeEvidence(f.evidence);

  const ev=current.length
   ? current
   : pool.filter(e=>
      !e.snippet||
      e.snippet.includes(
       f.statement.slice(0,12)
      )||
      f.statement.includes(
       e.snippet.slice(0,12)
      )
     ).slice(0,3);

  const attached=ev;

  return attached.length
   ? {
      ...f,
      status:'verified',
      source:attached[0].title,
      evidence:attached
     }
   : f;
 });

 return p;
}

function imageParts(images=[]){
 return Array.isArray(images)
  ? images
   .filter(x=>
    x&&
    typeof x.mimeType==='string'&&
    /^image\/(png|jpe?g|webp|gif)$/i
     .test(x.mimeType)&&
    typeof x.data==='string'&&
    /^[A-Za-z0-9+/=]+$/.test(x.data)&&
    x.data.length<1400000
   )
   .slice(0,4)
  : [];
}

function normalizeMedia(
 list=[],
 keepUnresolved=false
){
 return Array.isArray(list)
  ? list
   .filter(x=>{
    if(!x){
     return false;
    }

    const url=
     typeof x.url==='string'
      ? x.url.trim()
      : '';

    const sourceUrl=
     typeof x.sourceUrl==='string'
      ? x.sourceUrl.trim()
      : '';

    const entity=
     clean(
      x.entity||x.title||'',
      80
     );

    return /^https?:\/\//.test(url)||
     (
      keepUnresolved&&
      entity&&
      (!url||/^https?:\/\//.test(url))&&
      (!sourceUrl||/^https?:\/\//.test(sourceUrl))
     );
   })
   .slice(0,12)
   .map(x=>({
    url:/^https?:\/\//.test(x.url||'')
     ? x.url.trim()
     : '',
    title:clean(
     x.title||x.entity||'参考图片',
     80
    ),
    caption:clean(x.caption||'',160),
    source:clean(x.source||'',80),
    sourceUrl:/^https?:\/\//.test(x.sourceUrl||'')
     ? x.sourceUrl.trim()
     : '',
    entity:clean(x.entity||x.title||'',80),
    factIds:Array.isArray(x.factIds)
     ? x.factIds
      .filter(y=>typeof y==='string')
      .slice(0,8)
     : []
   }))
  : [];
}

function privateAddress(address=''){
 const ip=String(address).toLowerCase();
 const version=net.isIP(ip);

 if(version===4){
  const p=ip.split('.').map(Number);

  return p[0]===10||
   p[0]===127||
   p[0]===0||
   (p[0]===169&&p[1]===254)||
   (p[0]===172&&p[1]>=16&&p[1]<=31)||
   (p[0]===192&&p[1]===168)||
   (p[0]===100&&p[1]>=64&&p[1]<=127)||
   p[0]>=224;
 }

 if(version===6){
  return ip==='::1'||
   ip==='::'||
   ip.startsWith('fc')||
   ip.startsWith('fd')||
   ip.startsWith('fe80:')||
   ip.startsWith('::ffff:127.')||
   ip.startsWith('::ffff:10.')||
   ip.startsWith('::ffff:192.168.');
 }

 return false;
}

async function safeRemoteUrl(raw){
 try{
  const u=new URL(raw);

  if(!['http:','https:'].includes(u.protocol)){
   return false;
  }

  const host=u.hostname.toLowerCase();

  if(
   host==='localhost'||
   host.endsWith('.localhost')||
   host.endsWith('.local')||
   host.endsWith('.internal')
  ){
   return false;
  }

  if(net.isIP(host)&&privateAddress(host)){
   return false;
  }

  const addresses=await dns.lookup(host,{all:true});

  return addresses.length>0&&
   addresses.every(x=>!privateAddress(x.address));
 }catch{
  return false;
 }
}

async function fetchRemote(
 raw,
 options={},
 redirectCount=0
){
 if(redirectCount>3||!await safeRemoteUrl(raw)){
  return null;
 }

 let response;

 try{
  response=await fetch(
   raw,
   {
    ...options,
    redirect:'manual',
    signal:AbortSignal.timeout(10000),
    headers:{
     'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145 Safari/537.36',
     'Accept-Language':'zh-CN,zh;q=0.9,en;q=0.8',
     ...(options.headers||{})
    }
   }
  );
 }catch{
  return null;
 }

 if([301,302,303,307,308].includes(response.status)){
  const location=response.headers.get('location');

  if(!location){
   return null;
  }

  let next;

  try{
   next=new URL(location,raw).href;
  }catch{
   return null;
  }

  try{
   await response.body?.cancel();
  }catch{}

  return fetchRemote(next,options,redirectCount+1);
 }

 return response;
}

async function limitedText(response,maxBytes=1500000){
 if(!response?.body){
  return '';
 }

 const reader=response.body.getReader();
 const decoder=new TextDecoder();
 let total=0;
 let text='';

 while(true){
  const{done,value}=await reader.read();

  if(done){
   break;
  }

  total+=value.byteLength;

  if(total>maxBytes){
   try{await reader.cancel();}catch{}
   break;
  }

  text+=decoder.decode(value,{stream:true});
 }

 text+=decoder.decode();
 return text;
}

async function limitedBuffer(response,maxBytes=6*1024*1024){
 if(!response?.body){
  return null;
 }

 const reader=response.body.getReader();
 const chunks=[];
 let total=0;

 while(true){
  const{done,value}=await reader.read();

  if(done){
   break;
  }

  total+=value.byteLength;

  if(total>maxBytes){
   try{await reader.cancel();}catch{}
   return null;
  }

  chunks.push(Buffer.from(value));
 }

 return Buffer.concat(chunks,total);
}

function decodeHtml(value=''){
 return String(value)
  .replace(/&amp;/gi,'&')
  .replace(/&quot;/gi,'"')
  .replace(/&#39;|&apos;/gi,"'")
  .replace(/&lt;/gi,'<')
  .replace(/&gt;/gi,'>')
  .replace(/&#x2F;/gi,'/')
  .trim();
}

function stripTags(value=''){
 return decodeHtml(
  String(value)
   .replace(/<script[\s\S]*?<\/script>/gi,' ')
   .replace(/<style[\s\S]*?<\/style>/gi,' ')
   .replace(/<[^>]+>/g,' ')
   .replace(/\s+/g,' ')
 );
}

function metaContent(html,key){
 const escaped=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const patterns=[
  new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,'i'),
  new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,'i')
 ];

 for(const pattern of patterns){
  const match=html.match(pattern);
  if(match?.[1]){
   return decodeHtml(match[1]);
  }
 }

 return '';
}

function absoluteImageUrl(raw,pageUrl){
 const value=decodeHtml(String(raw||'').trim());
 if(!value||/^data:/i.test(value)) return '';
 try{return new URL(value,pageUrl).href;}catch{return '';}
}

function imageValueList(value){
 if(Array.isArray(value)) return value.flatMap(imageValueList);
 if(value&&typeof value==='object'){
  return imageValueList(value.url||value.contentUrl||value.thumbnailUrl||'');
 }
 return typeof value==='string'&&value.trim()?[value.trim()]:[];
}

function jsonLdProductImages(html,pageUrl,entity){
 const out=[];
 const re=/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
 let m;
 const visit=node=>{
  if(Array.isArray(node)){node.forEach(visit);return;}
  if(!node||typeof node!=='object')return;
  const types=Array.isArray(node['@type'])?node['@type']:[node['@type']];
  const isProduct=types.some(x=>String(x||'').toLowerCase()==='product');
  if(isProduct){
   const identity=`${node.name||''} ${node.model||''} ${node.sku||''} ${node.mpn||''} ${node.brand?.name||node.brand||''}`;
   const match=productMatchScore(identity,entity);
   if(match.score>=55){
    for(const raw of imageValueList(node.image)){
     const url=absoluteImageUrl(raw,pageUrl);
     if(url)out.push({url,score:140+Math.min(30,match.score),source:'jsonld-product'});
    }
   }
  }
  for(const value of Object.values(node)){
   if(value&&typeof value==='object')visit(value);
  }
 };
 while((m=re.exec(html))){
  try{visit(JSON.parse(decodeHtml(m[1])));}catch{}
 }
 return out;
}

function itempropImageCandidates(html,pageUrl){
 const out=[];
 const patterns=[
  /<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
  /<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["']image["'][^>]*>/gi,
  /<link[^>]+itemprop=["']image["'][^>]+href=["']([^"']+)["'][^>]*>/gi
 ];
 for(const re of patterns){
  let m;
  while((m=re.exec(html))&&out.length<6){
   const url=absoluteImageUrl(m[1],pageUrl);
   if(url)out.push({url,score:105,source:'itemprop-image'});
  }
 }
 return out;
}

function imgTagCandidates(html,pageUrl,entity){
 const out=[];
 const re=/<img\b[^>]*>/gi;
 let m;
 while((m=re.exec(html))&&out.length<20){
  const tag=m[0];
  const attr=name=>{
   const r=new RegExp(`${name}=["']([^"']+)["']`,'i');
   return (tag.match(r)||[])[1]||'';
  };
  const identity=`${attr('alt')} ${attr('title')} ${attr('aria-label')}`;
  const match=productMatchScore(identity,entity);
  if(match.score<45)continue;
  let raw=attr('data-src')||attr('data-original')||attr('data-lazy-src')||attr('src');
  if(!raw){
   const srcset=attr('srcset')||attr('data-srcset');
   if(srcset)raw=srcset.split(',').pop().trim().split(/\s+/)[0];
  }
  const url=absoluteImageUrl(raw,pageUrl);
  if(url)out.push({url,score:100+Math.min(35,match.score),source:'img-semantic'});
 }
 return out;
}

function pageImageCandidates(html,pageUrl,entity=''){
 const out=[];
 if(entity){
  out.push(...jsonLdProductImages(html,pageUrl,entity));
  out.push(...imgTagCandidates(html,pageUrl,entity));
 }
 out.push(...itempropImageCandidates(html,pageUrl));
 const metas=[
  [metaContent(html,'og:image:secure_url'),95,'og:image:secure_url'],
  [metaContent(html,'og:image'),92,'og:image'],
  [metaContent(html,'twitter:image'),88,'twitter:image'],
  [metaContent(html,'twitter:image:src'),86,'twitter:image:src']
 ];
 for(const [raw,score,source] of metas){
  const url=absoluteImageUrl(raw,pageUrl);
  if(url)out.push({url,score,source});
 }
 const linkMatch=html.match(/<link[^>]+rel=["'](?:image_src|preload)["'][^>]+href=["']([^"']+)["'][^>]*>/i);
 if(linkMatch?.[1]){
  const url=absoluteImageUrl(linkMatch[1],pageUrl);
  if(url)out.push({url,score:75,source:'link-image'});
 }
 return out
  .filter(x=>x.url)
  .filter((x,i,a)=>a.findIndex(y=>y.url===x.url)===i)
  .sort((a,b)=>b.score-a.score)
  .slice(0,16);
}

async function verifiedImageUrl(raw){
 if(typeof raw!=='string'||!/^https?:\/\//.test(raw)){
  return '';
 }

 const candidates=[];

 try{
  const u=new URL(raw);

  if(u.protocol==='http:'){
   const secure=new URL(raw);
   secure.protocol='https:';
   candidates.push(secure.href);
  }

  candidates.push(u.href);
 }catch{
  return '';
 }

 for(const candidate of candidates){
  const response=await fetchRemote(
   candidate,
   {
    method:'GET',
    headers:{
     Range:'bytes=0-4095',
     Accept:'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
    }
   }
  );

  if(!response){
   continue;
  }

  const type=String(response.headers.get('content-type')||'').toLowerCase();

  if((response.ok||response.status===206)&&type.startsWith('image/')){
   const finalUrl=response.url||candidate;
   try{await response.body?.cancel();}catch{}
   return finalUrl;
  }

  try{await response.body?.cancel();}catch{}
 }

 return '';
}

async function productImageFromPage(sourceUrl){
 if(!/^https?:\/\//.test(sourceUrl||'')){
  return '';
 }

 const response=await fetchRemote(
  sourceUrl,
  {
   method:'GET',
   headers:{
    Accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
   }
  }
 );

 if(!response||!response.ok){
  return '';
 }

 const type=String(response.headers.get('content-type')||'').toLowerCase();

 if(!type.includes('text/html')&&!type.includes('application/xhtml+xml')){
  try{await response.body?.cancel();}catch{}
  return '';
 }

 const html=await limitedText(response);

 for(const candidate of pageImageCandidates(html,response.url||sourceUrl)){
  const verified=await verifiedImageUrl(candidate);
  if(verified){
   return verified;
  }
 }

 return '';
}

function compactText(value=''){
 return String(value)
  .toLowerCase()
  .replace(/[\s\-_·•（）()【】\[\]《》<>，,。.!！?？:：/\\]+/g,'');
}

function entityMatch(text='',entity=''){
 const a=compactText(text);
 const b=compactText(entity);

 if(!a||!b){
  return false;
 }

 if(a.includes(b)||b.includes(a)){
  return true;
 }

 const tokens=String(entity)
  .toLowerCase()
  .match(/[a-z]+\d*[a-z\d-]*|\d+[a-z]*|[\u4e00-\u9fff]{2,}/g)||[];

 const useful=tokens
  .map(compactText)
  .filter(x=>x.length>=2);

 return useful.length>=2&&
  useful.filter(x=>a.includes(x)).length>=Math.min(2,useful.length);
}

function brandAliasGroups(){
 return [
  ['小米','米家','xiaomi','mijia'],
  ['霍尼韦尔','honeywell'],
  ['352'],
  ['戴森','dyson'],
  ['飞利浦','philips'],
  ['松下','panasonic'],
  ['夏普','sharp'],
  ['美的','midea'],
  ['格力','gree'],
  ['海尔','haier'],
  ['华为','huawei'],
  ['荣耀','honor'],
  ['苹果','apple'],
  ['索尼','sony'],
  ['博士','bose'],
  ['三星','samsung'],
  ['特斯拉','tesla'],
  ['比亚迪','byd'],
  ['小鹏','xpeng'],
  ['理想','li auto','lixiang'],
  ['蔚来','nio'],
  ['蓝空气','blueair'],
  ['科沃斯','ecovacs'],
  ['石头','roborock'],
  ['添可','tineco'],
  ['iam'],
  ['智米','smartmi'],
  ['levoit']
 ];
}

function productCategoryGroups(){
 return [
  ['空气净化器','净化器','airpurifier'],
  ['车载冰箱','车冰箱','便携冰箱'],
  ['冰箱','冰柜','冷柜'],
  ['耳机','耳麦','headphone','headset','earbuds'],
  ['手机','智能手机','phone','smartphone'],
  ['电脑','笔记本','笔记本电脑','laptop','notebook'],
  ['电视','电视机','tv'],
  ['空调','空调机'],
  ['相机','摄像机','camera'],
  ['扫地机器人','扫地机','机器人吸尘器'],
  ['洗衣机'],
  ['烘干机','干衣机'],
  ['咖啡机'],
  ['路由器','router'],
  ['投影仪','投影机','projector'],
  ['汽车','轿车','suv','纯电轿车','新能源车','电动车']
 ];
}

function matchedAliasGroup(text,groups){
 const hay=compactText(text);
 return groups.find(group=>
  group.some(alias=>{
   const a=compactText(alias);
   return a&&hay.includes(a);
  })
 )||[];
}

function removeAliasGroups(text,groups){
 let out=compactText(text);
 for(const group of groups){
  for(const alias of group){
   const a=compactText(alias);
   if(a)out=out.split(a).join('');
  }
 }
 return out;
}

function productIdentity(entity=''){
 const raw=String(entity||'').toLowerCase();
 const compact=compactText(raw);
 const brandGroup=matchedAliasGroup(raw,brandAliasGroups());
 const categoryGroup=matchedAliasGroup(raw,productCategoryGroups());
 const asciiParts=(raw.match(/[a-z0-9]+(?:-[a-z0-9]+)*/g)||[])
  .map(compactText)
  .filter(Boolean);
 const genericAscii=new Set([
  'pro','max','mini','plus','air','pet','new','ultra','lite','smart',
  'the','with','for','and','home','official','旗舰','官方'
 ]);
 const strongCodes=asciiParts
  .filter(x=>x.length>=4&&/[0-9]/.test(x))
  .sort((a,b)=>b.length-a.length);
 let stripped=compact;
 for(const alias of brandGroup){
  const a=compactText(alias);
  if(a)stripped=stripped.split(a).join('');
 }
 for(const alias of categoryGroup){
  const a=compactText(alias);
  if(a)stripped=stripped.split(a).join('');
 }
 stripped=stripped
  .replace(/官方旗舰店|官方旗舰|旗舰店|官方|旗舰|家用|宠物|除甲醛|除菌|智能|新款|升级版/g,'');
 const modelParts=asciiParts
  .filter(x=>x.length>=2&&!genericAscii.has(x));
 const modelKey=(/[0-9]/.test(stripped)&&stripped.length>=3)
  ? stripped
  : (strongCodes[0]||'');
 return{
  raw,
  compact,
  brandGroup,
  categoryGroup,
  asciiParts,
  strongCodes,
  modelParts,
  modelKey
 };
}

function productMatchScore(text='',entity=''){
 const hay=compactText(text);
 const id=productIdentity(entity);
 let score=0;
 const reasons=[];
 if(!hay||!id.compact)return{score:0,reasons};

 if(id.compact.length>=5&&hay.includes(id.compact)){
  score+=95;
  reasons.push('exact-entity');
 }

 let modelScore=0;
 if(id.modelKey&&id.modelKey.length>=3&&hay.includes(id.modelKey)){
  modelScore=Math.max(modelScore,60);
  reasons.push(`model-key:${id.modelKey}`);
 }

 const codeHit=id.strongCodes.find(code=>hay.includes(code));
 if(codeHit){
  modelScore=Math.max(modelScore,65);
  reasons.push(`model-code:${codeHit}`);
 }

 if(modelScore<45){
  const hits=id.modelParts.filter(x=>x.length>=2&&hay.includes(x));
  if(hits.length>=2){
   modelScore=45;
   reasons.push(`model-parts:${hits.join(',')}`);
  }else if(hits.length===1&&hits[0].length>=4){
   modelScore=35;
   reasons.push(`model-part:${hits[0]}`);
  }
 }

 score+=modelScore;

 if(id.brandGroup.length){
  const hit=id.brandGroup.find(alias=>hay.includes(compactText(alias)));
  if(hit){
   score+=20;
   reasons.push(`brand:${hit}`);
  }
 }

 if(id.categoryGroup.length){
  const hit=id.categoryGroup.find(alias=>hay.includes(compactText(alias)));
  if(hit){
   score+=15;
   reasons.push(`category:${hit}`);
  }
 }

 return{score,reasons};
}

function strictEntityMatch(text='',entity=''){
 return productMatchScore(text,entity).score>=55;
}

function pageIdentityText(html=''){
 const title=stripTags(
  (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||''
 );
 const ogTitle=metaContent(html,'og:title');
 const description=
  metaContent(html,'description')||
  metaContent(html,'og:description');
 const h1=stripTags(
  (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)||[])[1]||''
 );
 const productNames=[];
 const re=/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
 let m;
 const visit=node=>{
  if(Array.isArray(node)){node.forEach(visit);return;}
  if(!node||typeof node!=='object')return;
  const types=Array.isArray(node['@type'])?node['@type']:[node['@type']];
  if(types.some(x=>String(x||'').toLowerCase()==='product')){
   productNames.push(
    `${node.name||''} ${node.model||''} ${node.sku||''} ${node.mpn||''} ${node.brand?.name||node.brand||''}`
   );
  }
  for(const value of Object.values(node)){
   if(value&&typeof value==='object')visit(value);
  }
 };
 while((m=re.exec(html))){
  try{visit(JSON.parse(decodeHtml(m[1])));}catch{}
 }
 return clean(
  `${title} ${ogTitle} ${description} ${h1} ${productNames.join(' ')}`,
  2600
 );
}

function plausibleProductImageUrl(raw=''){
 try{
  const u=new URL(raw);
  const text=`${u.hostname}${u.pathname}`.toLowerCase();
  return !/(?:favicon|sprite|avatar|qrcode|qr-code|wechat|logo(?:[._/-]|$)|icon(?:[._/-]|$)|header(?:[._/-]|$)|footer(?:[._/-]|$)|banner(?:[._/-]|$))/i.test(text);
 }catch{
  return false;
 }
}

function isMarketplaceDetailUrl(raw=''){
 try{
  const u=new URL(raw);
  const host=u.hostname.toLowerCase().replace(/^www\./,'');
  const path=u.pathname.toLowerCase();
  if(host==='item.jd.com'){
   return /^\/\d+\.html$/.test(path)||/^\/product\//.test(path);
  }
  if(host==='item.taobao.com'){
   return path==='/item.htm'&&Boolean(u.searchParams.get('id'));
  }
  if(host==='detail.tmall.com'){
   return path==='/item.htm'&&Boolean(u.searchParams.get('id'));
  }
  return false;
 }catch{
  return false;
 }
}

function marketplaceLabel(raw=''){
 try{
  const host=new URL(raw).hostname.toLowerCase();
  if(host.includes('jd.com'))return'京东';
  if(host.includes('taobao.com'))return'淘宝';
  if(host.includes('tmall.com'))return'天猫';
 }catch{}
 return'电商平台';
}

async function inspectProductPage(sourceUrl,entity,minScore=55){
 if(!/^https?:\/\//.test(sourceUrl||'')){
  return{matched:false,score:0,imageUrl:'',imageSource:'',sourceUrl,identity:''};
 }
 const response=await fetchRemote(sourceUrl,{
  method:'GET',
  headers:{Accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'}
 });
 if(!response||!response.ok){
  return{matched:false,score:0,imageUrl:'',imageSource:'',sourceUrl,identity:''};
 }
 const type=String(response.headers.get('content-type')||'').toLowerCase();
 if(!type.includes('text/html')&&!type.includes('application/xhtml+xml')){
  try{await response.body?.cancel();}catch{}
  return{matched:false,score:0,imageUrl:'',imageSource:'',sourceUrl,identity:''};
 }
 const finalUrl=response.url||sourceUrl;
 const html=await limitedText(response,1800000);
 const identity=pageIdentityText(html);
 const match=productMatchScore(identity,entity);
 let score=match.score;
 if(isMarketplaceDetailUrl(finalUrl))score+=8;
 const matched=score>=minScore;
 if(!matched){
  return{matched:false,score,reasons:match.reasons,imageUrl:'',imageSource:'',sourceUrl:finalUrl,identity};
 }
 for(const candidate of pageImageCandidates(html,finalUrl,entity)){
  if(!plausibleProductImageUrl(candidate.url))continue;
  const verified=await verifiedImageUrl(candidate.url);
  if(verified){
   return{
    matched:true,
    score,
    reasons:match.reasons,
    imageUrl:verified,
    imageSource:candidate.source,
    sourceUrl:finalUrl,
    identity
   };
  }
 }
 return{matched:true,score,reasons:match.reasons,imageUrl:'',imageSource:'',sourceUrl:finalUrl,identity};
}

function decodeDuckUrl(raw){
 try{
  const u=new URL(raw,'https://html.duckduckgo.com');
  const target=u.searchParams.get('uddg');
  return target?decodeURIComponent(target):u.href;
 }catch{
  return '';
 }
}

async function searchHtml(url){
 try{
  const r=await fetch(url,{
   method:'GET',
   redirect:'follow',
   signal:AbortSignal.timeout(10000),
   headers:{
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145 Safari/537.36',
    'Accept-Language':'zh-CN,zh;q=0.9,en;q=0.8',
    Accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
   }
  });
  if(!r.ok)return'';
  return limitedText(r,1800000);
 }catch{
  return '';
 }
}

async function searchDuckQuery(query){
 const q=encodeURIComponent(query);
 const html=await searchHtml(`https://html.duckduckgo.com/html/?q=${q}`);
 const out=[];
 const re=/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
 let m;
 while((m=re.exec(html))&&out.length<12){
  const url=decodeDuckUrl(decodeHtml(m[1]));
  const title=stripTags(m[2]);
  if(!/^https?:\/\//.test(url))continue;
  try{
   if(/duckduckgo\.com/i.test(new URL(url).hostname))continue;
  }catch{continue;}
  out.push({url,title,snippet:'',engine:'duckduckgo'});
 }
 return out;
}

async function searchBingQuery(query){
 const q=encodeURIComponent(query);
 const html=await searchHtml(`https://www.bing.com/search?q=${q}&count=12&setlang=zh-cn`);
 const out=[];
 const re=/<li[^>]+class=["'][^"']*b_algo[^"']*["'][\s\S]*?<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/li>/gi;
 let m;
 while((m=re.exec(html))&&out.length<12){
  const url=decodeHtml(m[1]);
  const title=stripTags(m[2]);
  if(!/^https?:\/\//.test(url))continue;
  out.push({url,title,snippet:'',engine:'bing'});
 }
 return out;
}

function searchResultScore(result,entity){
 const match=productMatchScore(
  `${result.title||''} ${result.snippet||''} ${result.url||''}`,
  entity
 );
 let score=match.score;
 if(/官方|官网|official/i.test(`${result.title||''} ${result.snippet||''}`))score+=8;
 if(/product|products|item|goods|detail|shop/i.test(result.url||''))score+=5;
 if(/search|query|category|list/i.test(result.url||''))score-=20;
 return score;
}

async function searchProductSources(entity){
 const query=`"${entity}" 官方 产品`;
 const settled=await Promise.allSettled([
  searchDuckQuery(query),
  searchBingQuery(query)
 ]);
 const all=settled.flatMap(x=>x.status==='fulfilled'?x.value:[]);
 return all
  .filter((x,i,a)=>a.findIndex(y=>y.url===x.url)===i)
  .map(x=>({...x,score:searchResultScore(x,entity)}))
  .filter(x=>x.score>=45)
  .sort((a,b)=>b.score-a.score)
  .slice(0,8);
}

async function searchMarketplaceProductPages(entity){
 const sites=['item.jd.com','item.taobao.com','detail.tmall.com'];
 const jobs=[];
 for(const site of sites){
  const query=`${entity} site:${site}`;
  jobs.push(searchBingQuery(query));
  jobs.push(searchDuckQuery(query));
 }
 const settled=await Promise.allSettled(jobs);
 const all=settled.flatMap(x=>x.status==='fulfilled'?x.value:[]);
 return all
  .filter(x=>isMarketplaceDetailUrl(x.url))
  .filter((x,i,a)=>a.findIndex(y=>y.url===x.url)===i)
  .map(x=>{
   const match=productMatchScore(`${x.title||''} ${x.snippet||''}`,entity);
   return{...x,score:match.score+10,reasons:match.reasons};
  })
  .filter(x=>x.score>=50)
  .sort((a,b)=>b.score-a.score)
  .slice(0,10);
}

async function searchMarketplaceImageCards(entity){
 const q=encodeURIComponent(
  `${entity} (site:item.jd.com OR site:item.taobao.com OR site:detail.tmall.com)`
 );
 const html=await searchHtml(
  `https://www.bing.com/images/search?q=${q}&form=HDRSC3&first=1&count=30`
 );
 const out=[];
 const re=/<a[^>]+class=["'][^"']*iusc[^"']*["'][^>]+m=["']([^"']+)["'][^>]*>/gi;
 let m;
 while((m=re.exec(html))&&out.length<20){
  let data;
  try{
   data=JSON.parse(decodeHtml(m[1]));
  }catch{
   continue;
  }
  const imageUrl=data.murl||data.turl||'';
  const sourceUrl=data.purl||'';
  const title=clean(data.t||data.desc||'',160);
  if(!/^https?:\/\//.test(imageUrl))continue;
  if(!isMarketplaceDetailUrl(sourceUrl))continue;
  const match=productMatchScore(`${title} ${sourceUrl}`,entity);
  const score=match.score+10;
  if(score<55)continue;
  out.push({
   imageUrl,
   sourceUrl,
   title,
   score,
   reasons:match.reasons,
   source:`${marketplaceLabel(sourceUrl)}搜索结果`
  });
 }
 return out
  .filter((x,i,a)=>a.findIndex(y=>y.imageUrl===x.imageUrl&&y.sourceUrl===x.sourceUrl)===i)
  .sort((a,b)=>b.score-a.score)
  .slice(0,8);
}


function geminiImageApiKey(){
 return process.env.GEMINI_IMAGE_SEARCH_API_KEY||process.env.GEMINI_API_KEY||'';
}

async function geminiInteraction(payload){
 const key=geminiImageApiKey();
 if(!key)throw Error('缺少 GEMINI_API_KEY，无法执行 Gemini 图片搜索。');

 const response=await fetch(
  'https://generativelanguage.googleapis.com/v1beta/interactions',
  {
   method:'POST',
   signal:AbortSignal.timeout(45000),
   headers:{
    'Content-Type':'application/json',
    'x-goog-api-key':key
   },
   body:JSON.stringify(payload)
  }
 );

 const raw=await response.text();
 let data;
 try{data=JSON.parse(raw);}catch{
  throw Error(`Gemini Image Search 返回非 JSON：${raw.slice(0,240)}`);
 }

 if(!response.ok){
  console.error('[gemini-image] API error:',response.status,data?.error||data);
  throw Error(data?.error?.message||`Gemini Image Search 请求失败（${response.status}）`);
 }
 return data;
}

function interactionOutputText(interaction){
 const out=[];
 for(const step of interaction?.steps||[]){
  if(step?.type!=='model_output')continue;
  for(const block of step.content||[]){
   if(block?.type==='text'&&typeof block.text==='string')out.push(block.text);
  }
 }
 return out.join('\n').trim();
}

function extractGoogleSearchSuggestions(interaction){
 const snippets=[];
 for(const step of interaction?.steps||[]){
  if(step?.type!=='google_search_result')continue;
  for(const result of Array.isArray(step.result)?step.result:[]){
   if(typeof result?.search_suggestions==='string'&&result.search_suggestions.trim()){
    snippets.push(result.search_suggestions.trim());
   }
  }
 }
 return snippets.join('\n');
}

function extractInteractionCitations(interaction){
 const out=[];
 for(const step of interaction?.steps||[]){
  if(step?.type!=='model_output')continue;
  for(const block of step.content||[]){
   for(const a of block?.annotations||[]){
    if(a?.type==='url_citation'&&/^https?:\/\//.test(a.url||'')){
     out.push({url:a.url,title:clean(a.title||'',120)});
    }
   }
  }
 }
 return out.filter((x,i,a)=>a.findIndex(y=>y.url===x.url)===i).slice(0,8);
}

function imageSourceMeta(node,parent={}){
 if(!node||typeof node!=='object')return parent;
 const title=clean(
  node.title||node.name||node.source_title||node.sourceTitle||parent.title||'',
  160
 );
 const rawUrl=
  node.source_url||node.sourceUrl||node.source_uri||node.sourceUri||
  node.page_url||node.pageUrl||node.url||parent.sourceUrl||'';
 const sourceUrl=/^https?:\/\//.test(String(rawUrl||''))?String(rawUrl):parent.sourceUrl||'';
 return{title,sourceUrl};
}

function collectGroundedImageBlocks(node,out,parentMeta={}){
 if(!node)return;
 if(Array.isArray(node)){
  for(const child of node)collectGroundedImageBlocks(child,out,parentMeta);
  return;
 }
 if(typeof node!=='object')return;

 const meta=imageSourceMeta(node,parentMeta);

 if(node.type==='image'&&(typeof node.data==='string'||typeof node.uri==='string')){
  out.push({
   data:typeof node.data==='string'?node.data:'',
   uri:typeof node.uri==='string'?node.uri:'',
   mimeType:node.mime_type||node.mimeType||'image/jpeg',
   title:meta.title,
   sourceUrl:meta.sourceUrl
  });
 }

 if(node.image&&typeof node.image==='object'){
  const img=node.image;
  if(typeof img.data==='string'||typeof img.uri==='string'){
   out.push({
    data:typeof img.data==='string'?img.data:'',
    uri:typeof img.uri==='string'?img.uri:'',
    mimeType:img.mime_type||img.mimeType||'image/jpeg',
    title:meta.title,
    sourceUrl:meta.sourceUrl
   });
  }
 }

 for(const [key,value] of Object.entries(node)){
  if(key==='data'||key==='image'||key==='search_suggestions')continue;
  if(value&&typeof value==='object')collectGroundedImageBlocks(value,out,meta);
 }
}

function extractGroundedImages(interaction){
 const images=[];
 for(const step of interaction?.steps||[]){
  if(step?.type!=='google_search_result'||step.is_error)continue;
  collectGroundedImageBlocks(step.result||[],images,{});
 }
 return images
  .filter(x=>x.data||x.uri)
  .filter((x,i,a)=>{
   const key=x.data?`d:${x.data.slice(0,96)}`:`u:${x.uri}`;
   return a.findIndex(y=>(y.data?`d:${y.data.slice(0,96)}`:`u:${y.uri}`)===key)===i;
  })
  .slice(0,12);
}

async function materializeGroundedImage(candidate){
 if(candidate.data){
  try{
   const buffer=Buffer.from(candidate.data,'base64');
   if(!buffer.length||buffer.length>6*1024*1024)return null;
   return{buffer,mimeType:candidate.mimeType||'image/jpeg'};
  }catch{return null;}
 }

 if(candidate.uri&&/^https:\/\//.test(candidate.uri)){
  try{
   const response=await fetch(candidate.uri,{
    signal:AbortSignal.timeout(12000),
    headers:{
     'x-goog-api-key':geminiImageApiKey(),
     Accept:'image/*'
    }
   });
   if(!response.ok)return null;
   const mimeType=String(response.headers.get('content-type')||candidate.mimeType||'').split(';')[0];
   if(!mimeType.startsWith('image/'))return null;
   const buffer=Buffer.from(await response.arrayBuffer());
   if(!buffer.length||buffer.length>6*1024*1024)return null;
   return{buffer,mimeType};
  }catch{return null;}
 }
 return null;
}

function parseImageVerification(text=''){
 const line=String(text||'').trim().split(/\r?\n/).find(Boolean)||'';
 const m=line.match(/^(MATCH|NO_MATCH|NO|YES)\s*\|\s*([01](?:\.\d+)?)\s*\|\s*(.*)$/i);
 if(m){
  return{
   match:/^(MATCH|YES)$/i.test(m[1]),
   confidence:Math.max(0,Math.min(1,Number(m[2])||0)),
   reason:clean(m[3]||'',180)
  };
 }
 const yes=/\b(?:MATCH|YES|匹配|是同一型号)\b/i.test(line)&&!/NO_MATCH|不匹配|不是同一型号/i.test(line);
 const scoreMatch=line.match(/(?:confidence|置信度)\s*[:：=]?\s*(0(?:\.\d+)?|1(?:\.0+)?)/i);
 return{
  match:yes,
  confidence:scoreMatch?Number(scoreMatch[1]):(yes?0.75:0),
  reason:clean(line,180)
 };
}

async function validateProductImageWithGemini(entity,image){
 const interaction=await geminiInteraction({
  model:geminiImageSearchModel,
  input:[
   {
    type:'text',
    text:
     `目标商品：${entity}\n`+
     '判断图片是否确实展示这个具体品牌和型号的产品。'+
     '品牌相同但型号不同、Logo、人物、广告海报、包装局部、配件、其他型号都判定为不匹配。'+
     '只输出一行：MATCH|0到1的置信度|简短原因，或 NO_MATCH|0到1的置信度|简短原因。'
   },
   {
    type:'image',
    data:image.buffer.toString('base64'),
    mime_type:image.mimeType
   }
  ],
  response_format:{type:'text'},
  generation_config:{thinking_level:'low',max_output_tokens:180}
 });
 return parseImageVerification(interactionOutputText(interaction));
}

function cacheGroundedImage(image,meta={}){
 const id=crypto.createHash('sha256').update(image.buffer).digest('hex').slice(0,32);
 groundedImageCache.set(id,{
  buffer:image.buffer,
  mimeType:image.mimeType||'image/jpeg',
  created:Date.now(),
  title:clean(meta.title||'',160),
  sourceUrl:/^https?:\/\//.test(meta.sourceUrl||'')?meta.sourceUrl:''
 });
 for(const [key,value] of groundedImageCache){
  if(Date.now()-value.created>groundedImageTtl)groundedImageCache.delete(key);
 }
 return id;
}

async function searchProductImageWithGemini(entity){
 console.log(`[gemini-image] searching: ${entity}`);
 const interaction=await geminiInteraction({
  model:geminiImageSearchModel,
  input:
   `搜索“${entity}”的真实产品主图。必须针对具体品牌和型号。`+
   '优先官方产品图、白底图、清晰实物图。不要生成新图片，不要用Logo、人物、新闻图、宣传海报、其他型号或相似商品代替。'+
   '请用简短文字说明你搜索了该具体型号。',
  tools:[{
   type:'google_search',
   search_types:['image_search','web_search']
  }],
  response_format:{type:'text'},
  generation_config:{thinking_level:'low',max_output_tokens:240}
 });

 const suggestions=extractGoogleSearchSuggestions(interaction);
 const citations=extractInteractionCitations(interaction);
 const candidates=extractGroundedImages(interaction);

 console.log(`[gemini-image] candidates(${candidates.length}): ${entity}`);
 console.log('[gemini-image] step types:',(interaction.steps||[]).map(step=>({
  type:step.type,
  resultCount:Array.isArray(step.result)?step.result.length:0
 })));

 for(const candidate of candidates.slice(0,6)){
  const image=await materializeGroundedImage(candidate);
  if(!image)continue;

  let verification;
  try{
   verification=await validateProductImageWithGemini(entity,image);
  }catch(error){
   console.warn(`[gemini-image] verify request failed: ${entity}`,error.message);
   continue;
  }

  console.log(`[gemini-image] verify ${entity}:`,{
   match:verification.match,
   confidence:verification.confidence,
   reason:verification.reason,
   title:candidate.title,
   sourceUrl:candidate.sourceUrl
  });

  if(!verification.match||verification.confidence<0.72)continue;

  const id=cacheGroundedImage(image,candidate);
  return{
   id,
   url:`/api/grounded-product-image/${id}`,
   source:'Google 图片搜索',
   sourceUrl:candidate.sourceUrl||'',
   sourceTitle:candidate.title||'',
   searchSuggestions:suggestions,
   citations,
   confidence:verification.confidence,
   reason:verification.reason
  };
 }

 console.warn(`[gemini-image] no visually verified image: ${entity}`);
 return null;
}

function proxyImageUrl(raw){
 return `/api/image?url=${encodeURIComponent(raw)}`;
}

function mediaEvidenceUrls(item,plan){
 const entity=item.entity||item.title||'';
 const urls=[];
 if(/^https?:\/\//.test(item.sourceUrl||''))urls.push(item.sourceUrl);
 for(const fact of plan?.sharedFacts||[]){
  const relevant=
   entityMatch(fact.statement,entity)||
   (fact.evidence||[]).some(e=>
    entityMatch(`${e.title||''} ${e.snippet||''}`,entity)
   );
  if(!relevant)continue;
  for(const evidence of fact.evidence||[]){
   if(/^https?:\/\//.test(evidence.url||''))urls.push(evidence.url);
  }
 }
 return[...new Set(urls)].slice(0,6);
}

async function resolveProductMediaItem(item,plan){
 const entity=clean(item.entity||item.title||'',80);
 if(!entity)return null;
 console.log(`[product-image] resolving with Gemini: ${entity}`);

 try{
  const result=await searchProductImageWithGemini(entity);
  if(!result){
   console.warn(`[product-image] Gemini found no verified image: ${entity}`);
   return null;
  }

  console.log(
   `[product-image] Gemini image OK: ${entity}, confidence=${result.confidence}`
  );

  return{
   ...item,
   entity,
   title:item.title||entity,
   url:result.url,
   source:result.source,
   sourceUrl:result.sourceUrl,
   searchSuggestions:result.searchSuggestions||'',
   imageConfidence:result.confidence,
   imageVerification:result.reason||''
  };
 }catch(error){
  console.error(`[product-image] Gemini search failed: ${entity}`,error);
  return null;
 }
}

function productSeedsFromLinks(section){
 const seen=new Set();
 const out=[];

 for(const link of section.links||[]){
  const entity=clean(link.label||link.query||'',80);

  if(!entity||seen.has(entity))continue;
  seen.add(entity);

  out.push({
   url:'',
   title:entity,
   caption:'',
   source:'',
   sourceUrl:'',
   entity,
   factIds:Array.isArray(section.factIds)?section.factIds:[]
  });
 }

 return out.slice(0,4);
}

function isGenericCandidateLabel(value=''){
 const text=clean(value,80).toLowerCase();

 if(!text||text.length<2||text.length>50){
  return true;
 }

 if(/^[\d\s.%¥￥$+\-/×x~～]+$/i.test(text)){
  return true;
 }

 return /^(对比维度|对比项|参数|项目|指标|维度|产品|商品|品牌|型号|车型|候选|名称|方案|选项|定位|核心优势|主要短板|适用人群|风险与待核实参数|价格|售价|预算|尺寸|重量|续航|容量|噪音|功率|匹配度|推荐度)$/i.test(text);
}

function candidateLabelsFromSection(section){
 if(
  !section||
  !['comparison','table'].includes(section.type)||
  !Array.isArray(section.rows)||
  section.rows.length<2
 ){
  return [];
 }

 const rows=section.rows;
 const header=Array.isArray(rows[0])?rows[0]:[];

 if(header.length<2){
  return [];
 }

 const first=clean(header[0]||'',60);
 const columnOriented=/对比|维度|项目|指标|参数|选项/i.test(first);

 if(columnOriented){
  const labels=header
   .slice(1)
   .map(x=>clean(x,80))
   .filter(x=>!isGenericCandidateLabel(x));

  if(labels.length>=2&&labels.length<=4){
   return labels;
  }
 }

 if(/产品|商品|品牌|型号|车型|候选|名称|方案|选项/i.test(first)){
  const labels=rows
   .slice(1)
   .map(r=>Array.isArray(r)?clean(r[0]||'',80):'')
   .filter(x=>!isGenericCandidateLabel(x))
   .slice(0,4);

  if(labels.length>=2){
   return labels;
  }
 }

 return [];
}

function linksForCandidates(page,candidates){
 const allLinks=(page?.sections||[])
  .flatMap(s=>Array.isArray(s.links)?s.links:[]);
 const out=[];
 const seen=new Set();

 for(const candidate of candidates){
  const matched=allLinks.filter(link=>
   entityMatch(`${link.label||''} ${link.query||''}`,candidate)
  );

  for(const link of matched){
   const key=`${link.channel}::${link.query}`;
   if(seen.has(key))continue;
   seen.add(key);
   out.push({
    label:clean(link.label||candidate,80),
    query:clean(link.query||candidate,120),
    channel:['official','jd','taobao'].includes(link.channel)?link.channel:'official'
   });
  }

  const hasCandidate=out.some(link=>
   entityMatch(`${link.label} ${link.query}`,candidate)
  );

  if(!hasCandidate){
   for(const channel of ['jd','taobao']){
    const key=`${channel}::${candidate}`;
    if(seen.has(key))continue;
    seen.add(key);
    out.push({label:candidate,query:candidate,channel});
   }
  }
 }

 return out.slice(0,9);
}


function looksLikeProductTask(page,query=''){
 const text=[
  query,
  page?.title,
  page?.subtitle,
  page?.summary,
  ...(page?.sections||[]).flatMap(s=>[s.heading,s.intro])
 ].filter(Boolean).join(' ');

 return /商品|产品|品牌|型号|车型|车载|轿车|汽车|新能源|手机|电脑|耳机|相机|冰箱|空调|净化器|电视|家电|选购|购买|推荐|价格|预算|配置|续航|电池|容量|款/i.test(text);
}

function ensureProductImageSection(page,plan,query=''){
 if(
  !page||
  !Array.isArray(page.sections)||
  !looksLikeProductTask(page,query)
 ){
  return page;
 }

 let sourceIndex=-1;
 let candidates=[];

 for(let i=0;i<page.sections.length;i++){
  const found=candidateLabelsFromSection(page.sections[i]);
  if(found.length>candidates.length){
   candidates=found;
   sourceIndex=i;
  }
 }

 if(candidates.length<2){
  return page;
 }

 const existing=page.sections.find(s=>s.type==='product_image');
 const sourceSection=page.sections[sourceIndex]||{};
 const sharedFactIds=Array.isArray(sourceSection.factIds)
  ? sourceSection.factIds.slice(0,12)
  : [];

 const seeds=candidates.map(candidate=>({
  url:'',
  title:candidate,
  caption:'候选产品图片仅用于快速识别与视觉参考，具体参数与价格以页面中的事实证据为准。',
  source:'',
  sourceUrl:'',
  entity:candidate,
  factIds:sharedFactIds
 }));

 const links=linksForCandidates(page,candidates);

 if(existing){
  if(!Array.isArray(existing.media)||!existing.media.length){
   existing.media=seeds;
  }
  if(!Array.isArray(existing.links)||!existing.links.length){
   existing.links=links;
  }
  if(!existing.heading){
   existing.heading='候选产品图文一览';
  }
  return page;
 }

 const section={
  type:'product_image',
  heading:'候选产品图文一览',
  intro:'先通过产品图片快速建立识别，再结合下方参数、事实证据与风险项进行比较。图片仅用于视觉展示，不作为参数真实性证据。',
  items:[],
  rows:[],
  resultLabel:'',
  factIds:sharedFactIds,
  links,
  media:seeds
 };

 let insertAt=Math.max(0,sourceIndex);

 if(page.sections.length>=8){
  let removeAt=-1;

  for(let i=page.sections.length-1;i>=0;i--){
   if(i!==sourceIndex&&['narrative','cards','steps','checklist','timeline'].includes(page.sections[i].type)){
    removeAt=i;
    break;
   }
  }

  if(removeAt<0){
   removeAt=page.sections.findIndex((_,i)=>i!==sourceIndex);
  }

  if(removeAt>=0){
   page.sections.splice(removeAt,1);
   if(removeAt<insertAt)insertAt--;
  }
 }

 page.sections.splice(
  Math.max(0,Math.min(insertAt,page.sections.length)),
  0,
  section
 );

 return page;
}

async function enrichProductMedia(page,plan){
 if(!page||!Array.isArray(page.sections))return page;
 for(const section of page.sections){
  if(section.type!=='product_image')continue;
  const seeds=section.media?.length?section.media:productSeedsFromLinks(section);
  const limitedSeeds=seeds.slice(0,4);
  const resolved=await Promise.all(limitedSeeds.map(item=>resolveProductMediaItem(item,plan)));
  section.media=limitedSeeds.map((seed,i)=>resolved[i]||{...seed,url:'',source:'',sourceUrl:''});
 }
 return page;
}

function parsePlan(o){
 const p=jsonOf(o,'方案');
 const v=p?.variants;
 const f=p?.sharedFacts;

 if(
  !p||
  typeof p.title!=='string'||
  typeof p.taskType!=='string'||
  !Array.isArray(p.constraints)||
  !p.constraints.every(
   x=>typeof x==='string'
  )||
  !Array.isArray(f)||
  !f.every(x=>
   x&&
   typeof x.id==='string'&&
   typeof x.statement==='string'&&
   [
    'user',
    'fact',
    'assumption',
    'calculation'
   ].includes(x.kind)&&
   [
    'provided',
    'verified',
    'unverified'
   ].includes(x.status)&&
   typeof x.source==='string'
  )||
  !Array.isArray(v)||
  v.length!==7||
  !v.every(x=>
   x&&
   [
    'title',
    'audience',
    'focus',
    'outcome'
   ].every(k=>
    typeof x[k]==='string'&&
    x[k].trim()
   )&&
   layouts.includes(x.layout)&&
   Array.isArray(x.outline)&&
   x.outline.length>=3&&
   x.outline.length<=6&&
   x.outline.every(
    y=>typeof y==='string'
   )&&
   Array.isArray(x.components)&&
   x.components.length&&
   x.components.every(
    y=>types.includes(y)
   )
  )
 ){
  throw Error(
   '七种页面形态不完整，请重试。'
  );
 }

 p.title=clean(p.title,50);
 p.taskType=clean(p.taskType,24);

 p.constraints=
  p.constraints
   .slice(0,12)
   .map(x=>clean(x,100));

 p.sharedFacts=
  p.sharedFacts
   .slice(0,20)
   .map(x=>{
    const ev=
     normalizeEvidence(x.evidence);

    const fact={
     ...x,
     id:clean(x.id,30),
     statement:clean(
      x.statement,
      160
     ),
     source:clean(
      x.source,
      100
     )
    };

    if(ev.length){
     fact.evidence=ev;
    }

    return fact;
   });

 p.variants=
  p.variants.map((x,i)=>({
   ...x,
   layout:layouts[i],
   title:clean(x.title,30),
   audience:clean(x.audience,70),
   focus:clean(x.focus,100),
   outcome:clean(x.outcome,80),
   outline:x.outline.map(
    y=>clean(y,70)
   )
  }));

 return p;
}

function parsePage(o){
 const p=jsonOf(o,'页面');

 if(
  !p||
  ![
   'title',
   'subtitle',
   'summary'
  ].every(
   k=>typeof p[k]==='string'
  )||
  !Array.isArray(p.sections)||
  p.sections.length<3||
  p.sections.length>8||
  !p.sections.every(s=>
   s&&
   types.includes(s.type)&&
   typeof s.heading==='string'&&
   typeof s.intro==='string'&&
   Array.isArray(s.items)&&
   s.items.every(
    x=>typeof x==='string'
   )&&
   Array.isArray(s.rows)&&
   s.rows.every(r=>
    Array.isArray(r)&&
    r.every(
     x=>typeof x==='string'
    )
   )&&
   typeof s.resultLabel==='string'&&
   Array.isArray(s.factIds)&&
   s.factIds.every(
    x=>typeof x==='string'
   )&&
   Array.isArray(s.links)&&
   s.links.every(x=>
    x&&
    typeof x.label==='string'&&
    typeof x.query==='string'&&
    [
     'official',
     'jd',
     'taobao'
    ].includes(x.channel)
   )&&
   Array.isArray(s.media)&&
   s.media.every(x=>
    x&&
    typeof x.url==='string'&&
    typeof x.title==='string'&&
    typeof x.caption==='string'&&
    typeof x.source==='string'&&
    typeof x.sourceUrl==='string'&&
    typeof x.entity==='string'&&
    Array.isArray(x.factIds)&&
    x.factIds.every(y=>
     typeof y==='string'
    )
   )
  )
 ){
  throw Error(
   '页面配置不完整，请重试。'
  );
 }

 for(const s of p.sections){
  s.media=normalizeMedia(
   s.media,
   s.type==='product_image'
  );

  s.formula=
   ['sum','product']
    .includes(s.items[0])
     ? s.items[0]
     : 'none';

  s.fields=
   s.type==='calculator'
    ? s.rows
       .slice(1)
       .map(r=>({
        label:r[0]||'项目',
        value:Number(r[1])||0,
        min:Number(r[2])||0,
        max:Number(r[3])||100,
        step:Number(r[4])||1,
        unit:r[5]||''
       }))
    : [];
 }

 return p;
}

function modelError(status,detail=''){
 const m={
  400:'模型或请求配置不受支持。',
  401:'API Key 无效。',
  403:'当前项目没有访问权限。',
  404:'模型不存在或无法访问。',
  429:'API 配额不足或请求过于频繁。',
  503:'模型服务繁忙，请稍后重试。'
 };

 const error=Error(
  m[status]||
  `模型服务暂时不可用（${status}）。`
 );

 error.detail=detail;
 error.apiStatus=status;

 console.error(
  'Model API error:',
  status,
  detail
 );

 return error;
}

async function postModel(
 endpoint,
 payload,
 headers
){
 let r,o,lastDetail='';

 for(let attempt=0;attempt<3;attempt++){
  r=await fetch(endpoint,{
   method:'POST',
   signal:AbortSignal.timeout(
    90000
   ),
   headers,
   body:JSON.stringify(payload)
  });

  if(r.ok){
   o=await r.json();

   return{
    r,
    o,
    lastDetail:''
   };
  }

  try{
   const data=await r.json();

   lastDetail=
    data.error?.message||
    data.message||
    '';
  }catch{}

  if(
   ![
    429,
    500,
    502,
    503,
    504
   ].includes(r.status)||
   attempt===2
  ){
   break;
  }

  await new Promise(resolve=>
   setTimeout(
    resolve,
    800*2**attempt+
    Math.random()*300
   )
  );
 }

 return{
  r,
  o:null,
  lastDetail
 };
}

function wrapText(text){
 return{
  output:[{
   type:'message',
   content:[{
    type:'output_text',
    text:String(text||'')
   }]
  }]
 };
}

async function requestCloseAI(
 input,
 instructions,
 schema,
 parser,
 images=[]
){
 const endpoint=
  `${closeAIBase}/chat/completions`;

 const schemaText=
  JSON.stringify(schema);

 const systemPrompt=
  instructions+
  '\n\n你必须严格按照下面的 JSON Schema 输出。'+
  '\n不得缺少字段，不得增加 Schema 外字段。'+
  '\n必须只输出合法 JSON，不要输出 Markdown 代码块，不要添加 JSON 之外的解释。'+
  '\n如果 Schema 要求数组固定数量，必须严格满足。'+
  '\nJSON Schema：\n'+
  schemaText;

 const headers={
  'Content-Type':'application/json',
  Authorization:`Bearer ${apiKey()}`
 };

 const makePayload=
  messages=>({
   model,
   messages,
   response_format:{
    type:'json_object'
   },
   temperature:0.1
  });

 let payload=
  makePayload([
   {
    role:'system',
    content:systemPrompt
   },
   {
    role:'user',
    content:imageParts(images).length
     ? [
        {
         type:'text',
         text:input
        },
        ...imageParts(images).map(img=>({
         type:'image_url',
         image_url:{
          url:`data:${img.mimeType};base64,${img.data}`
         }
        }))
       ]
     : input
   }
  ]);

 let result=
  await postModel(
   endpoint,
   payload,
   headers
  );

 if(
  !result.r?.ok&&
  result.r?.status===400
 ){
  const fallback={
   ...payload
  };

  delete fallback.response_format;

  result=
   await postModel(
    endpoint,
    fallback,
    headers
   );
 }

 if(!result.r?.ok){
  throw modelError(
   result.r?.status||502,
   result.lastDetail
  );
 }

 let content=
  result.o
   ?.choices
   ?.[0]
   ?.message
   ?.content;

 if(!content){
  throw Error(
   '模型返回为空，请重试。'
  );
 }

 try{
  return parser(
   wrapText(content)
  );
 }catch(firstError){
  console.warn(
   '模型 JSON 第一次校验失败，尝试自动修复：',
   firstError.message
  );
 }

 const repairPayload=
  makePayload([
   {
    role:'system',
    content:
     '你是 JSON 修复器。'+
     '\n必须把用户提供的 JSON 修复成严格符合下面 JSON Schema 的结果。'+
     '\n不得增加 Schema 外字段，不得缺少必填字段。'+
     '\n如果 Schema 指定数组数量，必须严格满足。'+
     '\n只输出修复后的合法 JSON，不要解释，不要 Markdown，不要代码块。'+
     '\nJSON Schema：\n'+
     schemaText
   },
   {
    role:'user',
    content:
     '请修复下面的 JSON，使其严格符合 Schema：\n\n'+
     content
   }
  ]);

 let repaired=
  await postModel(
   endpoint,
   repairPayload,
   headers
  );

 if(
  !repaired.r?.ok&&
  repaired.r?.status===400
 ){
  const fallback={
   ...repairPayload
  };

  delete fallback.response_format;

  repaired=
   await postModel(
    endpoint,
    fallback,
    headers
   );
 }

 if(!repaired.r?.ok){
  throw modelError(
   repaired.r?.status||502,
   repaired.lastDetail
  );
 }

 content=
  repaired.o
   ?.choices
   ?.[0]
   ?.message
   ?.content;

 if(!content){
  throw Error(
   '模型修复结果为空，请重试。'
  );
 }

 return parser(
  wrapText(content)
 );
}

async function requestGeminiOfficial(
 input,
 instructions,
 schema,
 parser,
 ground=false,
 images=[]
){
 const endpoint=
  `${geminiBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

 const base={
  systemInstruction:{
   parts:[{
    text:instructions
   }]
  },
  contents:[{
   role:'user',
   parts:[
    {
     text:input
    },
    ...imageParts(images).map(img=>({
     inlineData:{
      mimeType:img.mimeType,
      data:img.data
     }
    }))
   ]
  }],
  generationConfig:{
   responseMimeType:'application/json',
   responseSchema:schema
  }
 };

 const payloads=
  ground&&geminiGrounding
   ? [
      {
       ...base,
       tools:[{
        googleSearch:{}
       }]
      },
      base,
      {
       ...base,
       generationConfig:{
        responseMimeType:
         'application/json'
       }
      }
     ]
   : [
      base,
      {
       ...base,
       generationConfig:{
        responseMimeType:
         'application/json'
       }
      }
     ];

 let last;

 for(const payload of payloads){
  last=
   await postModel(
    endpoint,
    payload,
    {
     'Content-Type':
      'application/json',
     'x-goog-api-key':
      apiKey()
    }
   );

  if(last.r?.ok){
   const o=last.o;
   const c=o.candidates?.[0];

   if(
    c?.finishReason&&
    c.finishReason!=='STOP'
   ){
    throw Error(
     '模型未完成生成，请重试。'
    );
   }

   const wrapped={
    output:[{
     type:'message',
     content:
      (c?.content?.parts||[])
       .filter(
        p=>p.text&&!p.thought
       )
       .map(p=>({
        type:'output_text',
        text:p.text
       }))
    }]
   };

   return attachEvidence(
    parser(wrapped),
    evidenceOfGemini(o)
   );
  }

  if(
   ![400,404]
    .includes(last.r?.status)
  ){
   break;
  }
 }

 throw modelError(
  last.r?.status||502,
  last.lastDetail
 );
}

async function requestOpenAI(
 input,
 instructions,
 schema,
 parser
){
 const endpoint=
  'https://api.openai.com/v1/responses';

 const payload={
  model,
  instructions,
  input,
  text:{
   format:{
    type:'json_schema',
    name:'liquid_page',
    strict:true,
    schema
   }
  }
 };

 const result=
  await postModel(
   endpoint,
   payload,
   {
    'Content-Type':
     'application/json',
    Authorization:
     `Bearer ${apiKey()}`
   }
  );

 if(!result.r?.ok){
  throw modelError(
   result.r?.status||502,
   result.lastDetail
  );
 }

 return parser(result.o);
}

async function requestModel(
 input,
 instructions,
 schema,
 parser,
 ground=false,
 images=[]
){
 if(isCloseAI){
  return requestCloseAI(
   input,
   instructions,
   schema,
   parser,
   images
  );
 }

 if(isGemini){
  return requestGeminiOfficial(
   input,
   instructions,
   schema,
   parser,
   ground,
   images
  );
 }

 return requestOpenAI(
  input,
  instructions,
  schema,
  parser
 );
}

const planPrompt=
 '理解用户真正要完成的任务，提取全部硬约束，并规划恰好七种呈现同一份最终答案的网页形态。七种形态依次对应 hand、terminal、magazine、ice、minimal、app、neon；它们只改变叙事顺序、视觉重点与交互方式，不得改变事实、计算、候选项或最终结论。sharedFacts 是统一事实账本：用户内容标 user/provided，无法核实的外部信息标 fact/unverified，假设标 assumption/unverified，计算标 calculation/provided；只有能由搜索引用元数据直接支撑的外部事实才允许最终升级为 verified；不得伪造来源、价格、库存、参数或商品详情 URL。每个形态给出适合的阅读场景、重点、相同交付目标、3至6节统一内容大纲与有效组件。当任务涉及商品推荐、产品选型、品牌型号对比时，把 product_image 作为建议组件之一。普通上传图片主要用于理解，不默认要求把原图展示出来。严格限制文字，中文，不追问。';

const pagePrompt=
 '生成一份真正完成用户任务的统一内容结果，之后会被七种界面共同渲染。必须保留全部约束，先给关键判断，再展示思考路径、可比较的信息、可执行步骤与最终选择。若任务涉及购买、品牌、产品选型或商品对比：至少列出3个不同品牌或候选项，分别写清适用人群、关键区别、风险和待核实参数；优先生成type=product_image的section，位置靠近推荐结论或对比表。product_image的media为每个主要候选商品保留一条记录，entity和title写具体品牌+型号，caption写一句与需求相关的推荐理由；如果能核实官网页、品牌页或可信商品页，把页面写入sourceUrl并写明source。直接图片URL只有确认是真实可访问图片时才填写url；无法确认时url返回空字符串，不得编造，后端会继续主动搜索产品页和产品图。product_image的links中为候选项给出搜索入口，label写候选名称，query写完整品牌型号关键词，channel在official、jd、taobao中选择。系统会安全生成站内搜索链接，不得编造商品详情URL。当存在用户上传的原始图片时，必须重新直接观察图片，不得只依赖originalQuery或sharedFacts；明显可见的主体、动物、家具、设备、文字、布局、颜色和空间信息应纳入结果；看不清或无法确认的细节标“图片信息待核实”，禁止臆测。普通上传图片主要作为理解输入，除非用户明确要求展示原图，否则不要为了展示上传图片而使用image组件。image_gallery用于明确需要多图展示的任务。除product_image外，media里只能填写真实可访问的图片URL；所有media记录都必须带title、caption、source、sourceUrl、entity和factIds。所有外部事实必须来自sharedFacts；无法核实的参数或价格明确写待核实，不得伪造来源或精确数据。图片只用于视觉展示，不得把图片本身当作参数事实证据。内容要具体。calculator用rows表示输入字段，第一行固定为[名称,初值,最小值,最大值,步长,单位]；items第一项只用sum或product。comparison/table/barChart使用rows且第一行表头，barChart第二列为数字。checklist/timeline/steps/cards用items。未使用字段返回空数组。用中文。';

const planQuery=
 (q,images=[])=>requestModel(
  q,
  planPrompt,
  planSchema,
  parsePlan,
  isGemini,
  images
 );

const generatePage=
 (q,p,images=[])=>requestModel(
  JSON.stringify({
   originalQuery:q,
   sharedConstraints:p.constraints,
   sharedFacts:p.sharedFacts,
   contentOutline:p.variants[0].outline,
   suggestedComponents:[
    ...new Set(
     p.variants.flatMap(x=>x.components)
    )
   ],
   imageContext:images.length
    ? '用户本次上传了原始参考图片。请在生成最终页面时重新直接观察图片，并将明显可见信息纳入结果；不要只依赖sharedFacts。'
    : ''
  }),
  pagePrompt,
  pageSchema,
  parsePage,
  isGemini,
  images
 );

const sessions=new Map();
const ttl=2*60*60*1000;

function prune(){
 for(const[id,s]of sessions){
  if(
   Date.now()-s.created>ttl
  ){
   sessions.delete(id);
  }
 }

 while(sessions.size>=100){
  sessions.delete(
   sessions.keys()
    .next()
    .value
  );
 }
}

function clientIp(req){
 return String(
  req.headers[
   'x-forwarded-for'
  ]||
  req.socket.remoteAddress||
  'unknown'
 )
  .split(',')[0]
  .trim();
}

function allowRequest(
 req,
 now=Date.now()
){
 const ip=clientIp(req);

 const recent=
  (requestLog.get(ip)||[])
   .filter(
    time=>
     now-time<rateWindow
   );

 if(
  recent.length>=
  requestLimit
 ){
  requestLog.set(
   ip,
   recent
  );

  return false;
 }

 recent.push(now);

 requestLog.set(
  ip,
  recent
 );

 if(
  requestLog.size>10000
 ){
  for(
   const[key,times]
   of requestLog
  ){
   if(
    !times.some(
     time=>
      now-time<rateWindow
    )
   ){
    requestLog.delete(key);
   }
  }
 }

 return true;
}

const send=
 (res,status,data)=>{
  res.writeHead(
   status,
   {
    'Content-Type':
     'application/json; charset=utf-8'
   }
  );

  res.end(
   JSON.stringify(data)
  );
 };

function body(
 req,
 res,
 cb
){
 let b='';
 let done=false;

 req.on(
  'data',
  c=>{
   if(done){
    return;
   }

   b+=c;

   if(
    Buffer.byteLength(b)>
    7000000
   ){
    done=true;

    send(
     res,
     413,
     {
      error:'输入内容过长。'
     }
    );
   }
  }
 );

 req.on(
  'end',
  ()=>{
   if(!done){
    cb(b);
   }
  }
 );
}

const mime={
 '.html':
  'text/html; charset=utf-8',
 '.js':
  'text/javascript; charset=utf-8',
 '.css':
  'text/css; charset=utf-8',
 '.json':
  'application/json; charset=utf-8'
};

function createServer(){
 return http.createServer(
  (req,res)=>{
   res.setHeader(
    'Cache-Control',
    'no-store'
   );

   res.setHeader(
    'X-Content-Type-Options',
    'nosniff'
   );

   res.setHeader(
    'X-Frame-Options',
    'DENY'
   );

   res.setHeader(
    'Referrer-Policy',
    'no-referrer'
   );

   res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
   );

   const route=
    req.url.split('?')[0];

   if(
    req.method==='GET'&&
    route.startsWith('/api/grounded-product-image/')
   ){
    const id=route.slice('/api/grounded-product-image/'.length).trim();
    const cached=groundedImageCache.get(id);

    if(!cached||Date.now()-cached.created>groundedImageTtl){
     groundedImageCache.delete(id);
     res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});
     return res.end('Image expired');
    }

    res.writeHead(
     200,
     {
      'Content-Type':cached.mimeType||'image/jpeg',
      'Content-Length':cached.buffer.length,
      'Cache-Control':'public, max-age=21600',
      'X-Content-Type-Options':'nosniff'
     }
    );
    return res.end(cached.buffer);
   }

   if(
    req.method==='GET'&&
    route==='/api/image'
   ){
    let target='';

    try{
     const requestUrl=new URL(req.url,'http://localhost');
     target=requestUrl.searchParams.get('url')||'';
    }catch{}

    if(!target||!/^https?:\/\//.test(target)){
     res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'});
     return res.end('Invalid image URL');
    }

    (async()=>{
     const remote=await fetchRemote(
      target,
      {
       method:'GET',
       headers:{Accept:'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'}
      }
     );

     if(!remote||!remote.ok){
      res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});
      return res.end('Image not found');
     }

     const type=String(remote.headers.get('content-type')||'').toLowerCase();

     if(!type.startsWith('image/')){
      try{await remote.body?.cancel();}catch{}
      res.writeHead(415,{'Content-Type':'text/plain; charset=utf-8'});
      return res.end('Not an image');
     }

     const contentLength=Number(remote.headers.get('content-length')||0);
     if(contentLength>6*1024*1024){
      try{await remote.body?.cancel();}catch{}
      res.writeHead(413,{'Content-Type':'text/plain; charset=utf-8'});
      return res.end('Image too large');
     }

     const data=await limitedBuffer(remote);
     if(!data){
      res.writeHead(413,{'Content-Type':'text/plain; charset=utf-8'});
      return res.end('Image too large');
     }

     res.writeHead(
      200,
      {
       'Content-Type':type.split(';')[0],
       'Cache-Control':'public, max-age=21600',
       'X-Content-Type-Options':'nosniff'
      }
     );
     return res.end(data);
    })().catch(error=>{
     console.error('[image-proxy]',error);
     if(!res.headersSent){
      res.writeHead(502,{'Content-Type':'text/plain; charset=utf-8'});
     }
     res.end('Image proxy failed');
    });

    return;
   }

   if(
    req.method==='GET'&&
    route==='/api/health'
   ){
    return send(
     res,
     200,
     {
      ready:Boolean(
       apiKey()&&
       apiKey()!==
       'your_api_key_here'
      ),
      model,
      provider:
       isGemini
        ? 'Gemini'
        : 'OpenAI',
      geminiBase:
       isGemini
        ? geminiBase
        : undefined,
      geminiGrounding:
       isGemini
        ? geminiGrounding
        : undefined,
      isCloseAI:
       isGemini
        ? isCloseAI
        : undefined,
      closeAIBase:
       isCloseAI
        ? closeAIBase
        : undefined
     }
    );
   }

   if(
    req.method==='GET'&&
    route.startsWith(
     '/api/session/'
    )
   ){
    const id=
     decodeURIComponent(
      route.slice(13)
     );

    const session=
     sessions.get(id);

    if(
     !session||
     Date.now()-
     session.created>
     ttl
    ){
     return send(
      res,
      410,
      {
       error:
        '方案已过期，请重新提交 Query。'
      }
     );
    }

    return send(
     res,
     200,
     {
      sessionId:id,
      query:session.query,
      ...session.plan,
      pages:
       Object.fromEntries(
        [...session.pages]
         .filter(
          ([,value])=>
           !(
            value
            instanceof Promise
           )
         )
       )
     }
    );
   }

   if(
    req.method==='POST'&&
    [
     '/api/generate',
     '/api/plan',
     '/api/page'
    ].includes(route)
   ){
    if(
     !allowRequest(req)
    ){
     res.setHeader(
      'Retry-After',
      '3600'
     );

     return send(
      res,
      429,
      {
       error:
        '请求过于频繁，请稍后再试。'
      }
     );
    }

    return body(
     req,
     res,
     async raw=>{
      let payload;

      try{
       payload=
        JSON.parse(raw);
      }catch{
       return send(
        res,
        400,
        {
         error:
          '请求格式无效。'
        }
       );
      }

      if(
       !apiKey()||
       apiKey()===
       'your_api_key_here'
      ){
       return send(
        res,
        502,
        {
         error:
          '请在 .env 配置模型 API Key。'
        }
       );
      }

      try{
       if(
        route===
        '/api/plan'
       ){
        const textQuery=
         typeof payload.query==='string'
          ? payload.query.trim()
          : '';

        const preparedImages=imageParts(payload.images);
        const hasImages=preparedImages.length>0;

        if((!textQuery&&!hasImages)||textQuery.length>9000){
         return send(
          res,
          400,
          {error:'请输入需求，或上传至少一张参考图片。'}
         );
        }

        const effectiveQuery=textQuery||
         '请根据用户上传的参考图片理解其中的文字、物体、界面、布局、颜色、配置和可见结构，并据此生成合适的智能网页；看不清或无法确认的信息必须标为待核实。';

        const plan=await planQuery(
         effectiveQuery,
         preparedImages
        );

        prune();

        const id=crypto.randomUUID();

        sessions.set(
         id,
         {
          query:effectiveQuery,
          plan,
          images:preparedImages,
          pages:new Map(),
          created:Date.now()
         }
        );

        return send(
         res,
         200,
         {
          sessionId:id,
          ...plan
         }
        );
       }

       if(
        route===
        '/api/page'
       ){
        if(
         typeof payload.sessionId!==
         'string'||
         !Number.isInteger(
          payload.variantIndex
         )||
         payload.variantIndex<0||
         payload.variantIndex>6
        ){
         return send(
          res,
          400,
          {
           error:
            '方案参数无效。'
          }
         );
        }

        const session=
         sessions.get(
          payload.sessionId
         );

        if(
         !session||
         Date.now()-
         session.created>
         ttl
        ){
         return send(
          res,
          410,
          {
           error:
            '方案已过期，请重新提交 Query。'
          }
         );
        }

        if(
         !session.canonicalPage
        ){
         session.canonicalPage=
          generatePage(
           session.query,
           session.plan,
           session.images||[]
          )
          .then(page=>
           ensureProductImageSection(
            page,
            session.plan,
            session.query
           )
          )
          .then(page=>
           enrichProductMedia(
            page,
            session.plan
           )
          )
          .then(value=>{
           session.images=[];

           for(
            let i=0;
            i<7;
            i++
           ){
            session.pages.set(
             i,
             value
            );
           }

           return value;
          })
          .catch(error=>{
           delete session
            .canonicalPage;

           throw error;
          });
        }

        return send(
         res,
         200,
         await session
          .canonicalPage
        );
       }

       if(
        typeof payload.query!==
        'string'||
        !payload.query.trim()
       ){
        return send(
         res,
         400,
         {
          error:
           'Query 不能为空。'
         }
        );
       }

       const preparedImages=imageParts(payload.images);

       const plan=await planQuery(
        payload.query.trim(),
        preparedImages
       );

       const page=await generatePage(
        payload.query.trim(),
        plan,
        preparedImages
       );

       const withProductSection=ensureProductImageSection(
        page,
        plan,
        payload.query.trim()
       );

       return send(
        res,
        200,
        await enrichProductMedia(
         withProductSection,
         plan
        )
       );
      }catch(error){
       return send(
        res,
        502,
        {
         error:
          error.name===
          'TimeoutError'
           ? '生成超时，请重试。'
           : error.message===
             'fetch failed'
             ? '无法连接模型服务。'
             : error.message
        }
       );
      }
     }
    );
   }

   const file=
    route==='/'
     ? '/index.html'
     : route;

   if(
    ![
     'GET',
     'HEAD'
    ].includes(req.method)||
    ![
     '/index.html',
     '/app.js',
     '/styles.css',
     '/product-links.css',
     '/loading.css',
     '/evidence.css',
     '/input-media.css',
     '/evaluation-cases.json'
    ].includes(file)
   ){
    res.writeHead(404);

    return res.end(
     'Not found'
    );
   }

   res.writeHead(
    200,
    {
     'Content-Type':
      mime[
       path.extname(file)
      ]||
      'application/octet-stream'
    }
   );

   if(
    req.method==='HEAD'
   ){
    return res.end();
   }

   fs.createReadStream(
    path.join(
     root,
     file
    )
   ).pipe(res);
  }
 );
}

if(require.main===module){
 createServer()
  .listen(
   Number(
    process.env.PORT
   )||3000,
   '0.0.0.0',
   ()=>{
    console.log(
     `Liquid web: http://localhost:${process.env.PORT||3000}`
    );
   }
  );
}

module.exports={
 createServer,
 parsePage,
 parsePlan,
 allowRequest
};
