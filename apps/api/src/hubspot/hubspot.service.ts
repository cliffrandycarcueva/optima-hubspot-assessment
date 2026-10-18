import { Injectable } from '@nestjs/common';
import { OrderCreatedDto } from '../webhooks/order-created.dto';
import { BackoffPolicy, TRANSIENT_STATUSES, backoffDelay, httpRetryPolicy, parseRetryAfter } from './retry';

export class HubSpotError extends Error {
  constructor(readonly code: string, readonly status?: number, readonly retryAfter?: string) {
    super('HubSpot ' + code + (status ? ' (HTTP ' + status + ')' : '') +
      (retryAfter ? '; Retry-After=' + retryAfter : ''));
  }

  /** Temporary failures that may succeed later: 429, 500, 502, 503, 504, network errors and timeouts. */
  get transient(): boolean {
    return this.code === 'network_or_timeout' || TRANSIENT_STATUSES.has(this.status ?? 0);
  }

  noteTries(tries: number): void {
    if (tries > 1) this.message += '; gave up after ' + tries + ' HTTP tries';
  }
}
type RecordResult = { id: string; properties?: Record<string, string> };
type List<T> = { results: T[]; paging?: { next?: { after: string } } };

@Injectable()
export class HubSpotService {
  private readonly origin = 'https://api.hubapi.com';
  /** Replaceable in tests so retries run without real waiting. */
  policy: BackoffPolicy = httpRetryPolicy();
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  random: () => number = Math.random;

  /**
   * Sends a request, retrying transient failures with bounded exponential backoff.
   * Pass retry: false for non-idempotent creates; those go through retrying() with a
   * reconciliation lookup instead, so an ambiguous failure is never blindly repeated.
   */
  async request<T>(method: string, path: string, body?: unknown, options: { retry?: boolean } = {}): Promise<T> {
    const send = () => this.send<T>(method, path, body);
    return options.retry === false ? send() : this.retrying(send);
  }

  /**
   * Retries transient HubSpotErrors up to policy.maxAttempts total tries. Before each repeat,
   * `reconcile` (if given) checks whether the previous try actually succeeded remotely.
   */
  async retrying<T>(operation: () => Promise<T>, reconcile?: () => Promise<T | null>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof HubSpotError) || !error.transient) throw error;
        const delay = this.retryDelay(error, attempt);
        if (attempt >= this.policy.maxAttempts || delay === null) {
          error.noteTries(attempt);
          throw error;
        }
        await this.sleep(delay);
        if (reconcile) {
          const existing = await reconcile();
          if (existing !== null) return existing;
        }
      }
    }
  }

  /** Retry-After wins when present; a wait longer than maxDelayMs is left to durable order-level retry. */
  retryDelay(error: HubSpotError, attempt: number): number | null {
    const retryAfter = parseRetryAfter(error.retryAfter);
    if (retryAfter === null) return backoffDelay(attempt, this.policy, this.random);
    return retryAfter > this.policy.maxDelayMs ? null : retryAfter;
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) throw new HubSpotError('missing_access_token');
    let response: Response;
    try {
      response = await fetch(this.origin + path, {
        method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      // A write may have succeeded remotely. Never repeat a create blindly.
      throw new HubSpotError('network_or_timeout');
    }
    if (!response.ok) {
      const code = response.status === 401 ? 'authentication_failed'
        : response.status === 403 ? 'missing_permissions'
        : response.status === 429 ? 'rate_limited'
        : response.status >= 500 ? 'server_error'
        : response.status === 409 ? 'conflict'
        : response.status === 404 ? 'not_found' : 'validation_or_request_failed';
      const retry = response.headers.get('retry-after');
      const safeRetry = retry && (/^\d+$/.test(retry) || !Number.isNaN(Date.parse(retry)))
        ? retry.slice(0, 64) : undefined;
      // Never persist HubSpot response bodies: they can echo credentials or PII.
      throw new HubSpotError(code, response.status, safeRetry);
    }
    if (response.status === 204) return undefined as T;
    try { return await response.json() as T; }
    catch { throw new HubSpotError('invalid_response'); }
  }

  private id(record: RecordResult): string {
    if (!record || typeof record.id !== 'string' || !/^\d+$/.test(record.id)) {
      throw new HubSpotError('invalid_record_id');
    }
    return record.id;
  }

  get property(): string {
    const value = process.env.HUBSPOT_ORDER_ID_PROPERTY ?? 'optima_order_id';
    if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new HubSpotError('invalid_order_property_configuration');
    return value;
  }

  async verifyScopes(): Promise<void> {
    const info = await this.request<{ scopes: string[] }>('POST', '/oauth/v2/private-apps/get/access-token-info', {
      tokenKey: process.env.HUBSPOT_ACCESS_TOKEN,
    });
    const required = ['crm.objects.contacts.read', 'crm.objects.contacts.write',
      'crm.objects.deals.read', 'crm.objects.deals.write'];
    const missing = required.filter(scope => !info.scopes?.includes(scope));
    if (missing.length) throw new HubSpotError('missing_scopes:' + missing.join(','));
  }

  async checkConfiguration(currency: string): Promise<void> {
    await this.verifyScopes();
    const pipelineId = process.env.HUBSPOT_PIPELINE_ID;
    const stageId = process.env.HUBSPOT_DEAL_STAGE_ID;
    if (!pipelineId || !stageId) throw new HubSpotError('pipeline_and_stage_configuration_required');
    let property;
    try {
      property = await this.request<{ hasUniqueValue: boolean; type: string }>(
        'GET', '/crm/v3/properties/deals/' + this.property);
    } catch (error) {
      if (error instanceof HubSpotError && error.status === 404) throw new HubSpotError('unique_order_property_missing', 404);
      throw error;
    }
    if (!property.hasUniqueValue || property.type !== 'string') {
      throw new HubSpotError('unique_text_order_property_required');
    }
    const pipeline = await this.request<{ stages: { id: string }[] }>(
      'GET', '/crm/v3/pipelines/deals/' + encodeURIComponent(pipelineId));
    if (!pipeline.stages?.some(stage => stage.id === stageId)) throw new HubSpotError('invalid_pipeline_stage');
    const account = await this.request<{ companyCurrency: string; additionalCurrencies: string[] }>(
      'GET', '/account-info/v3/details');
    if (![account.companyCurrency, ...(account.additionalCurrencies ?? [])].includes(currency)) {
      throw new HubSpotError('order_currency_not_enabled');
    }
  }

  async findContact(email: string): Promise<RecordResult | null> {
    const found = await this.request<List<RecordResult>>('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email'], limit: 2,
    });
    if (found.results.length > 1) throw new HubSpotError('ambiguous_contact');
    if (found.results.length === 1) return found.results[0];
    // Search indexes may lag behind creation; email is also a direct identifier.
    try {
      return await this.request<RecordResult>('GET', '/crm/v3/objects/contacts/' +
        encodeURIComponent(email) + '?idProperty=email&properties=email');
    } catch (error) {
      if (error instanceof HubSpotError && error.status === 404) return null;
      throw error;
    }
  }

  async syncContact(payload: OrderCreatedDto, checkpoint: (id: string) => Promise<void> = async () => {}): Promise<string> {
    const email = payload.customer.email.toLowerCase();
    const properties = {
      email, firstname: payload.customer.first_name, lastname: payload.customer.last_name,
      ...(payload.customer.phone === undefined ? {} : { phone: payload.customer.phone }),
    };
    let contact = await this.findContact(email);
    if (!contact) {
      try {
        // HubSpot enforces unique Contact emails: after an ambiguous failure, look the
        // email up before creating again.
        contact = await this.retrying(
          () => this.request<RecordResult>('POST', '/crm/v3/objects/contacts', { properties }, { retry: false }),
          () => this.findContact(email));
        const id = this.id(contact);
        await checkpoint(id);
        return id;
      } catch (error) {
        if (!(error instanceof HubSpotError) || error.status !== 409) throw error;
        // Another order for this email may have created the contact concurrently.
        contact = await this.findContact(email);
        if (!contact) throw error;
      }
    }
    const id = this.id(contact);
    await checkpoint(id);
    await this.request('PATCH', '/crm/v3/objects/contacts/' + id, { properties });
    return id;
  }

  async findDeal(orderId: string): Promise<RecordResult | null> {
    try {
      return await this.request<RecordResult>('GET', '/crm/v3/objects/deals/' +
        encodeURIComponent(orderId) + '?idProperty=' + this.property + '&properties=' + this.property);
    } catch (error) {
      if (error instanceof HubSpotError && error.status === 404) return null;
      throw error;
    }
  }

  async ensureDeal(payload: OrderCreatedDto, knownId: string | null): Promise<string> {
    const found = await this.findDeal(payload.order_id);
    if (found) {
      const id = this.id(found);
      if (found.properties?.[this.property] !== payload.order_id || (knownId && id !== knownId)) {
        throw new HubSpotError('deal_order_reference_mismatch');
      }
      return id;
    }
    // A saved ID whose unique lookup disappeared requires investigation, not replacement.
    if (knownId) throw new HubSpotError('previous_deal_missing_do_not_recreate');
    try {
      // Before repeating a create that may have succeeded (5xx/timeout), reconcile by the
      // unique order ID; a repeated create would also be rejected by the unique property.
      const reconcile = async () => {
        const existing = await this.findDeal(payload.order_id);
        return existing && existing.properties?.[this.property] === payload.order_id ? existing : null;
      };
      const record = await this.retrying(() => this.request<RecordResult>('POST', '/crm/v3/objects/deals', {
        properties: {
          dealname: 'Order ' + payload.order_id,
          amount: String(payload.total),
          closedate: new Date(payload.created_at).toISOString(),
          pipeline: process.env.HUBSPOT_PIPELINE_ID,
          dealstage: process.env.HUBSPOT_DEAL_STAGE_ID,
          deal_currency_code: payload.currency,
          [this.property]: payload.order_id,
        },
      }, { retry: false }), reconcile);
      return this.id(record);
    } catch (error) {
      if (!(error instanceof HubSpotError) || ![400, 409].includes(error.status ?? 0)) throw error;
      // A unique constraint conflict may be returned as 400 or 409 by HubSpot.
      const existing = await this.findDeal(payload.order_id);
      if (existing && existing.properties?.[this.property] === payload.order_id) return this.id(existing);
      throw error;
    }
  }

  async associate(dealId: string, contactId: string): Promise<void> {
    await this.request('PUT', '/crm/v4/objects/deals/' + dealId +
      '/associations/default/contacts/' + contactId);
    await this.verifyAssociation(dealId, contactId);
  }

  async verifyAssociation(dealId: string, contactId: string): Promise<void> {
    // Read back the relation; a write response alone is not our completion criterion.
    let after: string | undefined;
    do {
      const page: List<{ toObjectId: number | string }> = await this.request('GET',
        '/crm/v4/objects/deals/' + dealId + '/associations/contacts?limit=500' +
        (after ? '&after=' + encodeURIComponent(after) : ''));
      if (page.results.some(item => String(item.toObjectId) === contactId)) return;
      after = page.paging?.next?.after;
    } while (after);
    throw new HubSpotError('association_not_verified');
  }
}
