import { setAccessibilityTheme } from './helpers/accessibility-theme';
import { expect, test, type BrowserContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startAcceptanceStack, login } from './helpers/whiteboard-classroom';
import { startAdminTestServer } from './helpers/admin-test-server';
import { startLocalSmtpSink } from './helpers/tutor-launch-acceptance';
import { runtimeUrl } from './helpers/local-ui-stack';
const { setupCmsIndexes } = require('../../scripts/setup-cms.cjs');

test('versioned CMS, readonly history, contact delivery and audit privacy use real persistence', async ({ browser }, info) => {
  const smtp = await startLocalSmtpSink({ rejectFirst: false });
  const stack = await startAcceptanceStack({ frontendPort: 4534, backendPort: 3434, localSmtpPort: smtp.port });
  const admin = await startAdminTestServer(stack.nodeAUrl);
  const contexts: BrowserContext[] = [];
  const folder = path.resolve('reports/p2', info.project.name);
  await mkdir(folder, { recursive: true });
  const nonce = randomUUID();
  const title = 'P2 legal acceptance ' + nonce + ' ' + 'PolicyVersion'.repeat(5);
  const slug = 'p2-policy-' + nonce;
  const body1 = 'Published legal fixture one ' + nonce + ' ' + 'LongReference'.repeat(8);
  const body2 = 'Private draft fixture two ' + nonce;
  const users = ['root', 'reader'].map(name => ({ id: new mongoose.Types.ObjectId().toHexString(), email: name + nonce + '@p2.test' }));
  let pageId = '';
  const api = async (token: string, endpoint: string, method = 'GET', data?: unknown, expected?: number) => {
    const response = await fetch(stack.nodeAUrl + '/api/v1' + endpoint, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    if (expected) expect(response.status, endpoint + ': ' + JSON.stringify(body)).toBe(expected);
    else expect(response.ok, endpoint + ': ' + JSON.stringify(body)).toBe(true);
    return body.data ?? body;
  };
  const ui = async (token?: string) => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 950 } }); contexts.push(context);
    await context.addInitScript(token => { localStorage.setItem('native-sfu-theme', 'light'); if (token) sessionStorage.setItem('native-sfu.admin.auth.accessToken', token); }, token);
    return context.newPage();
  };
  try {
    const connection = await mongoose.createConnection(process.env.MONGODB_URI!).asPromise();
    try {
      const template = await connection.db!.collection('users').findOne({ email: 'teacher.one@example.com' });
      for (const [index, user] of users.entries()) await connection.db!.collection('users').insertOne({ ...template, _id: new mongoose.Types.ObjectId(user.id), email: user.email, name: 'P2 ' + index, displayName: 'P2 ' + index, roles: index ? ['ADMIN'] : ['SUPER_ADMIN'], permissions: [], adminRoleId: undefined });
      await setupCmsIndexes(connection); await setupCmsIndexes(connection);
    } finally { await connection.close(); }
    const root = (await login(stack.nodeAUrl, users[0].email, 'Password@12345')).accessToken;
    const role = await api(root, '/admin/staff/roles', 'POST', { name: 'P2 readonly ' + nonce, description: 'Isolated acceptance reader', status: 'active', permissions: ['admin:content:read'] });
    await api(root, '/admin/staff/members/' + users[1].id + '/role', 'POST', { roleId: role.id, expectedRoleId: null, reason: 'Synthetic acceptance reader' });
    const reader = (await login(stack.nodeAUrl, users[1].email, 'Password@12345')).accessToken;
    const student = (await login(stack.nodeAUrl, 'student.one@example.com', 'Password@12345')).accessToken;
    const created = await api(root, '/admin/cms/pages', 'POST', { title, slug, pageType: 'legal', audience: 'public', locale: 'en', bodyMarkdown: body1 });
    pageId = created.pageId;
    const endpoint = '/admin/cms/pages/' + pageId;
    const editor = await ui(root);
    await editor.goto(admin.origin + '/cms/pages');
    await editor.getByRole('row').filter({ hasText: title }).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.getByLabel('Section type', { exact: true }).selectOption('rich_text');
    await editor.getByRole('button', { name: 'Add section', exact: true }).click();
    await editor.getByLabel('Section title', { exact: true }).fill('Reviewable section');
    await editor.getByLabel('Section body', { exact: true }).fill('Structured legal fixture content');
    const save = async () => {
      const response = editor.waitForResponse(r => r.url().includes(endpoint) && r.request().method() === 'PATCH');
      await editor.locator('.cms-editor').getByRole('button', { name: 'Save', exact: true }).click();
      expect((await response).ok()).toBe(true);
      await expect(editor.locator('.cms-editor').getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    };
    const publish = async (name: string) => {
      const response = editor.waitForResponse(r => r.url().endsWith(endpoint + '/publish') && r.request().method() === 'POST');
      await editor.locator('.cms-editor').getByRole('button', { name, exact: true }).click();
      expect((await response).ok()).toBe(true);
    };
    await save(); await publish('Publish');
    await expect.poll(async () => (await api(root, endpoint)).publishedVersion).toBe(1);
    const publicPage = await ui();
    await publicPage.goto(runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/pages/' + slug));
    await expect(publicPage.getByText(body1, { exact: true })).toBeVisible();
    await expect(publicPage.getByRole('heading', { name: 'Reviewable section', exact: true })).toBeVisible();
    const published = await api(root, endpoint);
    await editor.locator('[formControlName=bodyMarkdown]').fill(body2); await save();
    await publicPage.reload();
    await expect(publicPage.getByText(body1, { exact: true })).toBeVisible();
    await expect(publicPage.getByText(body2, { exact: true })).toHaveCount(0);
    await api(root, endpoint, 'PATCH', { expectedRevision: published.revision, bodyMarkdown: 'Stale editor must lose' }, 409);
    await api(root, endpoint, 'PATCH', { sections: [{ type: 'link_list', links: [{ label: 'unsafe', url: 'javascript:alert(1)' }] }] }, 400);
    await api(root, endpoint, 'PATCH', { sections: [{ type: 'link_list', links: [null] }] }, 400);
    await api(student, endpoint + '/revisions', 'GET', undefined, 403);
    await publish('Publish changes');
    await expect.poll(async () => (await api(root, endpoint)).publishedVersion).toBe(2);
    await editor.getByRole('button', { name: 'Load publication history', exact: true }).click();
    const history = editor.getByRole('region', { name: 'Publication history', exact: true });
    await history.getByRole('row').filter({ hasText: 'Version 1' }).getByRole('button', { name: 'View publication' }).click();
    const restored = editor.waitForResponse(r => r.url().endsWith('/restore') && r.request().method() === 'POST');
    await history.getByRole('button', { name: 'Restore as draft' }).click(); expect((await restored).ok()).toBe(true);
    await expect(editor.locator('[formControlName=bodyMarkdown]')).toHaveValue(body1);
    await publicPage.reload(); await expect(publicPage.getByText(body2, { exact: true })).toBeVisible();
    await publish('Publish changes');
    const revisions = await api(root, endpoint + '/revisions'); expect(revisions.total).toBe(3);
    await api(root, endpoint + '/publish', 'POST', {});
    expect((await api(root, endpoint + '/revisions')).total).toBe(3);
    const readonly = await ui(reader); await readonly.goto(admin.origin + '/cms/pages');
    await readonly.getByRole('row').filter({ hasText: title }).getByRole('button', { name: 'View', exact: true }).click();
    await readonly.getByRole('button', { name: 'Load publication history' }).click();
    await readonly.getByRole('region', { name: 'Publication history' }).getByRole('row').filter({ hasText: 'Version 1' }).getByRole('button', { name: 'View publication' }).click();
    await expect(readonly.getByRole('button', { name: 'Restore as draft' })).toHaveCount(0);
    await api(reader, endpoint, 'PATCH', { title: 'unauthorized' }, 403);
    await api(reader, endpoint + '/revisions/' + revisions.items[0].revisionId + '/restore', 'POST', { expectedRevision: (await api(root, endpoint)).revision }, 403);
    const contact = await ui(); await contact.goto(runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/contact-us'));
    const subject = 'P2 contact ' + nonce;
    const secret = 'Private support request ' + nonce;
    await contact.getByLabel('Name', { exact: true }).fill('Local acceptance');
    await contact.getByLabel('Email', { exact: true }).fill('local@p2.test');
    await contact.getByLabel('Subject', { exact: true }).fill(subject);
    await contact.getByLabel('Message', { exact: true }).fill(secret);
    const submissionResponse = contact.waitForResponse(r => r.url().includes('/contact/submissions') && r.request().method() === 'POST');
    await contact.getByRole('button', { name: 'Send message', exact: true }).click();
    const submissionEnvelope = await (await submissionResponse).json(); const submission = submissionEnvelope.data ?? submissionEnvelope;
    await editor.goto(admin.origin + '/cms/contact');
    await editor.getByRole('row').filter({ hasText: subject }).getByRole('button', { name: 'Open', exact: true }).click();
    const reply = 'Private support reply ' + nonce;
    await editor.getByLabel('Reply by email', { exact: true }).fill(reply);
    const replyResponse = editor.waitForResponse(r => r.url().endsWith('/' + submission.submissionId + '/reply') && r.request().method() === 'POST');
    await editor.getByRole('button', { name: 'Send reply', exact: true }).click();
    expect((await replyResponse).ok()).toBe(true);
    await expect.poll(() => smtp.messages.some(message => message.raw.includes(reply))).toBe(true);
    const auditConnection = await mongoose.createConnection(process.env.MONGODB_URI!).asPromise();
    try {
      const rows = await auditConnection.db!.collection('audit_logs').find({ resourceId: { $in: [pageId, submission.submissionId] } }).toArray();
      expect(rows.some(row => row.action === 'cms.page.published')).toBe(true);
      expect(rows.some(row => row.action.includes('contact') && row.action.includes('repl'))).toBe(true);
      const serialized = JSON.stringify(rows);
      for (const content of [body1, body2, secret, reply]) expect(serialized).not.toContain(content);
      const original = await auditConnection.db!.collection('cms_pages').findOne({ pageId });
      expect(original).not.toBeNull();
      await setupCmsIndexes(auditConnection); expect(await auditConnection.db!.collection('cms_pages').findOne({ pageId })).toEqual(original);
    } finally { await auditConnection.close(); }
    await editor.goto(admin.origin + '/cms/pages');
    await editor.getByRole('row').filter({ hasText: title }).getByRole('button', { name: 'Edit', exact: true }).click();
    const accessibility = await new AxeBuilder({ page: editor }).include('.section-builder').withRules(['button-name', 'label', 'aria-valid-attr-value', 'color-contrast']).analyze();
    expect(accessibility.violations).toEqual([]);
    await editor.locator('.section-builder').scrollIntoViewIfNeeded();
    await editor.screenshot({ path: path.join(folder, 'cms-editor-desktop.png'), fullPage: true });
    await editor.setViewportSize({ width: 390, height: 844 });
    const layout = await editor.evaluate(() => {
      const describe = (el: Element) => { const rect = el.getBoundingClientRect(), style = getComputedStyle(el); return { element: el.tagName + '.' + el.className, parent: el.parentElement?.className, control: el.getAttribute('formcontrolname'), width: rect.width, right: rect.right, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflow: style.overflowX, whiteSpace: style.whiteSpace, position: style.position }; };
      const offenders = [...document.querySelectorAll('body *')].filter(el => { const rect = el.getBoundingClientRect(); return rect.width > 0 && !el.closest('.data-table-wrap') && (rect.right > innerWidth + 1 || (getComputedStyle(el).overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1)); });
      return { width: document.documentElement.scrollWidth, viewport: innerWidth, offenders: offenders.map(describe).slice(-24) };
    });
    await expect.poll(() => editor.evaluate(() => document.documentElement.scrollWidth), { message: JSON.stringify(layout) }).toBeLessThanOrEqual(layout.viewport);
    await setAccessibilityTheme(editor, 'dark');
    expect((await new AxeBuilder({ page: editor }).include('.section-builder').withRules(['button-name', 'label', 'color-contrast']).analyze()).violations).toEqual([]);
    await editor.screenshot({ path: path.join(folder, 'cms-editor-mobile.png'), fullPage: true });
    const publicLayout = () => publicPage.evaluate(() => ({
      width: document.documentElement.scrollWidth, viewport: innerWidth,
      offenders: [...document.querySelectorAll('body *')].filter(element => {
        const rect = element.getBoundingClientRect(); return rect.width > 0 && (rect.right > innerWidth || (getComputedStyle(element).overflowX === 'visible' && element.scrollWidth > element.clientWidth + 1));
      }).map(element => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return { element: element.tagName + '.' + element.className, width: rect.width, right: rect.right, scrollWidth: element.scrollWidth, grid: style.gridTemplateColumns, wrap: style.overflowWrap, font: style.fontFamily }; }).slice(-30),
    }));
    await publicPage.reload(); await publicPage.setViewportSize({ width: 768, height: 1024 });
    const tabletLayout = await publicLayout();
    if (tabletLayout.width > tabletLayout.viewport) console.log('CMS tablet overflow:', JSON.stringify(tabletLayout));
    await expect.poll(() => publicPage.evaluate(() => document.documentElement.scrollWidth), { message: JSON.stringify(tabletLayout) }).toBeLessThanOrEqual(768);
    const checkPublicMenu = async (width: number) => {
      await publicPage.getByRole('button', { name: 'Menu', exact: true }).click();
      await expect(publicPage.getByRole('navigation', { name: 'Primary', exact: true })).toBeVisible();
      await expect(publicPage.getByRole('button', { name: 'Switch to dark mode', exact: true })).toBeVisible();
      await expect.poll(() => publicPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await publicPage.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(publicPage.getByRole('navigation', { name: 'Primary', exact: true })).toBeHidden();
    };
    await checkPublicMenu(768);
    await publicPage.screenshot({ path: path.join(folder, 'cms-public-tablet.png'), fullPage: true });
    await publicPage.setViewportSize({ width: 390, height: 844 });
    const mobileLayout = await publicLayout();
    if (mobileLayout.width > mobileLayout.viewport) console.log('CMS mobile overflow:', JSON.stringify(mobileLayout));
    await expect.poll(() => publicPage.evaluate(() => document.documentElement.scrollWidth), { message: JSON.stringify(mobileLayout) }).toBeLessThanOrEqual(390);
    await checkPublicMenu(390);
    await publicPage.screenshot({ path: path.join(folder, 'cms-public-mobile.png'), fullPage: true });
    await editor.goto(admin.origin + '/audit-logs');
    await expect(editor.getByRole('heading', { name: /Audit/ }).first()).toBeVisible();
    await editor.screenshot({ path: path.join(folder, 'audit-explorer-mobile.png'), fullPage: true });
    await writeFile(path.join(folder, 'cms-audit.json'), JSON.stringify({ passed: true, realBackend: true, immutablePublications: 3, privateDraft: true, staleWriteRejected: true, readonlyHistory: true, contactDeliveredToLocalSink: true, auditBodiesExcluded: true, setupIdempotent: true, accessibilityViolations: accessibility.violations, productionSignoff: false }, null, 2));
  } finally {
    await writeFile(info.outputPath('backend-runtime.log'), stack.getLogs());
    for (const context of contexts) await context.close().catch(() => undefined);
    await admin.stop(); await stack.stop(); await smtp.close();
  }
});
