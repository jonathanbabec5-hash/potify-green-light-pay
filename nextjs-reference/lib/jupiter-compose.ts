/**
 * DESIGN REFERENCE ONLY. This module does not authorize a payment. Its policy
 * implementation is intentionally absent; the HTTP routes fail closed.
 * Verify all Jupiter data, program accounts, mint extensions and deployment
 * assumptions with a security review before connecting any real wallet.
 * Documentation: https://developers.jup.ag/docs/swap/build
 */
import {
  ComputeBudgetProgram, Connection, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

export const POTIFY = new PublicKey('GWdHGomLjqofUSrj3TEhinr2UaRJMzJ5o7MRZLaFpump');
export const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
type ApiInstruction = {programId:string;accounts:{pubkey:string;isSigner:boolean;isWritable:boolean}[];data:string};
type JupiterBuild = {
  inputMint:string;outputMint:string;inAmount:string;outAmount:string;
  otherAmountThreshold:string;swapMode:string;slippageBps:number;priceImpactPct:string;
  transactionVersion:number;computeBudgetInstructions:ApiInstruction[];
  setupInstructions:ApiInstruction[];swapInstruction:ApiInstruction;
  cleanupInstruction:ApiInstruction|null;otherInstructions:ApiInstruction[];
  tipInstruction:ApiInstruction|null;addressesByLookupTableAddress:Record<string,string[]>|null;
};
export type LockedIntent = {
  id:string;sender:string;merchantWallet:string;reference:string;
  inputRaw:string;dueUsdcRaw:string;slippageBps:number;expiresAtMs:number;
};
export interface RequiredPolicy {
  // MUST independently validate auth, role, merchant, category, network, amount,
  // destination, risk/partner approval and intent state from trusted storage.
  assertIntent(intent:LockedIntent):Promise<void>;
  // MUST inspect every instruction/program/account/compute fee, enforce the
  // exact output token account, source, signer, mint and allowable route.
  // The API response is untrusted. A blank or no-op implementation is unsafe.
  assertPlan(plan:JupiterBuild,intent:LockedIntent,userUsdcAta:PublicKey):Promise<void>;
}
function ix(a:ApiInstruction):TransactionInstruction {
  return new TransactionInstruction({programId:new PublicKey(a.programId),
    keys:a.accounts.map(k=>({pubkey:new PublicKey(k.pubkey),isSigner:k.isSigner,isWritable:k.isWritable})),
    data:Buffer.from(a.data,'base64')});
}
function unsignedInt(s:string):bigint {
  if(!/^[0-9]{1,30}$/.test(s)) throw Error('Invalid integer amount');
  const n=BigInt(s); if(n<=0n) throw Error('Amount must be positive'); return n;
}

export async function quoteAndBuildAtomicPayment(
  intent:LockedIntent, connection:Connection, jupiterKey:string, policy:RequiredPolicy,
) {
  if(Date.now()>=intent.expiresAtMs) throw Error('Intent expired');
  if(!Number.isInteger(intent.slippageBps)||intent.slippageBps<0||intent.slippageBps>100)
    throw Error('Slippage exceeds example cap');
  const input=unsignedInt(intent.inputRaw),due=unsignedInt(intent.dueUsdcRaw);
  const sender=new PublicKey(intent.sender),merchant=new PublicKey(intent.merchantWallet);
  const ref=new PublicKey(intent.reference);
  await policy.assertIntent(intent);
  const userUsdc=getAssociatedTokenAddressSync(USDC,sender);
  const merchantUsdc=getAssociatedTokenAddressSync(USDC,merchant);
  const query=new URLSearchParams({inputMint:POTIFY.toBase58(),outputMint:USDC.toBase58(),
    amount:input.toString(),taker:sender.toBase58(),destinationTokenAccount:userUsdc.toBase58(),
    slippageBps:String(intent.slippageBps),transactionVersion:'0'});
  const response=await fetch(`https://api.jup.ag/swap/v2/build?${query}`,{
    headers:{'x-api-key':jupiterKey},cache:'no-store',signal:AbortSignal.timeout(10000)});
  if(!response.ok) throw Error(`Quote unavailable (${response.status})`);
  const plan=await response.json() as JupiterBuild;
  if(plan.inputMint!==POTIFY.toBase58()||plan.outputMint!==USDC.toBase58()||
    plan.inAmount!==input.toString()||plan.swapMode!=='ExactIn'||
    plan.transactionVersion!==0||plan.slippageBps!==intent.slippageBps||
    unsignedInt(plan.otherAmountThreshold)<due) throw Error('Quote does not satisfy locked intent');
  // Even a validated minimum is insufficient unless the actual swap output is
  // delivered to userUsdc. The independent plan review must verify that fact.
  await policy.assertPlan(plan,intent,userUsdc);
  const createSender=createAssociatedTokenAccountIdempotentInstruction(sender,userUsdc,sender,USDC);
  const createMerchant=createAssociatedTokenAccountIdempotentInstruction(sender,merchantUsdc,merchant,USDC);
  const pay=createTransferCheckedInstruction(userUsdc,USDC,merchantUsdc,sender,due,6,[],TOKEN_PROGRAM_ID);
  // Solana Pay-style order reference is public; it must contain no personal data.
  pay.keys.push({pubkey:ref,isSigner:false,isWritable:false});
  const instructions=[createSender,...plan.setupInstructions.map(ix),ix(plan.swapInstruction),
    createMerchant,pay,...(plan.cleanupInstruction?[ix(plan.cleanupInstruction)]:[]),
    ...plan.otherInstructions.map(ix),...(plan.tipInstruction?[ix(plan.tipInstruction)]:[])];
  const tables=await Promise.all(Object.keys(plan.addressesByLookupTableAddress||{}).map(async k=>{
    const result=await connection.getAddressLookupTable(new PublicKey(k));
    if(!result.value)throw Error('Address lookup table unavailable');return result.value;
  }));
  const {blockhash,lastValidBlockHeight}=await connection.getLatestBlockhash('confirmed');
  const make=(limit:number)=>new VersionedTransaction(new TransactionMessage({payerKey:sender,
    recentBlockhash:blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:limit}),
      ...plan.computeBudgetInstructions.map(ix),...instructions]}).compileToV0Message(tables));
  const sim=await connection.simulateTransaction(make(1_400_000),{sigVerify:false});
  if(sim.value.err)throw Error('Transaction simulation failed');
  const limit=Math.min(1_400_000,Math.ceil((sim.value.unitsConsumed||1_400_000)*1.2));
  const tx=make(limit);const bytes=tx.serialize();
  if(bytes.length>1232)throw Error('Transaction exceeds v0 size limit; do not split atomic payment');
  return {intentId:intent.id,unsignedTransaction:Buffer.from(bytes).toString('base64'),
    quote:{inputRaw:plan.inAmount,expectedUsdcRaw:plan.outAmount,minimumUsdcRaw:plan.otherAmountThreshold,
      dueUsdcRaw:due.toString(),slippageBps:plan.slippageBps,priceImpactPct:plan.priceImpactPct},
    blockhash,lastValidBlockHeight,expiresAtMs:intent.expiresAtMs};
}
