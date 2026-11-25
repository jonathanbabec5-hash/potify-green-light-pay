import { NextResponse } from 'next/server';

// Deliberately disabled until identity, trusted order storage, merchant policy,
// provider authorization and the RequiredPolicy implementation exist.
// A client-supplied recipient, amount or "approved" flag must never be trusted.
export async function POST(){
  return NextResponse.json({error:'LIVE_QUOTE_DISABLED',message:'Payment integrations require an approved program and independent security review.'},{status:503,headers:{'Cache-Control':'no-store'}});
}
