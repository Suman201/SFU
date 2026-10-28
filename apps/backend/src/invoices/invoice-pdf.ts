import PDFDocument from 'pdfkit';
import { join } from 'node:path';
import {
  invoicePostalAddress,
  type InvoiceRecord,
} from '@native-sfu/contracts';

export function renderInvoicePdf(invoice: InvoiceRecord): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const assets = join(__dirname, '../../assets/invoices');
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 44, left: 44, right: 44, bottom: 24 },
      bufferPages: true,
      font: join(assets, 'DejaVuSans.ttf'),
      info: {
        Title: `Invoice ${invoice.number || 'Draft'}`,
        Author: invoice.seller.name,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('regular', join(assets, 'DejaVuSans.ttf'));
    doc.registerFont('bold', join(assets, 'DejaVuSans-Bold.ttf'));
    const ink = '#21362d',
      muted = '#65746b',
      line = '#dde4dc',
      green = '#326c57';
    let y = 44;
    const text = (
      value: string,
      x: number,
      top: number,
      width: number,
      size = 9,
      bold = false,
      color = ink,
      align: 'left' | 'right' = 'left',
    ) => {
      doc
        .font(bold ? 'bold' : 'regular')
        .fontSize(size)
        .fillColor(color)
        .text(value, x, top, { width, align, lineGap: 3 });
    };
    const height = (value: string, width: number, size = 9) =>
      doc
        .font('regular')
        .fontSize(size)
        .heightOfString(value, { width, lineGap: 3 });
    const rule = (top: number) =>
      doc
        .strokeColor(line)
        .lineWidth(0.6)
        .moveTo(44, top)
        .lineTo(551, top)
        .stroke();
    const newPage = () => {
      doc.addPage();
      text(invoice.number || 'Draft invoice', 44, 40, 507, 10, true);
      y = 72;
    };
    const ensure = (needed: number) => {
      if (y + needed > 760) newPage();
    };
    doc.image(join(assets, 'sapiovian-mark.png'), 44, 41, { fit: [25, 35] });
    doc.image(join(assets, 'sapiovian-wordmark.png'), 76, 44, { width: 115 });
    text(
      invoice.status === 'draft'
        ? 'DRAFT INVOICE'
        : invoice.status === 'void'
          ? 'VOID INVOICE'
          : 'INVOICE',
      300,
      43,
      251,
      21,
      true,
      green,
      'right',
    );
    text(
      invoice.number || 'Not issued',
      300,
      75,
      251,
      9,
      false,
      muted,
      'right',
    );
    rule(103);
    const seller = [
      invoice.seller.name,
      invoicePostalAddress(invoice.seller),
      invoice.seller.email,
      invoice.seller.vatNumber ? `VAT: ${invoice.seller.vatNumber}` : '',
      invoice.seller.registrationNumber
        ? `Registration: ${invoice.seller.registrationNumber}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    const buyer = [
      invoice.customer.name,
      invoicePostalAddress(invoice.customer),
      invoice.customer.email,
      invoice.customer.vatNumber ? `VAT: ${invoice.customer.vatNumber}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    text('FROM', 44, 124, 230, 8, true, muted);
    text('BILL TO', 315, 124, 236, 8, true, muted);
    text(seller, 44, 145, 230);
    text(buyer, 315, 145, 236);
    y = 145 + Math.max(height(seller, 230), height(buyer, 236)) + 26;
    ensure(70);
    [
      ['Invoice date', invoice.invoiceDate],
      ['Due date', invoice.dueDate],
      ['Supply date', invoice.supplyDate],
    ].forEach(([label, value], index) => {
      text(label!, 44 + index * 173, y, 160, 8, false, muted);
      text(value!, 44 + index * 173, y + 18, 160, 10, true);
    });
    y += 57;
    if (invoice.reference) {
      text(`Reference: ${invoice.reference}`, 44, y, 507, 9, false, muted);
      y += height(invoice.reference, 480) + 15;
    }
    const tableHeader = () => {
      doc.roundedRect(44, y, 507, 29, 3).fill('#eff3ed');
      [
        ['Description', 53, 221],
        ['Qty', 284, 36],
        ['Unit price', 326, 76],
        ['Tax', 410, 43],
        ['Amount', 459, 83],
      ].forEach(([value, x, width]) =>
        text(
          String(value),
          Number(x),
          y + 9,
          Number(width),
          8,
          true,
          ink,
          Number(x) > 280 ? 'right' : 'left',
        ),
      );
      y += 36;
    };
    ensure(90);
    tableHeader();
    const money = (value: number) =>
      new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: invoice.currency,
      }).format(value / 100);
    invoice.lines.forEach((item, index) => {
      const rowHeight = Math.max(39, height(item.description, 222) + 17);
      if (y + rowHeight > 730) {
        newPage();
        tableHeader();
      }
      text(item.description, 53, y + 5, 222, 9);
      text(
        (item.quantityMilli / 1000).toLocaleString('en-GB', {
          maximumFractionDigits: 3,
        }),
        284,
        y + 5,
        36,
        8,
        false,
        ink,
        'right',
      );
      text(money(item.unitPriceMinor), 326, y + 5, 76, 8, false, ink, 'right');
      text(`${item.taxRateBps / 100}%`, 410, y + 5, 43, 8, false, ink, 'right');
      text(
        money(invoice.totals.lines[index]!.netMinor),
        459,
        y + 5,
        83,
        9,
        true,
        ink,
        'right',
      );
      y += rowHeight;
      rule(y - 4);
    });
    y += 21;
    ensure(105 + invoice.totals.taxes.length * 20);
    const totalRow = (label: string, value: number, strong = false) => {
      text(label, 323, y, 127, strong ? 11 : 9, strong, strong ? ink : muted);
      text(money(value), 454, y, 97, strong ? 12 : 10, strong, ink, 'right');
      y += strong ? 31 : 24;
    };
    totalRow('Subtotal', invoice.totals.subtotalMinor);
    invoice.totals.taxes.forEach((tax) =>
      totalRow(`Tax (${tax.rateBps / 100}%)`, tax.taxMinor),
    );
    doc.strokeColor(line).moveTo(323, y).lineTo(551, y).stroke();
    y += 14;
    totalRow(`Total (${invoice.currency})`, invoice.totals.totalMinor, true);
    y += 10;
    const block = (title: string, value: string) => {
      if (!value) return;
      const h = height(value, 507) + 35;
      ensure(h);
      text(title, 44, y, 507, 8, true, muted);
      y += 19;
      text(value, 44, y, 507);
      y += h - 12;
    };
    block('TAX INFORMATION', invoice.taxNote);
    block('PAYMENT INFORMATION', invoice.seller.paymentInstructions);
    block('NOTES', invoice.notes);
    if (invoice.status === 'void')
      block(
        'VOID REASON',
        invoice.voidReason || 'This invoice has been voided.',
      );
    if (invoice.status === 'draft')
      block(
        'DRAFT',
        'This invoice has not been issued. It has no invoice number and cannot be emailed as an issued invoice.',
      );
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      rule(791);
      text(invoice.seller.name, 44, 802, 400, 8, false, muted);
      text(`${i + 1} / ${pages.count}`, 475, 802, 76, 8, false, muted, 'right');
    }
    doc.end();
  });
}
