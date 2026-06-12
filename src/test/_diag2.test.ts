import { describe, it } from 'vitest';
import { assembleDiagnoseRouteRows } from '@/lib/canonical/assembleDiagnoseRouteRows';
import { projectDiagnoseRoutes } from '@/lib/canonical/diagnoseAndRoute';

const BATCH='B-2026-03'; const STMT='2026-03'; const ML=['2026-01','2026-02','2026-03','2026-04']; const T='2026-04-10';
const ERICA='21277051'; const JASON='21055210';

function r(o:any){return {source_type:'',source_file_label:'',carrier:'Ambetter',applicant_name:'X',first_name:'',last_name:'',dob:null,member_id:'',policy_number:'',exchange_subscriber_id:'',exchange_policy_id:'',issuer_policy_id:'',issuer_subscriber_id:'',agent_name:'',agent_npn:'',aor_bucket:'',pay_entity:'',status:'',effective_date:'2025-12-01',premium:null,net_premium:null,commission_amount:null,eligible_for_commission:'Yes',policy_term_date:null,paid_through_date:null,broker_effective_date:null,broker_term_date:null,member_responsibility:null,on_off_exchange:'',auto_renewal:null,ede_policy_origin_type:'',ede_bucket:'',policy_modified_date:null,client_address_1:'',client_address_2:'',client_city:'',client_state_full:'FL',client_zip:'',paid_to_date:null,months_paid:null,writing_agent_carrier_id:'',member_key:'',raw_json:{},...o};}

describe('diag2', () => { it('inspect',async()=>{
  const recs=[
    // Vix anchor: a DIFFERENT member with Vix commission to enable Vix scope.
    r({source_type:'BACK_OFFICE',member_key:'VANCH',issuer_subscriber_id:'ISIDVANCH',policy_number:'POLVANCH',agent_npn:ERICA,agent_name:'Erica Fine',net_premium:100,paid_through_date:'2026-04-30',raw_json:{'Broker Name':'Erica Fine',issuer:'Ambetter','Number of Members':'1',plan_variant:'standard'},batch_id:BATCH}),
    r({source_type:'EDE',member_key:'VANCH',issuer_subscriber_id:'ISIDVANCH',policy_number:'POLVANCH',agent_npn:ERICA,net_premium:100,status:'effectuated',raw_json:{currentPolicyAOR:`Erica Fine (${ERICA})`,policyStatus:'effectuated',issuer:'Ambetter',plan_variant:'standard'},batch_id:BATCH}),
    r({source_type:'COMMISSION',member_key:'VANCH',issuer_subscriber_id:'ISIDVANCH',policy_number:'POLVANCH',pay_entity:'Vix',commission_amount:5,paid_to_date:'2026-03-31',months_paid:1,agent_npn:ERICA,batch_id:BATCH}),
    // Leak: Erica AOR, no Vix commission ever
    r({source_type:'BACK_OFFICE',member_key:'LEAK',issuer_subscriber_id:'ISIDLEAK',policy_number:'POLLEAK',agent_npn:ERICA,agent_name:'Erica Fine',net_premium:100,paid_through_date:'2026-04-30',raw_json:{'Broker Name':'Erica Fine',issuer:'Ambetter','Number of Members':'1',plan_variant:'standard'},batch_id:BATCH}),
    r({source_type:'EDE',member_key:'LEAK',issuer_subscriber_id:'ISIDLEAK',policy_number:'POLLEAK',agent_npn:ERICA,net_premium:100,status:'effectuated',raw_json:{currentPolicyAOR:`Erica Fine (${ERICA})`,policyStatus:'effectuated',issuer:'Ambetter',plan_variant:'standard'},batch_id:BATCH}),
  ];
  const out = assembleDiagnoseRouteRows({allBatchRecords:recs as any,monthList:ML,serviceMonths:[STMT],targetScopes:['Coverall','Vix'],batchMonthByBatchId:{[BATCH]:STMT},today:T,rateRows:[] as any});
  console.log('ROWS:',JSON.stringify(out.rows.map(r=>({scope:r.targetScope,month:r.serviceMonth,mk:r.stableMemberKey,key:r.rowKey})),null,2));
  const proj = await projectDiagnoseRoutes({rows: out.rows, loadDecisionIndex: async()=>({all:[],byMemberMonth:new Map(),byCarrierMember:new Map(),byPolicyMonth:new Map(),loadedAt:0} as any), forceDecisionIndex:true});
  console.log('CHASE:',JSON.stringify(proj.chaseEligible));
});});
