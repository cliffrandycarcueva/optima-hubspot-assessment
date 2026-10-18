export type Attempt = {
  id: string; orderId: string; attemptStatus: string; orderStatus: string;
  contactId: string | null; dealId: string | null; error: string | null;
  startedAt: string; finishedAt: string | null; retryEligible: boolean;
  /** webhook | manual | automatic | command; null for attempts recorded before automatic retries existed. */
  trigger: string | null; nextRetryAt: string | null; autoRetryCount: number;
};
export type DashboardData = {
  attempts: Attempt[];
  summary: { total: number; succeeded: number; failed: number; inFlightOrders: number };
  portalId: string | null; connected: boolean; checkedAt: string;
};
