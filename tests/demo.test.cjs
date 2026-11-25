const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('GreenLight_Pay_Consumer_Demo.html','utf8');
const js=html.split('<script>')[1].split('</script>')[0];
const saved={};const listeners={};const nodes={app:{innerHTML:''},'modal-root':{innerHTML:'',querySelector:()=>({focus(){}})}};
const nav=['home','activity','shop','wallet','merchant'].map(page=>({dataset:{page},classList:{toggle(){}},setAttribute(){},removeAttribute(){}}));
const document={getElementById:id=>nodes[id]||null,querySelectorAll:()=>nav,querySelector:()=>null,addEventListener:(k,fn)=>listeners[k]=fn,activeElement:{tagName:'BODY'}};
const context={document,window:{scrollTo(){}},localStorage:{getItem:k=>saved[k]||null,setItem:(k,v)=>saved[k]=v},structuredClone,crypto:require('node:crypto').webcrypto,console,BigInt,Date,Math};
vm.runInNewContext(js,context,{timeout:3000});
function click(data,id=''){const el={dataset:data,id,closest(){return this}};listeners.click({target:el})}
function value(id,v){nodes[id]={value:v,textContent:''}}
function s(){return JSON.parse(saved['glp-consumer-synthetic-v1'])}
for(const k of ['1','2','0','0'])click({key:k});assert.match(nodes.app.innerHTML,/\$12\.00/);
click({action:'send'});value('recipient','$friend');click({action:'review-send'});assert.match(nodes['modal-root'].innerHTML,/\$12\.00/);
click({action:'confirm-payment'});assert.equal(s().balances.USD,'11300');assert.equal(s().events[0].label,'$friend');
click({action:'confirm-payment'});assert.equal(s().events.length,1,'duplicate payment must not post');
click({page:'shop'});click({buy:'tee'});click({action:'confirm-payment'});assert.equal(s().balances.USD,'8500');assert.equal(s().events.length,2);
click({action:'fund'});value('fund-amount','2500');value('fund-method','Apple Pay');click({action:'confirm-fund'});assert.equal(s().balances.USD,'11000');
assert.ok(s().journal.every(j=>j.entries.reduce((a,b)=>a+BigInt(b.delta),0n)===0n));
click({action:'scan'});value('qr-code','bad');nodes['form-error']={textContent:''};click({action:'read-qr'});assert.match(nodes['form-error'].textContent,/Only the sample/);
value('qr-code','GLP-DEMO:4200');click({action:'read-qr'});click({action:'confirm-payment'});assert.equal(s().balances.USD,'6800');
click({page:'home'});listeners.change({target:{id:'asset',value:'SOL'}});click({page:'shop'});click({buy:'poster'});click({action:'confirm-payment'});assert.equal(s().balances.SOL,'350000000');
click({},'about-btn');click({action:'reset'});assert.equal(s().balances.USD,'12500');assert.equal(s().events.length,0);
console.log('PASS: keypad, simulated send, duplicate prevention, purchase, add-funds, balanced ledger, QR validation, asset conversion and reset');
