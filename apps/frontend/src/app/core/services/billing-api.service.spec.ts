import { billingDocumentUrl } from './billing-api.service';

describe('hosted billing documents', () => {
  it('accepts Stripe invoice and credit-note links with their signed query strings', () => {
    expect(billingDocumentUrl('https://invoice.stripe.com/i/invoice?signature=fixture')).toBe('https://invoice.stripe.com/i/invoice?signature=fixture');
    expect(billingDocumentUrl('https://pay.stripe.com/credit.pdf')).toBe('https://pay.stripe.com/credit.pdf');
  });
  it('rejects insecure, credential-bearing and unrelated document destinations', () => {
    for (const url of ['http://invoice.stripe.com/i/1', 'https://invoice.stripe.com.attacker.test/i/1', 'https://user:password@invoice.stripe.com/i/1', 'https://invoice.stripe.com:444/i/1', 'javascript:alert(1)', '/account/billing', '//invoice.stripe.com/i/1']) {
      expect(() => billingDocumentUrl(url)).withContext(url).toThrow();
    }
  });
});
