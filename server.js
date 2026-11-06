require('dotenv').config();
const express=require('express'), multer=require('multer'), path=require('path');
const app=express();

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || 'capacitor://localhost,https://localhost,http://localhost,ionic://localhost')
    .split(',').map(x=>x.trim()).filter(Boolean)
);
app.use((req,res,next)=>{
  const origin=req.headers.origin;
  if(origin && (allowedOrigins.has(origin) || process.env.ALLOW_ANY_ORIGIN==='true')){
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  }
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({limit:'2mb'}));
app.use(express.static(path.join(__dirname,'public')));

const upload=multer({
  storage:multer.memoryStorage(),
  limits:{fileSize:10*1024*1024},
  fileFilter:(req,file,cb)=>cb(null,['image/png','image/jpeg','image/webp'].includes(file.mimetype))
});

const SYSTEM=`You are Profit Magnet, a cautious technical chart analyst. Analyze ONLY supplied screenshot or supplied OHLC candle data. Never claim access to candles or live prices not supplied. Never guess, predict, force a trade, or guarantee results. Use strict M15 SMC rules by default: identify HH/HL or LH/LL; BUY requires visible sell-side liquidity sweep, bullish displacement and BOS/CHoCH confirmed by candle CLOSE, valid retest of bullish OB/FVG, and bullish confirmation close. SELL requires the inverse: buy-side sweep, bearish displacement and bearish BOS/CHoCH candle CLOSE, valid retest, bearish confirmation close. Require premium/discount context where measurable. A wick is not a close. If any required condition is missing, ambiguous, or cannot be measured from input, return NO TRADE. Only one direction. Never invent exact entry, stop, target, price, confidence, or RR. If exact prices cannot be grounded in visible labels or provided OHLC data, say NOT VERIFIABLE and NO TRADE. Minimum RR 1:2. Output: STATUS; SYMBOL/TIMEFRAME; STRUCTURE; LIQUIDITY; BOS/CHoCH CLOSE; RETEST; ENTRY; STOP LOSS; TAKE PROFIT; RR; REASONS; INVALIDATION. Explain screenshot limitations.`;

async function askAI(input){
  if(!process.env.OPENAI_API_KEY) throw new Error('AI is not configured on the server. Add OPENAI_API_KEY to the server environment.');
  const r=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',
    headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-4.1-mini',instructions:SYSTEM,input})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message || `AI provider request failed (HTTP ${r.status}).`);
  return j.output?.flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n')||'No analysis returned.';
}

app.post('/api/analyse-image',upload.single('chart'),async(req,res)=>{
  try{
    if(!req.file)return res.status(400).json({error:'Choose a PNG, JPG or WEBP chart image.'});
    const data=`data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const analysis=await askAI([{role:'user',content:[
      {type:'input_text',text:'Analyze this uploaded chart screenshot. Read symbol and timeframe only if clearly visible. Apply strict M15 SMC rules. Do not infer unseen/live candles.'},
      {type:'input_image',image_url:data,detail:'high'}
    ]}]);
    res.json({analysis,mode:'screenshot'});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/market/candles',async(req,res)=>{
  try{
    if(!process.env.TWELVEDATA_API_KEY)
      return res.status(503).json({error:'Market data is not configured. Add TWELVEDATA_API_KEY to the backend environment.'});
    const symbol=String(req.query.symbol||'XAU/USD').slice(0,30);
    const interval=String(req.query.interval||'15min');
    if(!['1min','5min','15min','30min','1h','4h','1day'].includes(interval))
      return res.status(400).json({error:'Unsupported timeframe.'});
    const url=new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('symbol',symbol);
    url.searchParams.set('interval',interval);
    url.searchParams.set('outputsize','100');
    url.searchParams.set('apikey',process.env.TWELVEDATA_API_KEY);
    const r=await fetch(url);
    const j=await r.json().catch(()=>({}));
    if(!r.ok || j.status==='error' || !Array.isArray(j.values))
      throw new Error(j.message || `Market-data provider request failed (HTTP ${r.status}). Check the symbol, API key, and Twelve Data plan.`);
    const candles=j.values.slice().reverse().map(v=>{
      const stamp=String(v.datetime||'').replace(' ','T');
      const parsed=Date.parse(stamp.endsWith('Z')?stamp:stamp+'Z');
      return {time:Math.floor(parsed/1000),open:+v.open,high:+v.high,low:+v.low,close:+v.close,volume:+(v.volume||0)};
    }).filter(c=>Number.isFinite(c.time)&&[c.open,c.high,c.low,c.close].every(Number.isFinite));
    if(candles.length<30) throw new Error(`Provider returned only ${candles.length} valid candles; at least 30 are required.`);
    res.json({symbol,interval,candles,provider:'Twelve Data',updatedAt:new Date().toISOString()});
  }catch(e){res.status(502).json({error:e.message});}
});

app.post('/api/analyse-live',async(req,res)=>{
  try{
    const {symbol,interval,candles}=req.body||{};
    if(!Array.isArray(candles)||candles.length<30||candles.length>150)
      return res.status(400).json({error:'Provide between 30 and 150 candles.'});
    const clean=candles.map(c=>({time:c.time,open:+c.open,high:+c.high,low:+c.low,close:+c.close,volume:+c.volume}));
    if(clean.some(c=>![c.open,c.high,c.low,c.close].every(Number.isFinite)||c.high<Math.max(c.open,c.close)||c.low>Math.min(c.open,c.close)))
      return res.status(400).json({error:'Invalid OHLC data.'});
    const analysis=await askAI([{role:'user',content:`Analyze the following provider-supplied OHLC candles. Symbol: ${String(symbol||'unknown')}. Timeframe: ${String(interval||'unknown')}. Data is oldest to newest. Treat last candle as potentially still forming unless provider explicitly says closed; do not use it as candle-close confirmation. Use exact price values only if present in data, and NO TRADE if strict conditions cannot be verified. Candles JSON:\n${JSON.stringify(clean)}`}]);
    res.json({analysis,mode:'live',symbol,interval,candleCount:clean.length});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/health',(req,res)=>res.json({
  ok:true,
  app:'Profit Magnet',
  openaiConfigured:!!process.env.OPENAI_API_KEY,
  marketDataConfigured:!!process.env.TWELVEDATA_API_KEY
}));
app.listen(process.env.PORT||3000,()=>console.log('Profit Magnet backend on port '+(process.env.PORT||3000)));
