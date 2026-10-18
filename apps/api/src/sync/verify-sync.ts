import assert from 'node:assert/strict';
import source from '../database/data-source';
import { HubSpotService, HubSpotError } from '../hubspot/hubspot.service';

async function main() {
  const orderId = process.argv[2];
  if (!orderId) throw new Error('Order ID required');
  await source.initialize();
  try {
    const [order] = await source.query('SELECT * FROM public.orders WHERE order_id=$1', [orderId]);
    assert.ok(order && order.status === 'synced', 'Order is not synced; inspect orders.last_error');
    assert.ok(order.hubspot_contact_id && order.hubspot_deal_id && order.synced_at);
    const client = new HubSpotService();
    await client.checkConfiguration(order.payload.currency);
    const contact = await client.request<{ id: string; properties: { email: string } }>(
      'GET', '/crm/v3/objects/contacts/' + order.hubspot_contact_id + '?properties=email');
    assert.equal(contact.properties.email.toLowerCase(), order.payload.customer.email.toLowerCase());
    const deal = await client.findDeal(orderId);
    assert.equal(deal?.id, order.hubspot_deal_id);
    const details = await client.request<{ properties: Record<string, string> }>('GET',
      '/crm/v3/objects/deals/' + order.hubspot_deal_id +
      '?properties=amount,deal_currency_code,pipeline,dealstage,closedate');
    assert.equal(Number(details.properties.amount), order.payload.total);
    assert.equal(details.properties.deal_currency_code, order.payload.currency);
    assert.equal(details.properties.pipeline, process.env.HUBSPOT_PIPELINE_ID);
    assert.equal(details.properties.dealstage, process.env.HUBSPOT_DEAL_STAGE_ID);
    assert.equal(new Date(details.properties.closedate).getTime(), new Date(order.payload.created_at).getTime());
    await client.verifyAssociation(order.hubspot_deal_id, order.hubspot_contact_id);
    const attempts = await source.query(
      "SELECT id FROM public.sync_attempts WHERE order_id=$1 AND status='succeeded' AND hubspot_contact_id=$2 AND hubspot_deal_id=$3 AND finished_at IS NOT NULL",
      [orderId, order.hubspot_contact_id, order.hubspot_deal_id]);
    assert.ok(attempts.length > 0);
    const account = await client.request<{ portalId: number }>('GET', '/account-info/v3/details');
    console.log(JSON.stringify({ status: 'verified', contactId: order.hubspot_contact_id, dealId: order.hubspot_deal_id }));
    console.log('Contact: https://app.hubspot.com/contacts/' + account.portalId + '/record/0-1/' + order.hubspot_contact_id);
    console.log('Deal: https://app.hubspot.com/contacts/' + account.portalId + '/record/0-3/' + order.hubspot_deal_id);
  } finally { await source.destroy(); }
}
main().catch(error => {
  console.error(error instanceof HubSpotError ? error.message : 'Sync verification failed; check order state, remote properties, and successful attempt.');
  process.exitCode = 1;
});
