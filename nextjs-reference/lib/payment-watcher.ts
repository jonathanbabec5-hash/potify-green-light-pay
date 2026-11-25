/** Worker reference: finalize only after independent, durable evidence checks. */
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { USDC } from './jupiter-compose';
export type ExpectedPayment={intentId:string;signature:string;sender:string;merchantWallet:string;reference:string;dueUsdcRaw:string};
export interface EvidenceStore {
  // Must be a DB transaction with unique (chain,signature) and intent bindings.
  recordFinalizedOnce(e:ExpectedPayment):Promise<boolean>;
  publishStatus(intentId:string,status:'CHAIN_FINALIZED'):Promise<void>;
  openException(intentId:string,reason:string):Promise<void>;
}
export async function verifyFinalizedPayment(c:Connection,e:ExpectedPayment):Promise<boolean>{
  const tx=await c.getParsedTransaction(e.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
  if(!tx||!tx.meta||tx.meta.err)return false;
  const expectedSource=getAssociatedTokenAddressSync(USDC,new PublicKey(e.sender)).toBase58();
  const expectedDestination=getAssociatedTokenAddressSync(USDC,new PublicKey(e.merchantWallet)).toBase58();
  const includesRef=tx.transaction.message.accountKeys.some(k=>k.pubkey.toBase58()===e.reference);
  const signedBySender=tx.transaction.message.accountKeys.some(k=>k.pubkey.toBase58()===e.sender&&k.signer);
  // Check the top-level transfer composed by our builder, not merely token
  // balance deltas, which can include unrelated account activity.
  const paid=tx.transaction.message.instructions.some(i=>{
    if(!('parsed' in i)||i.programId.toBase58()!==TOKEN_PROGRAM_ID.toBase58())return false;
    const p=i.parsed as {type?:string;info?:Record<string,unknown>};const info=p.info||{};
    const tokenAmount=info.tokenAmount as {amount?:string;decimals?:number}|undefined;
    return p.type==='transferChecked'&&info.source===expectedSource&&info.destination===expectedDestination&&
      info.mint===USDC.toBase58()&&info.authority===e.sender&&tokenAmount?.amount===e.dueUsdcRaw&&tokenAmount?.decimals===6;
  });
  return includesRef&&signedBySender&&paid;
}
export async function watchSignature(c:Connection,e:ExpectedPayment,store:EvidenceStore){
  // Production must also reconcile periodically; WebSocket callbacks can be lost.
  return c.onSignature(e.signature,async result=>{
    if(result.err){await store.openException(e.intentId,'chain transaction failed');return}
    try{
      if(!(await verifyFinalizedPayment(c,e))){await store.openException(e.intentId,'finalized transaction mismatch');return}
      if(await store.recordFinalizedOnce(e))await store.publishStatus(e.intentId,'CHAIN_FINALIZED');
    }catch{await store.openException(e.intentId,'verification unavailable; retry and reconcile')}
  },'finalized');
}
