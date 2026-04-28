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
const {members}=reconcile(recs as any,'2026-04',null);
console.log('members:',members.length);
const m=members[0];
const row={batch_id:batchId,member_key:m.member_key,carrier:m.carrier,applicant_name:m.applicant_name,dob:m.dob,policy_number:m.policy_number,exchange_subscriber_id:m.exchange_subscriber_id,exchange_policy_id:m.exchange_policy_id,issuer_policy_id:m.issuer_policy_id,issuer_subscriber_id:m.issuer_subscriber_id,agent_name:m.agent_name,agent_npn:m.agent_npn,aor_bucket:m.aor_bucket,current_policy_aor:m.current_policy_aor||null,expected_pay_entity:m.expected_pay_entity,actual_pay_entity:m.actual_pay_entity,in_ede:m.in_ede,in_back_office:m.in_back_office,in_commission:m.in_commission,eligible_for_commission:m.eligible_for_commission,premium:m.premium,net_premium:m.net_premium,actual_commission:m.actual_commission,positive_commission:m.positive_commission,clawback_amount:m.clawback_amount,estimated_missing_commission:m.estimated_missing_commission,issue_type:m.issue_type,issue_notes:m.issue_notes,is_in_expected_ede_universe:m.is_in_expected_ede_universe??false,expected_ede_effective_month:m.expected_ede_effective_month||null};
console.log('row:',JSON.stringify(row,null,2));
const {error}=await sb.from('reconciled_members').insert([row]);
console.log('insert error:',error);
if(!error){await sb.from('reconciled_members').delete().eq('batch_id',batchId).eq('member_key',m.member_key);}
