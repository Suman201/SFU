import type { PaymentCurrency, PaymentGatewayId } from '@native-sfu/contracts';
import { GatewayUnavailableError, InvalidWebhookSignatureError, type GatewayEvent, type PaymentGateway } from './payment-gateway';

/** Placeholder used when the selected gateway has no credentials. Every operation fails safely. */
export class UnconfiguredGateway implements PaymentGateway {
  readonly testMode = false;
  readonly payoutsSupported = false;

  constructor(readonly id: PaymentGatewayId) {}

  private unavailable(): never {
    throw new GatewayUnavailableError('The payment provider is not configured.');
  }

  supportsCurrency(_currency: PaymentCurrency): boolean {
    return false;
  }
  createCheckout(): never {
    return this.unavailable();
  }
  async expireCheckout(): Promise<void> {
    return;
  }
  parseWebhook(): GatewayEvent {
    throw new InvalidWebhookSignatureError('The payment provider is not configured.');
  }
  async fetchPaymentFee(): Promise<null> {
    return null;
  }
  refund(): never {
    return this.unavailable();
  }
  createPayoutAccount(): never {
    return this.unavailable();
  }
  payoutAccountLink(): never {
    return this.unavailable();
  }
  payoutAccountStatus(): never {
    return this.unavailable();
  }
  transfer(): never {
    return this.unavailable();
  }
}
