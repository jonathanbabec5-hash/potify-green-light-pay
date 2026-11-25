import { NextResponse } from 'next/server';

// The server must not hold or create a customer private key. An eventual route
// would accept a wallet-signed transaction only after authenticating the user,
// binding it byte-for-byte to the stored intent, checking expiry, signatures,
// programs and destinations, and using a durable idempotency/outbox transaction.
export async function POST(){
  return NextResponse.json({error:'LIVE_EXECUTION_DISABLED',message:'No wallet signing, broadcasting or real payments are enabled.'},{status:503,headers:{'Cache-Control':'no-store'}});
}
