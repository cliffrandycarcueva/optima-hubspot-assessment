<#
.SYNOPSIS
  Starts a local n8n configured for the Optima workflows.
.DESCRIPTION
  - Reuses WEBHOOK_SECRET, HUBSPOT_PIPELINE_ID and HUBSPOT_DEAL_STAGE_ID from the repository root .env
    (unless OPTIMA_WEBHOOK_SECRET / HUBSPOT_* are already set). Values are never printed.
  - Allows Code nodes to read those variables ($env) and to use Node's crypto module.
  - Binds n8n to 127.0.0.1 only.
.PARAMETER N8nHome
  Folder where n8n is installed (npm install n8n) and where its data is kept. Default: $env:USERPROFILE\n8n-local
.PARAMETER Port
  n8n port. Default 5678.
.PARAMETER MockHubSpot
  Send all HubSpot calls and alerts to the local mock (n8n/test/mock-hubspot.mjs on port 5680) for safe testing.
.PARAMETER AlertWebhookUrl
  Destination for error notifications (Slack/Discord/Teams incoming webhook, webhook.site, ...).
.EXAMPLE
  .\n8n\start-n8n.ps1
  .\n8n\start-n8n.ps1 -MockHubSpot
  .\n8n\start-n8n.ps1 -AlertWebhookUrl 'https://hooks.example.com/your-incoming-webhook'
#>
param(
  [string]$N8nHome = (Join-Path $env:USERPROFILE 'n8n-local'),
  [int]$Port = 5678,
  [switch]$MockHubSpot,
  [string]$AlertWebhookUrl
)
$ErrorActionPreference = 'Stop'

$n8nCmd = Join-Path $N8nHome 'node_modules\.bin\n8n.cmd'
if (-not (Test-Path $n8nCmd)) { throw "n8n not found at $n8nCmd. Install it first (see n8n/README.md)." }

# Non-secret and secret settings shared with the NestJS app, read from the root .env without echoing them.
$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
$dotenv = @{}
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') { $dotenv[$Matches[1]] = $Matches[2].Trim('"').Trim("'") }
  }
}
function Use-Setting([string]$Name, [string]$FromDotenv) {
  if (-not [Environment]::GetEnvironmentVariable($Name, 'Process') -and $dotenv[$FromDotenv]) {
    [Environment]::SetEnvironmentVariable($Name, $dotenv[$FromDotenv], 'Process')
  }
}
Use-Setting 'OPTIMA_WEBHOOK_SECRET' 'WEBHOOK_SECRET'
Use-Setting 'HUBSPOT_PIPELINE_ID' 'HUBSPOT_PIPELINE_ID'
Use-Setting 'HUBSPOT_DEAL_STAGE_ID' 'HUBSPOT_DEAL_STAGE_ID'
if (-not $env:OPTIMA_WEBHOOK_SECRET) { throw 'OPTIMA_WEBHOOK_SECRET is not set and WEBHOOK_SECRET was not found in the root .env.' }

$env:N8N_USER_FOLDER = $N8nHome
$env:N8N_PORT = "$Port"
$env:N8N_LISTEN_ADDRESS = '127.0.0.1'
$env:N8N_HOST = 'localhost'
$env:WEBHOOK_URL = "http://localhost:$Port/"
$env:N8N_SECURE_COOKIE = 'false'            # plain http on localhost only
$env:N8N_BLOCK_ENV_ACCESS_IN_NODE = 'false' # Code nodes read OPTIMA_* / HUBSPOT_* via $env
$env:NODE_FUNCTION_ALLOW_BUILTIN = 'crypto' # HMAC + timingSafeEqual in the Code node
$env:N8N_DIAGNOSTICS_ENABLED = 'false'
$env:N8N_PERSONALIZATION_ENABLED = 'false'
$env:GENERIC_TIMEZONE = 'UTC'
$env:NODE_ENV = 'production'            # no stack traces in webhook error responses

if ($MockHubSpot) {
  $env:OPTIMA_HUBSPOT_BASE_URL = 'http://127.0.0.1:5680'
  if (-not $AlertWebhookUrl) { $AlertWebhookUrl = 'http://127.0.0.1:5680/__notify' }
} else {
  Remove-Item Env:OPTIMA_HUBSPOT_BASE_URL -ErrorAction SilentlyContinue
}
if ($AlertWebhookUrl) { $env:OPTIMA_ALERT_WEBHOOK_URL = $AlertWebhookUrl }

Write-Host "n8n home: $N8nHome"
Write-Host "Editor:   http://localhost:$Port"
Write-Host "Webhook:  http://localhost:$Port/webhook/optima-order (published)  |  /webhook-test/optima-order (editor test)"
Write-Host ("HubSpot:  " + $(if ($MockHubSpot) { 'LOCAL MOCK http://127.0.0.1:5680' } else { 'https://api.hubapi.com (real)' }))
Write-Host ("Alerts:   " + $(if ($env:OPTIMA_ALERT_WEBHOOK_URL) { 'configured' } else { 'not configured (error workflow will report that)' }))

# n8n 2.x needs Node.js 24+. Prefer fnm's Node 24 when the default node is older.
$major = [int]((node --version) -replace '^v(\d+).*', '$1')
if ($major -lt 24 -and (Get-Command fnm -ErrorAction SilentlyContinue)) {
  fnm exec --using=24 $n8nCmd start
} else {
  & $n8nCmd start
}
