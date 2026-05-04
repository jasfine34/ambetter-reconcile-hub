import { describe, it } from 'vitest';
import { normalizeEDERow, normalizeBackOfficeRow } from '@/lib/normalize';
import { reconcile } from '@/lib/reconcile';

describe('debug', () => {
  it('logs', () => {
    const ede1 = normalizeEDERow({issuer:'Ambetter',applicantFirstName:'Primary',applicantLastName:'Match',applicantName:'Primary Match',exchangeSubscriberId:'0001111111',issuerSubscriberId:'U10000001',policyStatus:'Effectuated',effectiveDate:'2026-02-01',premium:'500'},'EDE')!;
    const bo1 = normalizeBackOfficeRow({'Broker Name':'A','Broker NPN':'12345','Policy Number':'U99999998','Insured First Name':'Primary','Insured Last Name':'Match','Broker Effective Date':'2026-01-01','Broker Term Date':'12/31/9999','Policy Effective Date':'2026-02-01','Policy Term Date':'2026-12-31','Paid Through Date':'2026-02-28','Monthly Premium Amount':'500','Exchange Subscriber ID':'0001111111','Eligible for Commission':'Yes'},'BO','Jason Fine');
    console.log('After normalize EDE esid:', JSON.stringify(ede1.exchange_subscriber_id), 'BO esid:', JSON.stringify(bo1.exchange_subscriber_id), 'equal:', ede1.exchange_subscriber_id === bo1.exchange_subscriber_id);
    const {members, debug} = reconcile([ede1, bo1], '2026-02');
    console.log('matchByExchangeSubId:', debug.matchByExchangeSubId, 'unique keys:', debug.uniqueMemberKeys);
    console.log('members count:', members.length);
  });
});
