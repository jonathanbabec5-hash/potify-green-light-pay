'use client';
import {useState} from 'react';
import AmountPad from '../components/AmountPad';
export default function Page(){
  const [review,setReview]=useState<{cents:string;asset:string}|null>(null);
  return <main className="mx-auto min-h-screen max-w-lg px-5 py-6"><header className="pb-5 text-xl font-black">GREEN <span className="text-lime-300">LIGHT</span> PAY</header>
    <p className="mb-5 rounded-xl border border-green-800 bg-green-950 p-3 text-xs">SIMULATION ONLY. No real balances, provider integration or payments.</p>
    <AmountPad onContinue={(cents,asset)=>setReview({cents,asset})}/>
    {review&&<section role="dialog" aria-label="Demo payment review" className="mt-5 rounded-2xl border border-green-800 p-5"><h2 className="text-lg font-bold">Demo payment review</h2><p className="py-2 text-sm">{review.cents} cents using {review.asset}. Live quoting, wallet signing and payment execution remain disabled.</p><button className="min-h-12 rounded-xl bg-lime-300 px-4 font-bold text-black" onClick={()=>setReview(null)}>Close</button></section>}
    <p className="mt-6 text-xs text-green-200">See the standalone HTML demo for the full local purchase and activity simulation.</p></main>
}
