'use client';
import {useReducer} from 'react';
type State={digits:string;asset:'USD'|'USDC'|'SOL'|'POTIFY'};
type Action={type:'digit';value:string}|{type:'delete'}|{type:'asset';value:State['asset']}|{type:'clear'};
function reducer(s:State,a:Action):State{
  if(a.type==='asset')return {...s,asset:a.value};
  if(a.type==='clear')return {...s,digits:'0'};
  if(a.type==='delete')return {...s,digits:s.digits.length>1?s.digits.slice(0,-1):'0'};
  if(!/^\d{1,2}$/.test(a.value))return s;
  const next=(s.digits==='0'?'':s.digits)+a.value;
  return next.length<=9?{...s,digits:BigInt(next||'0').toString()}:s;
}
export default function AmountPad({onContinue}:{onContinue:(cents:string,asset:State['asset'])=>void}){
  const [s,dispatch]=useReducer(reducer,{digits:'0',asset:'USD'});
  const cents=BigInt(s.digits);const display=`$${cents/100n}.${String(cents%100n).padStart(2,'0')}`;
  return <section className="mx-auto max-w-sm rounded-3xl bg-[#0b1b11] p-5 text-white">
    <p className="text-center text-xs uppercase tracking-widest text-green-200">Demo amount in USD</p>
    <output aria-live="polite" className="block py-6 text-center text-6xl font-bold">{display}</output>
    <label className="block text-center">Pay with <select aria-label="Pay with" value={s.asset} onChange={e=>dispatch({type:'asset',value:e.target.value as State['asset']})} className="rounded bg-green-950 p-2">{['USD','USDC','SOL','POTIFY'].map(a=><option key={a}>{a}</option>)}</select></label>
    <div className="grid grid-cols-3 gap-2 py-4">{['1','2','3','4','5','6','7','8','9','00','0','⌫'].map(k=><button type="button" key={k} aria-label={k==='⌫'?'Delete last digit':k} className="min-h-14 rounded-xl text-2xl focus-visible:outline focus-visible:outline-white" onClick={()=>dispatch(k==='⌫'?{type:'delete'}:{type:'digit',value:k})}>{k}</button>)}</div>
    <button disabled={cents===0n} onClick={()=>onContinue(s.digits,s.asset)} className="min-h-12 w-full rounded-xl bg-lime-300 font-bold text-black disabled:opacity-40">Review demo payment</button>
    <p className="pt-3 text-xs text-green-200">Simulation only. No real balance or payment.</p>
  </section>;
}
