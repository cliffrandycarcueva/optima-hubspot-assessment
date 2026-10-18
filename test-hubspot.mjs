import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

// Requires Node.js 22+. Load .env beside this script without logging its contents.
async function main() {
  try {
    loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)));
  } catch {
    console.error('Unable to load the local .env file.');
    process.exitCode = 1;
    return;
  }

  const token = process.env.HUBSPOT_ACCESS_TOKEN?.trim();
  if (!token) {
    console.error('HUBSPOT_ACCESS_TOKEN is missing or empty.');
    process.exitCode = 1;
    return;
  }

  try {
    const response = await fetch(
      'https://api.hubapi.com/crm/v3/objects/contacts?limit=5',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      },
    );

    console.log(`HTTP status: ${response.status}`);

    if (!response.ok) {
      if (response.status === 401) {
        console.error('Authentication failed. Check HUBSPOT_ACCESS_TOKEN.');
      } else if (response.status === 403) {
        console.error('Access denied. Check the token permissions for reading contacts.');
      } else {
        console.error('HubSpot request failed.');
      }
      console.log('Contacts returned: unavailable (request failed)');
      process.exitCode = 1;
      return;
    }

    const data = await response.json();
    if (!Array.isArray(data.results)) {
      console.error('Unexpected HubSpot response: contacts list is missing.');
      process.exitCode = 1;
      return;
    }
    console.log(`Contacts returned: ${data.results.length}`);
  } catch {
    // Do not log raw errors, response bodies, headers, or contact details.
    console.error('Could not complete the HubSpot request (network, timeout, or invalid response).');
    process.exitCode = 1;
  }
}

await main();
