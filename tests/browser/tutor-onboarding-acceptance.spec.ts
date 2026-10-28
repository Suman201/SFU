import { test, expect } from '@playwright/test';
import mongoose from 'mongoose';
import { createServer, request as httpRequest } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { startAcceptanceStack, login } from './helpers/whiteboard-classroom';

test('real backend: tutor catalogue, video, review and public profile', async ({
  browser,
  request,
}, info) => {
  test.setTimeout(240_000);
  const stack = await startAcceptanceStack({
    frontendPort: 4464,
    backendPort: 3364,
  });
  let adminServer: ReturnType<typeof createServer> | undefined;
  const contexts: any[] = [];
  const screenshotDir = process.env.TUTOR_UI_OUTPUT || info.outputPath('ui');
  await mkdir(screenshotDir, { recursive: true });
  try {
    const connection = await mongoose
      .createConnection(process.env.MONGODB_URI!)
      .asPromise();
    let teacherId = '';
    try {
      const db = connection.db!;
      const teacher = await db
        .collection('users')
        .findOne({ email: 'teacher.one@example.com' });
      if (!teacher) throw new Error('Missing isolated teacher fixture');
      teacherId = String(teacher._id);
      const { _id, ...copy } = teacher;
      await db.collection('users').updateOne(
        { email: 'catalog-admin@example.com' },
        {
          $set: {
            ...copy,
            email: 'catalog-admin@example.com',
            name: 'Catalogue Reviewer',
            displayName: 'Catalogue Reviewer',
            roles: ['ADMIN'],
            permissions: ['*'],
          },
        },
        { upsert: true },
      );
      await db.collection('teaching_catalog').deleteMany({});
      await db.collection('users').updateOne(
        { _id: teacher._id },
        {
          $set: {
            tutorReviewStatus: 'draft',
            tutorRevision: 0,
            publicProfileEnabled: false,
            teacherSubjectIds: [],
            curriculumIds: [],
            assessmentResponses: [],
          },
          $unset: {
            tutorIntroVideo: '',
            introVideoUrl: '',
            coverImageUrl: '',
          },
        },
      );
    } finally {
      await connection.close();
    }
    const teacher = await login(
      stack.nodeAUrl,
      'teacher.one@example.com',
      'Password@12345',
    );
    const student = await login(
      stack.nodeAUrl,
      'student.one@example.com',
      'Password@12345',
    );
    const admin = await login(
      stack.nodeAUrl,
      'catalog-admin@example.com',
      'Password@12345',
    );
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
    const api = async (
      method: string,
      url: string,
      token: string | undefined,
      data?: any,
      expected = 200,
    ) => {
      const response = await request.fetch(`${stack.nodeAUrl}/api/v1${url}`, {
        method,
        headers: token ? auth(token) : {},
        data,
      });
      expect(
        response.status(),
        `${method} ${url}: ${await response.text()}`,
      ).toBe(expected);
      const body = await response.json();
      return body.data ?? body;
    };
    await api(
      'POST',
      '/admin/teaching-catalog/starter',
      student.accessToken,
      {},
      403,
    );
    await api('GET', '/admin/teaching-catalog', undefined, undefined, 401);
    await api(
      'POST',
      '/admin/teaching-catalog/starter',
      admin.accessToken,
      {},
      201,
    );
    const catalog = await api('GET', '/teaching-catalog', undefined);
    expect(catalog.categories).toHaveLength(18);
    expect(catalog.subjects).toHaveLength(268);
    expect(catalog.curricula).toHaveLength(80);
    await api(
      'POST',
      '/admin/teaching-catalog/starter',
      admin.accessToken,
      {},
      201,
    );
    expect(
      (await api('GET', '/teaching-catalog', undefined)).subjects,
    ).toHaveLength(268);
    const maths = catalog.categories.find((x: any) => x.name === 'Mathematics');
    const algebra = catalog.subjects.find((x: any) => x.name === 'Algebra');
    const curriculum = catalog.curricula.find((x: any) => x.name === 'GCSE');
    await api(
      'PATCH',
      '/profile/me',
      teacher.accessToken,
      { teacherSubjectIds: null },
      400,
    );
    await api(
      'PATCH',
      '/profile/me',
      teacher.accessToken,
      { teacherSubjectIds: ['000000000000000000000000'] },
      400,
    );
    await api(
      'PATCH',
      '/profile/me',
      teacher.accessToken,
      { publicProfileEnabled: true },
      403,
    );
    const draft = {
      displayName: 'Alex Morgan',
      headline: 'Making maths make sense, one lesson at a time',
      bio: 'I help students build confidence in maths through clear explanations, practical examples, and patient support. Every lesson starts with what you understand and builds towards your goals.',
      languages: ['English', 'French'],
      location: 'Berlin, Germany',
      timezone: 'Europe/Berlin',
      availability:
        'Monday to Friday, 16:00–20:00. Weekend lessons by arrangement.',
      teacherSubjectIds: [algebra.id],
      curriculumIds: curriculum ? [curriculum.id] : [],
      teachingCountries: ['DE', 'FR', 'GB'],
      learnerAgeGroups: ['children', 'adults'],
      teachingLevels: ['Upper secondary', 'Adult learning'],
      education: [
        {
          title: 'BSc Mathematics',
          issuer: 'Example University',
          year: '2018',
        },
      ],
      credentials: [],
      experience: [
        {
          role: 'Mathematics tutor',
          organization: 'Independent tutoring',
          period: '2018–present',
          summary:
            'Helping secondary school and adult learners develop their mathematical understanding.',
        },
      ],
      assessmentResponses: [
        {
          categoryId: maths.id,
          response:
            'To teach linear equations I start with a balanced scale, then represent equal changes on both sides. For 2x + 3 = 11, we remove three from each side and divide by two. I ask the learner to substitute their answer and explain why equality is preserved.',
        },
      ],
      publicProfileEnabled: false,
    };
    await api('PATCH', '/profile/me', teacher.accessToken, draft);
    const avatar = await request.post(
      `${stack.nodeAUrl}/api/v1/profile/me/avatar`,
      {
        headers: auth(teacher.accessToken),
        multipart: {
          file: {
            name: 'profile.png',
            mimeType: 'image/png',
            buffer: await readFile(
              'apps/frontend/src/assets/brand/sapiovian-mark.png',
            ),
          },
        },
      },
    );
    expect(avatar.status(), await avatar.text()).toBe(201);
    const tc = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
    });
    contexts.push(tc);
    await tc.addInitScript(
      (token) => sessionStorage.setItem('native-sfu.auth.accessToken', token),
      teacher.accessToken,
    );
    const page = await tc.newPage();
    await page.goto(`${stack.frontendBaseUrl}/teacher/profile`);
    await expect(
      page.getByRole('heading', { name: 'Your teaching profile', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '3 Introduction video' }).click();
    await page.locator('.edit-panel').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(screenshotDir, 'teacher-introduction-video.png'),
      fullPage: false,
    });
    await page.locator('.edit-panel').screenshot({
      path: path.join(screenshotDir, 'teacher-video-panel.png'),
    });
    await page.getByRole('button', { name: '2 Subjects & learners' }).click();
    await page.locator('.edit-panel').screenshot({
      path: path.join(screenshotDir, 'teacher-subjects-panel.png'),
    });
    await page.getByRole('button', { name: '1 About you' }).click();
    await page.locator('.edit-panel').screenshot({
      path: path.join(screenshotDir, 'teacher-about-panel.png'),
    });
    await page.getByRole('button', { name: '3 Introduction video' }).click();
    await page
      .getByRole('button', { name: 'Paste a link', exact: true })
      .click();
    await page
      .locator('.edit-panel')
      .screenshot({
        path: path.join(screenshotDir, 'teacher-video-link.png'),
        style: 'sfu-header{visibility:hidden!important}',
      });
    await page
      .getByRole('button', { name: 'Upload video', exact: true })
      .click();
    const app = await api('GET', '/tutor-application/me', teacher.accessToken);
    expect(app.missing.join(' ')).toContain('introduction video');
    await api(
      'POST',
      '/tutor-application/submit',
      teacher.accessToken,
      {
        revision: app.revision,
        adultTutorConfirmed: true,
        codeOfConductAccepted: true,
        safeguardingAccepted: true,
      },
      400,
    );
    const videoPath = info.outputPath('intro.mp4');
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x458B73:s=320x180:r=12',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        videoPath,
      ],
      { stdio: 'ignore' },
    );
    const invalid = await request.post(
      `${stack.nodeAUrl}/api/v1/tutor-application/me/introduction-video`,
      {
        headers: auth(teacher.accessToken),
        multipart: {
          file: {
            name: 'bad.mp4',
            mimeType: 'video/mp4',
            buffer: Buffer.from('not a video'),
          },
        },
      },
    );
    expect(invalid.status()).toBe(400);
    await page.getByRole('button', { name: '3 Introduction video' }).click();
    await page
      .locator('input[type=file][accept="video/mp4,video/webm"]')
      .setInputFiles(videoPath);
    await expect(
      page.getByRole('button', { name: 'Preview video', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Preview video', exact: true })
      .click();
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth),
      )
      .toBe(320);
    const privateRead = await request.get(
      `${stack.nodeAUrl}/api/v1/teachers/${teacherId}/introduction-video`,
    );
    expect(privateRead.status()).toBe(404);
    await api(
      'GET',
      '/tutor-application/me/introduction-video',
      student.accessToken,
      undefined,
      403,
    );
    await page
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Profile updated.' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '6 Review & submit' }).click();
    await page.getByLabel('I am at least 18 years old.').check();
    await page.getByLabel('My profile is accurate.', { exact: false }).check();
    await page
      .getByLabel('I will follow safeguarding requirements', { exact: false })
      .check();
    await page
      .getByRole('button', { name: 'Submit profile for review' })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Your profile is awaiting review' }),
    ).toBeVisible();
    const submitted = await api(
      'GET',
      '/tutor-application/me',
      teacher.accessToken,
    );
    expect(submitted.status).toBe('submitted');
    await api(
      'POST',
      '/tutor-application/submit',
      teacher.accessToken,
      {
        revision: submitted.revision + 1,
        adultTutorConfirmed: true,
        codeOfConductAccepted: true,
        safeguardingAccepted: true,
      },
      409,
    );
    const approve = {
      decision: 'approved',
      revision: submitted.revision,
      note: 'Profile, video and subject demonstration reviewed.',
      introVideoReviewed: true,
      identityChecked: true,
      teachingSuitabilityChecked: true,
      safeguardingChecked: true,
      assessmentResults: submitted.requiredAssessments.map((a: any) => ({
        categoryId: a.categoryId,
        version: a.version,
        passed: true,
        notes: 'Reviewed worked example and checked subject understanding.',
      })),
    };
    await api(
      'POST',
      `/admin/tutor-applications/${teacherId}/review`,
      admin.accessToken,
      { ...approve, safeguardingChecked: false },
      400,
    );
    await api(
      'POST',
      `/admin/tutor-applications/${teacherId}/review`,
      admin.accessToken,
      { ...approve, introVideoReviewed: false },
      400,
    );
    await api(
      'POST',
      `/admin/tutor-applications/${teacherId}/review`,
      admin.accessToken,
      { ...approve, assessmentResults: [] },
      400,
    );
    await api(
      'POST',
      `/admin/tutor-applications/${teacherId}/review`,
      admin.accessToken,
      { ...approve, revision: submitted.revision + 1 },
      409,
    );
    await api(
      'POST',
      `/admin/tutor-applications/${teacherId}/review`,
      admin.accessToken,
      {
        ...approve,
        assessmentResults: approve.assessmentResults.map((r: any) => ({
          ...r,
          version: r.version + 1,
        })),
      },
      400,
    );
    // Serve the production admin UI and proxy every request to the real backend.
    const root = path.resolve('apps/admin-portal/dist/admin-portal/browser');
    adminServer = createServer(async (req, res) => {
      try {
        if (req.url?.startsWith('/api/')) {
          const upstream = httpRequest(
            new URL(req.url, stack.nodeAUrl),
            {
              method: req.method,
              headers: { ...req.headers, host: new URL(stack.nodeAUrl).host },
            },
            (r) => {
              res.writeHead(r.statusCode || 500, r.headers);
              r.pipe(res);
            },
          );
          upstream.on('error', () => {
            res.statusCode = 502;
            res.end();
          });
          req.pipe(upstream);
          return;
        }
        const pathname = decodeURIComponent(
          new URL(req.url || '/', 'http://local').pathname,
        );
        let file = path.resolve(root, '.' + pathname);
        if (!file.startsWith(root + path.sep)) {
          file = path.join(root, 'index.html');
        }
        if (!(await stat(file).catch(() => null))?.isFile())
          file = path.join(root, 'index.html');
        const types: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.woff2': 'font/woff2',
        };
        res.setHeader(
          'content-type',
          types[path.extname(file)] || 'application/octet-stream',
        );
        res.end(await readFile(file));
      } catch {
        res.statusCode = 500;
        res.end();
      }
    });
    await new Promise<void>((resolve) =>
      adminServer!.listen(4465, '127.0.0.1', resolve),
    );
    const ac = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
    });
    contexts.push(ac);
    await ac.addInitScript(
      (token) =>
        sessionStorage.setItem('native-sfu.admin.auth.accessToken', token),
      admin.accessToken,
    );
    const adminPage = await ac.newPage();
    await adminPage.goto('http://127.0.0.1:4465/teaching-catalog');
    await expect(
      adminPage.getByRole('heading', { name: 'Subjects and categories' }),
    ).toBeVisible();
    await adminPage.screenshot({
      path: path.join(screenshotDir, 'admin-teaching-catalogue.png'),
      fullPage: false,
    });
    await adminPage.goto('http://127.0.0.1:4465/tutor-applications');
    await adminPage.getByRole('button', { name: 'Review Alex Morgan' }).click();
    await adminPage
      .getByRole('button', { name: 'Preview uploaded introduction' })
      .click();
    await expect
      .poll(() =>
        adminPage
          .locator('video')
          .evaluate((v: HTMLVideoElement) => v.videoWidth),
      )
      .toBe(320);
    await adminPage
      .getByLabel('Subject and teaching assessment passed')
      .check();
    await adminPage
      .getByLabel('Assessment findings')
      .fill('Reviewed worked example and checked subject understanding.');
    await adminPage
      .getByLabel('Introduction video watched and suitable')
      .check();
    await adminPage
      .getByLabel('Identity and adult tutor eligibility checked')
      .check();
    await adminPage
      .getByLabel('Subject expertise and teaching suitability checked')
      .check();
    await adminPage
      .getByLabel('Required safeguarding checks completed', { exact: false })
      .check();
    await adminPage.getByLabel('Feedback to tutor').fill(approve.note);
    await adminPage
      .locator('.catalog-editor')
      .screenshot({ path: path.join(screenshotDir, 'admin-tutor-review.png') });
    await adminPage.getByRole('button', { name: 'Approve profile' }).click();
    await expect
      .poll(
        async () =>
          (await api('GET', '/tutor-application/me', teacher.accessToken))
            .status,
      )
      .toBe('approved');
    const publicVideo = await request.get(
      `${stack.nodeAUrl}/api/v1/teachers/${teacherId}/introduction-video`,
      { headers: { Range: 'bytes=0-63' } },
    );
    expect(publicVideo.status()).toBe(206);
    expect((await publicVideo.body()).length).toBe(64);
    expect(publicVideo.headers()['content-type']).toContain('video/mp4');
    const badRange = await request.get(
      `${stack.nodeAUrl}/api/v1/teachers/${teacherId}/introduction-video`,
      { headers: { Range: 'bytes=999999999-' } },
    );
    expect(badRange.status()).toBe(416);
    await page.reload();
    await page.getByRole('button', { name: '6 Review & submit' }).click();
    await expect(
      page.getByRole('heading', { name: 'Your profile is approved' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '3 Introduction video' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.edit-panel').scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.locator('.edit-panel').screenshot({
      path: path.join(screenshotDir, 'teacher-video-mobile.png'),
      style: 'sfu-header{visibility:hidden!important}',
    });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await page
      .locator('.edit-panel')
      .screenshot({
        path: path.join(screenshotDir, 'teacher-video-dark.png'),
        style: 'sfu-header{visibility:hidden!important}',
      });
    await page.getByRole('button', { name: 'Switch to light mode' }).click();
    const published = await api(
      'GET',
      `/teachers/${teacherId}/profile`,
      undefined,
    );
    expect(published.introVideoUploaded).toBe(true);
    const results = await api(
      'GET',
      `/teachers?subjectId=${algebra.id}&categoryId=${maths.id}`,
      undefined,
    );
    expect(results.teachers.map((t: any) => t.teacherId)).toContain(teacherId);
    expect(
      results.teachers.find((t: any) => t.teacherId === teacherId)
        .teacherSubjectIds,
    ).toEqual([algebra.id]);
    expect(published.assessmentResponses).toBeUndefined();
    const publicContext = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
    });
    contexts.push(publicContext);
    const publicPage = await publicContext.newPage();
    await publicPage.goto(`${stack.frontendBaseUrl}/teachers/${teacherId}`);
    await expect
      .poll(() =>
        publicPage
          .locator('video')
          .evaluate((v: HTMLVideoElement) => v.videoWidth),
      )
      .toBe(320);
    await publicPage.screenshot({
      path: path.join(screenshotDir, 'public-tutor-profile.png'),
      fullPage: false,
    });
    await api('PATCH', '/profile/me', teacher.accessToken, {
      introVideoUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    });
    expect(
      (await api('GET', '/tutor-application/me', teacher.accessToken)).status,
    ).toBe('draft');
    await api(
      'GET',
      `/teachers/${teacherId}/profile`,
      undefined,
      undefined,
      404,
    );
    await api(
      'GET',
      '/tutor-application/me/introduction-video',
      teacher.accessToken,
      undefined,
      404,
    );
    await api(
      'PATCH',
      '/profile/me',
      teacher.accessToken,
      { introVideoUrl: 'https://example.com/video' },
      400,
    );
    const created = await api(
      'POST',
      '/admin/teaching-catalog/category',
      admin.accessToken,
      {
        name: 'Acceptance category',
        description: 'Test category',
        status: 'active',
        sortOrder: 99,
      },
      201,
    );
    await api(
      'POST',
      '/admin/teaching-catalog/category',
      admin.accessToken,
      {
        name: 'Acceptance category',
        description: 'Duplicate',
        status: 'active',
        sortOrder: 99,
      },
      409,
    );
    const edited = await api(
      'PATCH',
      `/admin/teaching-catalog/category/${created.id}`,
      admin.accessToken,
      {
        name: 'Acceptance category',
        description: 'Edited by admin',
        status: 'active',
        sortOrder: 99,
        version: created.version,
      },
    );
    await api(
      'PATCH',
      `/admin/teaching-catalog/category/${created.id}`,
      admin.accessToken,
      {
        name: 'Acceptance category',
        description: 'Stale update',
        status: 'active',
        sortOrder: 99,
        version: created.version,
      },
      409,
    );
    await api(
      'POST',
      '/admin/teaching-catalog/starter',
      admin.accessToken,
      {},
      201,
    );
    expect(
      (await api('GET', '/teaching-catalog', undefined)).categories.find(
        (c: any) => c.id === created.id,
      ).description,
    ).toBe('Edited by admin');
    await api(
      'PATCH',
      `/admin/teaching-catalog/category/${maths.id}`,
      admin.accessToken,
      {
        name: maths.name,
        description: maths.description,
        status: 'archived',
        sortOrder: maths.sortOrder,
        version: maths.version,
      },
      409,
    );
    const language = catalog.categories.find(
      (c: any) => c.name === 'Languages',
    );
    await api(
      'PATCH',
      `/admin/teaching-catalog/category/${language.id}`,
      admin.accessToken,
      {
        name: 'Languages and communication',
        description: 'Administrator-edited category',
        version: language.version,
      },
    );
    await api(
      'POST',
      '/admin/teaching-catalog/starter',
      admin.accessToken,
      {},
      201,
    );
    const seededAgain = await api('GET', '/teaching-catalog', undefined);
    expect(seededAgain.categories).toHaveLength(19);
    expect(
      seededAgain.categories.find((c: any) => c.id === language.id).name,
    ).toBe('Languages and communication');
    await page.setViewportSize({ width: 320, height: 740 });
    await page.getByRole('button', { name: '3 Introduction video' }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } catch (error) {
    await writeFile(info.outputPath('stack.log'), stack.getLogs());
    throw error;
  } finally {
    for (const context of contexts) await context.close();
    if (adminServer)
      await new Promise<void>((resolve) => adminServer!.close(() => resolve()));
    await stack.stop();
  }
});
