import { describe, it } from 'vitest';
import { normalizeEDERow, normalizeBackOfficeRow } from '@/lib/normalize';
import { reconcile } from '@/lib/reconcile';

describe('debug', () => {
  it('logs', () => {
    const ede1 = normalizeEDERow({issuer:'Ambetter',applicantFirstName:'Primary',applicantLastName:'Match',applicantName:'Primary Match',exchangeSubscriberId:'0001111111',issuerSubscriberId:'U10000001',policyStatus:'Effectuated',effectiveDate:'2026-02-01',premium:'500'},'EDE')!;
    const bo1 = normalizeBackOfficeRow({'Broker Name':'A','Broker NPN':'12345','Policy Number':'U99999998','Insured First Name':'Primary','Insured Last Name':'Match','Broker Effective Date':'2026-01-01','Broker Term Date':'12/31/9999','Policy Effective Date':'2026-02-01','Policy Term Date':'2026-12-31','Paid Through Date':'2026-02-28','Monthly Premium Amount':'500','Exchange Subscriber ID':'0001111111','Eligible for Commission':'Yes'},'BO','Jason Fine');
    console.log('EDE:', {esid:ede1.exchange_subscriber_id, isid:ede1.issuer_subscriber_id, pn:ede1.policy_number, key:ede1.member_key});
    console.log('BO:', {esid:bo1.exchange_subscriber_id, isid:bo1.issuer_subscriber_id, pn:bo1.policy_number, key:bo1.member_key});
    const {members} = reconcile([ede1, bo1], '2026-02');
    console.log('members:', JSON.stringify(members.map(m=>({name:m.applicant_name, key:m.member_key, in_ede:m.in_ede, in_bo:m.in_back_office, notes:m.issue_notes, issue:m.issue_type})), null, 2));
  });
});
