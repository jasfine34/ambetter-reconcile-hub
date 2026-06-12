import { describe, it } from 'vitest';
import { assembleCommissionSubmission } from '@/lib/canonical/assembleCommissionSubmission';
import type { NormalizedRecord } from '@/lib/normalize';

const BATCH = 'B-2026-03';
const STMT_MONTH = '2026-03';
const MONTH_LIST = ['2026-01', '2026-02', '2026-03', '2026-04'];
const TODAY = '2026-04-10';
const ERICA_NPN = '21277051';
const JASON_NPN = '21055210';

function rec(over: any): NormalizedRecord {
  return { source_type:'', source_file_label:'', carrier:'Ambetter', applicant_name:'X', first_name:'', last_name:'', dob:null, member_id:'', policy_number:'', exchange_subscriber_id:'', exchange_policy_id:'', issuer_policy_id:'', issuer_subscriber_id:'', agent_name:'', agent_npn:'', aor_bucket:'', pay_entity:'', status:'', effective_date:'2025-12-01', premium:null, net_premium:null, commission_amount:null, eligible_for_commission:'Yes', policy_term_date:null, paid_through_date:null, broker_effective_date:null, broker_term_date:null, member_responsibility:null, on_off_exchange:'', auto_renewal:null, ede_policy_origin_type:'', ede_bucket:'', policy_modified_date:null, client_address_1:'', client_address_2:'', client_city:'', client_state_full:'FL', client_zip:'', paid_to_date:null, months_paid:null, writing_agent_carrier_id:'', member_key:'', raw_json:{}, ...over } as any;
}

describe('diag', () => {
  it('inspect', async () => {
    const recs: NormalizedRecord[] = [
      rec({source_type:'BACK_OFFICE',member_key:'LEAK',issuer_subscriber_id:'ISIDLEAK',policy_number:'POLLEAK',agent_npn:ERICA_NPN,agent_name:'Erica Fine',net_premium:100,paid_through_date:'2026-04-30',raw_json:{'Broker Name':'Erica Fine',issuer:'Ambetter','Number of Members':'1',plan_variant:'standard'},batch_id:BATCH}),
      rec({source_type:'EDE',member_key:'LEAK',issuer_subscriber_id:'ISIDLEAK',policy_number:'POLLEAK',agent_npn:ERICA_NPN,net_premium:100,status:'effectuated',raw_json:{currentPolicyAOR:`Erica Fine (${ERICA_NPN})`,policyStatus:'effectuated',issuer:'Ambetter',plan_variant:'standard'},batch_id:BATCH}),
      // anchor
      rec({source_type:'BACK_OFFICE',member_key:'ANCHOR',issuer_subscriber_id:'ISIDANCHOR',policy_number:'POLANCHOR',agent_npn:JASON_NPN,agent_name:'Jason Fine',net_premium:100,paid_through_date:'2026-04-30',raw_json:{'Broker Name':'Jason Fine',issuer:'Ambetter','Number of Members':'1',plan_variant:'standard'},batch_id:BATCH}),
      rec({source_type:'EDE',member_key:'ANCHOR',issuer_subscriber_id:'ISIDANCHOR',policy_number:'POLANCHOR',agent_npn:JASON_NPN,net_premium:100,status:'effectuated',raw_json:{currentPolicyAOR:'Jason Fine (21055210)',policyStatus:'effectuated',issuer:'Ambetter',plan_variant:'standard'},batch_id:BATCH}),
      rec({source_type:'COMMISSION',member_key:'ANCHOR',issuer_subscriber_id:'ISIDANCHOR',policy_number:'POLANCHOR',pay_entity:'Coverall',commission_amount:1,paid_to_date:'2026-03-31',months_paid:1,agent_npn:JASON_NPN,batch_id:BATCH}),
    ];
    const out = await assembleCommissionSubmission({
      allBatchRecords: recs,
      monthList: MONTH_LIST,
      serviceMonths: [STMT_MONTH],
      targetScopes: ['Coverall','Vix'],
      batchMonthByBatchId: {[BATCH]: STMT_MONTH},
      today: TODAY,
      rateRows: [{id:'r',rate_key:'ambetter|FL|standard|2026',carrier_key:'ambetter',carrier_display:'Ambetter',state_code:'FL',plan_variant:'standard',comp_basis:'pmpm',calculation_basis:'per_member_pmpm',rate_value:25,rate_unit:'USD',member_min:null,member_max:null,member_cap:null,effective_year:2026,support_status:'supported',unsupported_reason:null}] as any,
      loadDecisionIndex: async () => ({all:[],byMemberMonth:new Map(),byCarrierMember:new Map(),byPolicyMonth:new Map(),loadedAt:0} as any),
    });
    console.log('ROWS:', JSON.stringify(out.rows.map(r=>({scope:r.grainKey.targetScope, mk:r.grainKey.stableMemberKey, mm:r.missingMonths})), null, 2));
    console.log('DIAG:', JSON.stringify({vixRows:out.diagnostics.vixScopeExcludedRows, vixMembers:out.diagnostics.vixScopeExcludedMembers, list:out.diagnostics.vixScopeExcludedMemberList}, null, 2));
  });
});
