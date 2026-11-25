const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('wallet-connection.js','utf8');
const ADDRESS='11111111111111111111111111111111';
const ADDRESS2='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POTIFY='GWdHGomLjqofUSrj3TEhinr2UaRJMzJ5o7MRZLaFpump';
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
function fixture({failPotify=false,reject=false,mobile=false,missing=false,solflare=false,delayFirst=false}={}){
  const events={},nodes={'live-wallet-hub':{innerHTML:''},'live-wallet-dialog':{innerHTML:''},'wallet-message':{textContent:''}};
  const doc={getElementById:id=>nodes[id]||null,addEventListener:(name,fn)=>events[name]=fn};
  const handlers={};let disconnects=0,fetchCount=0,openUrl=null,signed=false,releaseFirst=null;
  const provider={isPhantom:!solflare,isSolflare:solflare,publicKey:{toString:()=>ADDRESS},connect:async()=>{if(reject)throw {code:4001};return solflare ? undefined : {publicKey:provider.publicKey}},
    disconnect:async()=>{disconnects++},on:(name,fn)=>{handlers[name]=fn},removeListener:(name,fn)=>{if(handlers[name]===fn)delete handlers[name]},
    signTransaction:()=>{signed=true;throw Error('no transaction signing expected')}};
  function record(mint,address,program,amount,decimals){return {account:{owner:program,data:{parsed:{info:{mint,owner:address,tokenAmount:{amount,decimals}}}}}}}
  const fakeFetch=async (_url,options)=>{
    fetchCount++;const request=JSON.parse(options.body),address=request.params[0],mint=request.params[1]?.mint;
    if(mint===POTIFY&&failPotify)throw Error('rate limited');
    if(delayFirst&&mint===POTIFY&&address===ADDRESS)await new Promise(resolve=>{releaseFirst=resolve});
    let result=request.method==='getBalance'?{value:address===ADDRESS2?9870000000:1230000000}:mint===USDC?{value:[record(mint,address,TOKEN,'1000000',6),record(mint,address,TOKEN,'2500000',6)]}:{value:[record(mint,address,TOKEN22,'42000000',6)]};
    return {ok:true,json:async()=>({id:request.id,result})};
  };
  const window={phantom:missing||solflare?undefined:{solana:provider},solflare:!missing&&solflare?provider:undefined,location:{assign:url=>openUrl=url}};
  const context={window,document:doc,navigator:{userAgent:mobile?'iPhone':'desktop',clipboard:{writeText:async()=>{}}},
    location:{protocol:'https:',origin:'https://glp.example',pathname:'/pay',search:'?secret=ignored',hash:'#private'},
    fetch:fakeFetch,AbortController,setTimeout,clearTimeout,BigInt,Promise,Set,Number,String,console};
  vm.runInNewContext(source,context);
  const click=action=>{const el={dataset:{liveAction:action},closest(){return this}};events.click({target:el})};
  const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve))};
  return {nodes,provider,handlers,click,tick,emit:(name,value)=>handlers[name]?.(value),release:()=>releaseFirst?.(),get fetchCount(){return fetchCount},get disconnects(){return disconnects},get openUrl(){return openUrl},get signed(){return signed}};
}
(async()=>{
  const f=fixture();assert.equal(f.fetchCount,0,'no RPC call without user connection');
  f.click('details');f.click('connect-phantom');await f.tick();
  assert.match(f.nodes['live-wallet-hub'].innerHTML,/Phantom/);assert.match(f.nodes['live-wallet-dialog'].innerHTML,/1\.23 SOL/);
  assert.match(f.nodes['live-wallet-dialog'].innerHTML,/3\.5 USDC/);assert.match(f.nodes['live-wallet-dialog'].innerHTML,/42 \$POTIFY/);
  assert.equal(f.fetchCount,3);assert.equal(f.signed,false,'wallet connection must never sign');
  f.emit('accountChanged',{toString:()=>ADDRESS2});await f.tick();assert.match(f.nodes['live-wallet-dialog'].innerHTML,new RegExp(ADDRESS2));
  f.click('disconnect');await f.tick();assert.equal(f.disconnects,1);assert.match(f.nodes['live-wallet-hub'].innerHTML,/Connect Phantom or Solflare/);assert.equal(f.handlers.accountChanged,undefined);
  const g=fixture({failPotify:true});g.click('details');g.click('connect-phantom');await g.tick();assert.match(g.nodes['live-wallet-dialog'].innerHTML,/Unavailable/);assert.doesNotMatch(g.nodes['live-wallet-dialog'].innerHTML,/>0 \$POTIFY</);
  const h=fixture({reject:true});h.click('details');h.click('connect-phantom');await h.tick();assert.match(h.nodes['wallet-message'].textContent,/declined/);assert.equal(h.fetchCount,0);
  const m=fixture({mobile:true,missing:true});m.click('details');m.click('connect-phantom');assert.match(m.openUrl,/^https:\/\/phantom\.com\/ul\/browse\//);assert.doesNotMatch(m.openUrl,/secret|private/);
  const sf=fixture({solflare:true});sf.click('details');sf.click('connect-solflare');await sf.tick();assert.match(sf.nodes['live-wallet-hub'].innerHTML,/Solflare/);assert.match(sf.nodes['live-wallet-dialog'].innerHTML,/1\.23 SOL/);sf.emit('disconnect');assert.match(sf.nodes['live-wallet-hub'].innerHTML,/Connect Phantom or Solflare/);
  const sm=fixture({mobile:true,missing:true,solflare:true});sm.click('details');sm.click('connect-solflare');assert.match(sm.openUrl,/^https:\/\/solflare\.com\/ul\/v1\/browse\//);
  const race=fixture({delayFirst:true});race.click('details');race.click('connect-phantom');await race.tick();race.emit('accountChanged',{toString:()=>ADDRESS2});await race.tick();assert.match(race.nodes['live-wallet-dialog'].innerHTML,/9\.87 SOL/);race.release();await race.tick();assert.match(race.nodes['live-wallet-dialog'].innerHTML,/9\.87 SOL/);assert.doesNotMatch(race.nodes['live-wallet-dialog'].innerHTML,/1\.23 SOL/);
  console.log('PASS: consent-triggered connection, live balance parsing, Token-2022, account change, disconnect, partial RPC failure, rejection, mobile browse and no signing');
})().catch(e=>{console.error(e);process.exitCode=1});
