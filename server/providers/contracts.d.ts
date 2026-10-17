// Provider boundary. Current runtime accepts ONLY simulated money/notifications.
// Future SDK implementations must pass sandbox acceptance before the production gate changes.
export type CallOptions = { signal?: AbortSignal };
export type Receipt = { id: string; simulated: boolean; status: string; createdAt: string };
export type PaymentReceipt = Receipt & { reference: string; amountCents: number; currency: 'CNY' };
export type RefundReceipt = Receipt & { paymentId: string; amountCents: number; reason: string };
// Future asynchronous adapter contract; not implemented or used by the current mock worker.
// A created QR/prepay intent is NOT proof that funds were received.
export type PaymentIntent = { requestId: string; reference: string; amountCents: number; currency: 'CNY'; status: 'pending'; expiresAt: string; checkout: { type: 'qr' | 'redirect'; value: string } };
export interface FuturePaymentWebhookAdapter {
  /** Verify the ORIGINAL bytes, signature/certificate, timestamp and decrypted resource.
   * Never accept a client-supplied "verified" flag. Reject uncertainty.
   * Merchant/app identity and amount still must match the server's immutable payment intent.
   */
  verifyWebhook(input: { headers: Readonly<Record<string, string>>; rawBody: Uint8Array }): Promise<{
    eventId: string; transactionId: string; reference: string; merchantId: string; appId: string;
    amountCents: number; currency: 'CNY'; type: 'payment-succeeded' | 'refund-succeeded'; occurredAt: string;
  }>;
}
export interface PaymentProvider {
  /** requestId is stable across timeouts, restarts and manual recovery. Never replace it for a retry. */
  createPayment(input: CallOptions & { reference: string; amountCents: number; requestId: string }): Promise<PaymentReceipt>;
  /** null MUST mean authoritative absence. Unknown/network failure MUST throw, never return null. */
  findPayment(requestId: string, options?: CallOptions): Promise<PaymentReceipt | null>;
  findRefund(requestId: string, options?: CallOptions): Promise<RefundReceipt | null>;
  getPayment(id: string, options?: CallOptions): Promise<(PaymentReceipt & { refundedCents: number }) | null>;
  refund(input: CallOptions & { paymentId: string; amountCents: number; requestId: string; reason: string }): Promise<RefundReceipt>;
}
export interface AIProvider {
  /** Findings only; no permission to pay, refund, suspend, or change a rule. */
  analyze(input: CallOptions & { text: string; requestId: string }): Promise<Receipt & { needsHumanReview: boolean; findings: string[] }>;
}
export interface SmsProvider {
  /** Delivery does not prove phone ownership. OTP issuance/verification belongs to the auth service. */
  send(input: CallOptions & { recipient: string; template: string; requestId: string }): Promise<Receipt & { delivered: boolean }>;
}
export interface NotificationProvider {
  /** No chat/evidence payload; resolve consent and destination in the adapter. Dedupe by requestId. */
  send(input: CallOptions & { userId: string; topic: string; requestId: string }): Promise<Receipt & { delivered: boolean }>;
}
export interface EmailProvider {
  /** Recovery URLs are credentials. Do not log or return them in public APIs.
   * A real delivery implementation must be configured before staging enrollment. */
  send(input: { recipient: string; purpose: 'verify' | 'reset'; url: string }): Promise<void>;
}
export interface StorageProvider {
  /** Keys are immutable and private. Downloads still require business authorization. */
  put(input: CallOptions & { key: string; content: Uint8Array; requestId: string }): Promise<Receipt & { key: string; bytes: number }>;
  get(key: string, options?: CallOptions): Promise<Uint8Array | null>;
}
// Future webhook verification, asynchronous reconciliation and settlement are not implemented
// by these contracts. Do NOT map a real gateway's "payment created/pending" to succeeded.
// Before adding a real implementation, see section L of
// docs/网站代码与安全检查报告_A-L_2026-10-04.md and docs/安全检测交付说明_2026-10-04.md.
