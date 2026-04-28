(globalThis as any).localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
import { reconcile } from '../src/lib/reconcile';
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
console.log('records:',recs.length);
try{
  const {members,debug}=reconcile(recs as any,'2026-04',null);
  console.log('members:',members.length,'inEde:',members.filter(m=>m.in_ede).length,'inBo:',members.filter(m=>m.in_back_office).length);
  console.log('estMissing populated:',members.filter(m=>m.estimated_missing_commission!=null).length);
  console.log('with null member_key:',members.filter(m=>!m.member_key).length);
  console.log('with empty member_key:',members.filter(m=>m.member_key==='').length);
}catch(e:any){console.error('THREW:',e.message);}
