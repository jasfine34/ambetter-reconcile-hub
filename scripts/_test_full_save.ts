import { reconcile } from '../src/lib/reconcile';
import { saveReconciledMembers } from '../src/lib/persistence';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const batchId='652750c4-ec2f-4a48-b7fa-16bd4d29bd09';
async function fetchAll() {
  const all:any[]=[]; let from=0; const PAGE=1000;
  while(true){
    const {data,error}=await sb.from('normalized_records').select('*').eq('batch_id',batchId).is('superseded_at',null).range(from,from+PAGE-1);
    if(error)throw error; if(!data||data.length===0)break;
    all.push(...data); if(data.length<PAGE)break; from+=PAGE;
  }
  return all;
}
const recs=await fetchAll();
const {members}=reconcile(recs as any,'2026-04',null);
console.log('members:',members.length,'estMissing populated:',members.filter(m=>m.estimated_missing_commission!=null).length);
try{
  await saveReconciledMembers(batchId,members);
  console.log('save: OK');
  const {count}=await sb.from('reconciled_members').select('*',{count:'exact',head:true}).eq('batch_id',batchId);
  console.log('count after:',count);
}catch(e:any){console.error('save FAILED:',e.message,e.code,e.details);}
