import 'dotenv/config';
import { HubSpotService, HubSpotError } from './hubspot.service';

async function main() {
  const client = new HubSpotService();
  await client.verifyScopes();
  console.log('Contact/Deal read and write scopes: OK');
  for (const object of ['contacts', 'deals']) {
    await client.request('GET', '/crm/v3/objects/' + object + '?limit=1&properties=hs_object_id');
    console.log(object + ' read access: OK');
  }
  const account = await client.request<{ portalId: number; companyCurrency: string; additionalCurrencies: string[] }>(
    'GET', '/account-info/v3/details');
  console.log(JSON.stringify({ portalId: account.portalId, companyCurrency: account.companyCurrency,
    additionalCurrencies: account.additionalCurrencies }));
  const pipelines = await client.request<{ results: { id: string; label: string; stages: { id: string; label: string }[] }[] }>(
    'GET', '/crm/v3/pipelines/deals');
  console.log(JSON.stringify(pipelines.results.map(p => ({ id: p.id, label: p.label,
    stages: p.stages.map(s => ({ id: s.id, label: s.label })) }))));
  let property;
  try { property = await client.request<{ hasUniqueValue: boolean }>('GET', '/crm/v3/properties/deals/' + client.property); }
  catch (error) {
    if (!(error instanceof HubSpotError) || error.status !== 404 || !process.argv.includes('--create-property')) throw error;
    property = await client.request<{ hasUniqueValue: boolean }>('POST', '/crm/v3/properties/deals', {
      groupName: 'dealinformation', name: client.property, label: 'Optima order ID',
      type: 'string', fieldType: 'text', hasUniqueValue: true,
    });
  }
  if (!property.hasUniqueValue) throw new HubSpotError('unique_order_property_required');
  console.log('Unique order property: OK');
  const currency = process.argv.find(arg => arg.startsWith('--currency='))?.slice(11) ?? 'PHP';
  await client.checkConfiguration(currency);
  console.log('Configuration verified for ' + currency + '. No Contacts or Deals were changed.');
}
main().catch(error => {
  console.error(error instanceof HubSpotError ? error.message : 'HubSpot configuration check failed');
  console.error('Required: contacts/deals read+write scopes, deal schema read, schema write for property creation, valid stage, and enabled order currency.');
  process.exitCode = 1;
});
