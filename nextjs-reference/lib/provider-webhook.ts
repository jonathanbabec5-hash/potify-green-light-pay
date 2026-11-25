import {createHmac,timingSafeEqual} from 'node:crypto';
/** Example format only: use the selected provider's exact authentication format. */
export function validHmac(rawBody:Buffer,timestamp:string,signatureHex:string,secret:string,now=Date.now()):boolean{
  if(!/^\d{1,13}$/.test(timestamp)||!/^([a-f0-9]{64})$/i.test(signatureHex))return false;
  if(Math.abs(now-Number(timestamp)*1000)>300_000)return false;
  const expected=createHmac('sha256',secret).update(timestamp+'.').update(rawBody).digest();
  const supplied=Buffer.from(signatureHex,'hex');
  return supplied.length===expected.length&&timingSafeEqual(expected,supplied);
}
// Persist provider event ID in a unique inbox record before processing, commit
// status + outbox atomically, and reconcile missing or out-of-order events.
