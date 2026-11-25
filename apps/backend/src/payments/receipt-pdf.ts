import PDFDocument from 'pdfkit';
import { join } from 'node:path';
import { formatPaymentMoney, invoicePostalAddress, paymentStatusLabel, type InvoiceSeller, type PaymentStatus } from '@native-sfu/contracts';

export interface ReceiptView {
  receiptNumber: string;
  paymentId: string;
  status: PaymentStatus;
  paidAt: Date;
  currency: string;
  amountMinor: number;
  description: string;
  batchName: string;
  teacherName: string;
  studentName: string;
  studentEmail: string;
  gatewayPaymentId?: string;
  seller: InvoiceSeller;
  refunds: Array<{ amountMinor: number; completedAt?: Date; reason: string }>;
}

/** Payment receipt (proof of payment). Refunds are listed so the net amount is always visible. */
export function renderReceiptPdf(receipt: ReceiptView): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const assets = join(__dirname, '../../assets/invoices');
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 44, left: 44, right: 44, bottom: 24 },
      font: join(assets, 'DejaVuSans.ttf'),
      info: { Title: `Receipt ${receipt.receiptNumber}`, Author: receipt.seller.name },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('regular', join(assets, 'DejaVuSans.ttf'));
    doc.registerFont('bold', join(assets, 'DejaVuSans-Bold.ttf'));
    const ink = '#21362d';
    const muted = '#65746b';
    const line = '#dde4dc';
    const green = '#326c57';
    const money = (minor: number) => formatPaymentMoney(minor, receipt.currency);
    const date = (value: Date) => value.toISOString().slice(0, 10);
    const text = (value: string, x: number, top: number, width: number, size = 9, bold = false, color = ink, align: 'left' | 'right' = 'left') => {
      doc.font(bold ? 'bold' : 'regular').fontSize(size).fillColor(color).text(value, x, top, { width, align, lineGap: 3 });
    };
    const rule = (top: number) => doc.strokeColor(line).lineWidth(0.6).moveTo(44, top).lineTo(551, top).stroke();

    doc.image(join(assets, 'sapiovian-mark.png'), 44, 41, { fit: [25, 35] });
    doc.image(join(assets, 'sapiovian-wordmark.png'), 76, 44, { width: 115 });
    text('PAYMENT RECEIPT', 300, 43, 251, 19, true, green, 'right');
    text(receipt.receiptNumber, 300, 72, 251, 9, false, muted, 'right');
    rule(103);

    const seller = [receipt.seller.name, invoicePostalAddress(receipt.seller), receipt.seller.email].filter(Boolean).join('\n');
    const payer = [receipt.studentName, receipt.studentEmail].join('\n');
    text('RECEIVED BY', 44, 124, 230, 8, true, muted);
    text('PAID BY', 315, 124, 236, 8, true, muted);
    text(seller, 44, 145, 230);
    text(payer, 315, 145, 236);
    let y = 145 + Math.max(doc.heightOfString(seller, { width: 230, lineGap: 3 }), doc.heightOfString(payer, { width: 236, lineGap: 3 })) + 26;

    [
      ['Payment date', date(receipt.paidAt)],
      ['Status', paymentStatusLabel(receipt.status)],
      ['Payment reference', receipt.gatewayPaymentId ?? receipt.paymentId],
    ].forEach(([label, value], index) => {
      text(label!, 44 + index * 173, y, 160, 8, false, muted);
      text(value!, 44 + index * 173, y + 18, 165, index === 2 ? 8 : 10, true);
    });
    y += 62;

    doc.roundedRect(44, y, 507, 29, 3).fill('#eff3ed');
    text('Description', 53, y + 9, 360, 8, true, muted);
    text('Amount', 420, y + 9, 122, 8, true, muted, 'right');
    y += 40;
    const description = `${receipt.description}\nTeacher: ${receipt.teacherName}`;
    text(description, 53, y, 360, 9.5);
    text(money(receipt.amountMinor), 420, y, 122, 9.5, true, ink, 'right');
    y += doc.heightOfString(description, { width: 360, lineGap: 3 }) + 14;
    rule(y);
    y += 12;

    for (const refund of receipt.refunds) {
      const label = `Refund${refund.completedAt ? ` on ${date(refund.completedAt)}` : ''}${refund.reason ? ` — ${refund.reason}` : ''}`;
      text(label, 53, y, 360, 9, false, muted);
      text(`−${money(refund.amountMinor)}`, 420, y, 122, 9, false, muted, 'right');
      y += doc.heightOfString(label, { width: 360, lineGap: 3 }) + 8;
    }
    const refunded = receipt.refunds.reduce((sum, item) => sum + item.amountMinor, 0);
    y += 6;
    text(refunded > 0 ? 'Net amount paid' : 'Amount paid', 270, y, 140, 10, true, ink, 'right');
    text(money(receipt.amountMinor - refunded), 420, y, 122, 12, true, green, 'right');
    y += 40;

    text(
      'This receipt confirms a card payment processed securely by our payment provider. Sapiovian never receives or stores card details. Keep this receipt for your records.',
      44,
      y,
      507,
      8.5,
      false,
      muted,
    );
    doc.end();
  });
}
