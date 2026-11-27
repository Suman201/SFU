'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { startBookingStack } = require('../browser/helpers/booking-stack.cjs');
test('English product expansion preserves support, publication and financial boundaries', { timeout: 180000 }, async t => {
  const stack = await startBookingStack(); t.after(() => stack.stop());
  const { app, connection, users } = stack, db = connection.db, config = app.get(require('@nestjs/config').ConfigService), tokens = {};
  const root = await mkdtemp('/tmp/sfu-expansion-test-'); config.set('profileMedia.localPath', root); t.after(() => rm(root, { recursive: true, force: true }));
  const commerce = app.get(require('../../apps/backend/dist/promotions/promotion-commerce.service.js').PromotionCommerceService);
  const gateway = app.get(require('../../apps/backend/dist/promotions/promotion-stripe.gateway.js').PromotionStripeGateway);
  await commerce.onModuleDestroy();
  await require('../../scripts/setup-cms.cjs').setupCmsIndexes(connection); await require('../../scripts/setup-cms.cjs').setupCmsIndexes(connection);
  await require('../../scripts/setup-promotions.cjs').setupPromotionIndexes(connection); await require('../../scripts/setup-promotions.cjs').setupPromotionIndexes(connection);
  async function api(name, method, path, body, expected = method === 'POST' ? 201 : 200) {
    const response = await fetch(stack.origin + '/api/v1/' + path, { method, headers: { ...(tokens[name] ? { authorization: 'Bearer ' + tokens[name] } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); assert.equal(response.status, expected, path + ': ' + text); const result = text ? JSON.parse(text) : undefined; return result?.data ?? result;
  }
  for (const name of Object.keys(users)) tokens[name] = (await api('', 'POST', 'auth/login', { email: users[name].email, password: stack.password }, 200)).accessToken;
  await t.test('teachers own private platform tickets and students can continue conversations', async () => {
    const ticket = await api('teacher','POST','teacher/support/requests',{ issueType:'other', subject:'Help with teacher account', message:'Please review my account settings.' });
    assert.equal(ticket.requesterRole, 'teacher');
    await api('secondTeacher','GET','teacher/support/requests/' + ticket.requestId,undefined,404);
    await api('student','GET','teacher/support/requests',undefined,403);
    await api('teacher','POST','teacher/support/requests/' + ticket.requestId + '/replies',{ expectedUpdatedAt:ticket.updatedAt, status:'resolved' },403);
    const answered = await api('admin','PATCH','admin/support-requests/' + ticket.requestId,{ response:'Public support answer', internalNote:'Staff-only sensitive note', status:'waiting_for_student' });
    const owned = await api('teacher','GET','teacher/support/requests/' + ticket.requestId); assert.doesNotMatch(JSON.stringify(owned),/Staff-only/); assert.equal(owned.comments.length,1);
    const reply = await api('teacher','POST','teacher/support/requests/' + ticket.requestId + '/replies',{ message:'Thank you, here is more detail.', expectedUpdatedAt:owned.updatedAt }); assert.equal(reply.comments.length,2);
    await api('teacher','POST','teacher/support/requests/' + ticket.requestId + '/replies',{ message:'Stale draft', expectedUpdatedAt:owned.updatedAt },409);
    const student = await api('student','POST','support/requests',{ issueType:'other',subject:'Follow up after learning',message:'I need some help after the session.' });
    await api('other','POST','support/requests/' + student.requestId + '/replies',{message:'Not mine',expectedUpdatedAt:student.updatedAt},404);
    const result = await api('student','POST','support/requests/' + student.requestId + '/replies',{ message:'Additional details from student.',expectedUpdatedAt:student.updatedAt }); assert.equal(result.comments.length,1);
    await api('admin','PATCH','admin/support-requests/' + student.requestId,{status:'closed'});
    const closed = await api('student','GET','support/requests/' + student.requestId); await api('student','POST','support/requests/' + student.requestId + '/replies',{message:'Closed reply',expectedUpdatedAt:closed.updatedAt},409);
    await api('teacher','POST','teacher/support/requests',{issueType:'other',subject:'Wrong context',message:'Cannot access a student room.',batchId:randomUUID()},404);
  });
  await t.test('current class owners see relevant tickets with private diagnostics and staff notes removed',async()=>{
    const batchId=randomUUID(); await db.collection('batches').insertOne({_id:batchId,teacherId:users.teacher.id,name:'Support ownership fixture',status:'ACTIVE'});
    const ticket=await api('student','POST','support/requests',{issueType:'class_issue',subject:'Follow up on class',message:'Please explain this lesson.',diagnostics:{userAgent:'Private browser diagnostics'}});
    await db.collection('class_session_support_requests').updateOne({requestId:ticket.requestId},{$set:{batchId,teacherId:users.teacher.id}});
    await api('admin','PATCH','admin/support-requests/'+ticket.requestId,{internalNote:'Sensitive staff-only class note',assignedToName:'Internal assignee'});
    const detail=await api('teacher','GET','teacher/support/requests/'+ticket.requestId); assert.doesNotMatch(JSON.stringify(detail),/student@booking|Private browser|Sensitive staff|Internal assignee/);
    assert.equal((await api('teacher','GET','teacher/support/requests?view=class')).total,1);
    await api('teacher','POST','teacher/support/requests/'+ticket.requestId+'/replies',{message:'Here is the teacher answer.',status:'resolved',expectedUpdatedAt:detail.updatedAt});
    assert.match(JSON.stringify(await api('student','GET','support/requests/'+ticket.requestId)),/teacher answer/);
    await db.collection('batches').updateOne({_id:batchId},{$set:{teacherId:users.secondTeacher.id}});
    await api('teacher','GET','teacher/support/requests/'+ticket.requestId,undefined,404);
    assert.equal((await api('teacher','GET','teacher/support/requests?view=class')).total,0);
    assert.equal((await api('secondTeacher','GET','teacher/support/requests?view=class')).total,1);
  });
  let image;
  await t.test('media stays private until publication, metadata uses revisions and archives preserve pages', async () => {
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=','base64');
    async function upload(data,name='sample.png',expected=201) { const form = new FormData(); form.set('title','Teaching image'); form.set('altText','A sample teaching image'); form.set('file',new Blob([data],{type:'image/png'}),name); const response=await fetch(stack.origin+'/api/v1/admin/cms/media',{method:'POST',headers:{authorization:'Bearer '+tokens.admin},body:form}); const body=await response.json(); assert.equal(response.status,expected,JSON.stringify(body)); return body.data; }
    image=await upload(bytes); assert.equal((await upload(bytes)).id,image.id); await upload(Buffer.from('<svg onload="alert(1)"></svg>'),'fake.png',400);
    assert.equal((await fetch(stack.origin+image.url)).status,404);
    const draft=await api('admin','POST','admin/cms/pages',{title:'Media test page',slug:'expansion-media',pageType:'page',audience:'public',locale:'en',sections:[{type:'hero',title:'Media test',imageUrl:image.url,imageAlt:'Published alternate text'}]});
    const published=await api('admin','POST','admin/cms/pages/'+draft.pageId+'/publish',{expectedRevision:draft.revision});
    let response=await fetch(stack.origin+image.url); assert.equal(response.status,200); assert.equal(response.headers.get('content-type'),'image/png'); assert.match(response.headers.get('x-content-type-options'),/nosniff/);
    const archived=await api('admin','PATCH','admin/cms/media/'+image.id,{revision:image.revision,archived:true}); assert.equal(archived.archived,true);
    await api('admin','PATCH','admin/cms/media/'+image.id,{revision:image.revision,title:'Stale metadata'},409); await upload(bytes,'sample.png',409);
    assert.equal((await api('admin','GET','admin/cms/media')).total,0); assert.equal((await api('admin','GET','admin/cms/media?archived=true')).total,1); assert.equal((await fetch(stack.origin+image.url)).status,200);
    await api('admin','POST','admin/cms/pages/'+draft.pageId+'/unpublish'); assert.equal((await fetch(stack.origin+image.url)).status,404);
    const privatePage=await api('admin','POST','admin/cms/pages',{title:'Private publication',slug:'private-library',pageType:'page',audience:'student',locale:'en',sections:[{type:'hero',imageUrl:image.url}]});
    const privatePublished=await api('admin','POST','admin/cms/pages/'+privatePage.pageId+'/publish',{expectedRevision:privatePage.revision});
    await api('admin','PATCH','admin/cms/pages/'+privatePage.pageId,{expectedRevision:privatePublished.revision,audience:'public'},409);
    assert.equal((await fetch(stack.origin+image.url)).status,404,'a public working-copy audience cannot expose private published media');

    await api('admin','PATCH','admin/cms/media/'+image.id,{revision:archived.revision,archived:false,altText:''});
  });
  await t.test('managed staff permissions separate content reads, finance reads and price changes',async()=>{
    const mongoose=require('mongoose'), passwordHash=(await db.collection('users').findOne({email:users.teacher.email})).passwordHash;
    for(const [name,permissions] of [['contentReader',['admin:content:read']],['financeReader',['admin:finance:read']]]){
      const roleId=new mongoose.Types.ObjectId(); await db.collection('roles').insertOne({_id:roleId,name,slug:name.toLowerCase(),isSystem:false,status:'active',adminPermissionSlugs:permissions});
      await db.collection('users').insertOne({_id:new mongoose.Types.ObjectId(),name,displayName:name,email:name.toLowerCase()+'@booking.test',roles:['ADMIN'],permissions:[],adminRoleId:String(roleId),passwordHash,status:'active',disabled:false});
      tokens[name]=(await api('','POST','auth/login',{email:name.toLowerCase()+'@booking.test',password:stack.password},200)).accessToken;
    }
    await api('contentReader','GET','admin/promotion-commerce/plans');await api('contentReader','GET','admin/promotion-commerce/orders',undefined,403);
    await api('contentReader','PUT','admin/promotion-commerce/plans/'+randomUUID(),{},403);
    await api('contentReader','GET','admin/cms/media');await api('contentReader','PATCH','admin/cms/media/'+image.id,{revision:0,archived:true},403);
    await api('financeReader','GET','admin/promotion-commerce/orders');await api('financeReader','GET','admin/promotion-commerce/plans',undefined,403);
    await api('financeReader','POST','admin/promotion-commerce/orders/not-owned/refund',{requestId:randomUUID(),reason:'Read only staff must not refund.'},403);
  });
  config.set('promotions.enabled',true); config.set('promotions.webhookSecret','whsec_expansion_test'); config.set('promotions.currencies',['EUR','GBP','USD','INR','JPY']);
  const sessions=new Map(), remoteRefunds=new Map(); let checkoutCalls=0, refundCalls=0, credits=0;
  gateway.checkout=async order=>{checkoutCalls++; if(!sessions.has(order._id)) sessions.set(order._id,{id:'cs_'+order._id,url:'https://checkout.stripe.com/c/pay/'+order._id,status:'open',payment_status:'unpaid',livemode:false,client_reference_id:order._id,metadata:{purpose:'teacher_promotion',orderId:order._id,teacherId:order.teacherId,planId:order.plan.id},currency:order.plan.currency.toLowerCase(),amount_subtotal:order.plan.amountMinor,amount_total:order.plan.amountMinor,total_details:{amount_tax:0,amount_discount:0,amount_shipping:0}});return sessions.get(order._id);};
  gateway.session=async id=>structuredClone([...sessions.values()].find(item=>item.id===id)); gateway.refunds=async intent=>({data:[...remoteRefunds.values()].filter(item=>item.payment_intent===intent),has_more:false});
  gateway.refund=async(intent,amount,id)=>{refundCalls++; if(!remoteRefunds.has(id)) remoteRefunds.set(id,{id:'re_'+id,amount,currency:'jpy',status:'succeeded',payment_intent:intent,created:Math.floor(Date.now()/1000),metadata:{requestId:id}});return remoteRefunds.get(id);};
  gateway.getRefund=async id=>[...remoteRefunds.values()].find(item=>item.id===id); gateway.credit=async()=>{credits++;return{id:'cn_test',number:'CN-TEST',total:101,currency:'jpy'};}; gateway.document=async()=> 'https://invoice.stripe.com/i/test';
  async function plan(currency='JPY',autoApprove=true){const id=randomUUID();return api('admin','PUT','admin/promotion-commerce/plans/'+id,{revision:0,name:'Verified '+currency+' promotion',placement:'marketplace_featured',amountMinor:101,currency,durationDays:7,enabled:true,autoApprove,automaticTax:false});}
  function pay(order){const s=sessions.get(order.id);s.status='complete';s.payment_status='paid';s.payment_intent={id:'pi_'+order.id,status:'succeeded',amount_received:s.amount_total,currency:s.currency,metadata:{...s.metadata},latest_charge:{id:'ch_'+order.id,disputed:false,balance_transaction:{fee:3,currency:s.currency,created:Math.floor(Date.now()/1000)}}};s.invoice={id:'in_'+order.id,number:'PROMO-TEST',hosted_invoice_url:'https://invoice.stripe.com/i/test'};}
  let order, paidPlan;
  await t.test('orders own quotes, prevent duplicate purchases and require verified amount/currency before activation',async()=>{
    paidPlan=await plan(); const input={requestId:randomUUID(),planId:paidPlan.id,revision:paidPlan.revision,expectedAmountMinor:101,startsAt:new Date(Date.now()+48*3600000).toISOString()};
    await api('teacher','POST','teacher/promotion-commerce/orders',{...input,expectedAmountMinor:1},409);
    order=await api('teacher','POST','teacher/promotion-commerce/orders',input); assert.equal((await api('teacher','POST','teacher/promotion-commerce/orders',input)).id,order.id);
    await api('teacher','POST','teacher/promotion-commerce/orders',{...input,startsAt:new Date(Date.now()+72*3600000).toISOString()},409);
    await api('teacher','POST','teacher/promotion-commerce/orders',{...input,requestId:randomUUID()},409);
    await api('other','POST','teacher/promotion-commerce/orders/'+order.id+'/checkout',undefined,403);
    await api('secondTeacher','POST','teacher/promotion-commerce/orders/'+order.id+'/checkout',undefined,404);
    await api('teacher','POST','teacher/promotion-commerce/orders/'+order.id+'/checkout');
    assert.equal((await api('teacher','POST','teacher/promotion-commerce/orders/'+order.id+'/reconcile')).status,'awaiting_payment');
    pay(order); sessions.get(order.id).amount_total=999; assert.equal((await api('teacher','POST','teacher/promotion-commerce/orders/'+order.id+'/reconcile')).status,'review'); assert.equal(await db.collection('teacher_promotions').countDocuments({checkoutOrderId:order.id}),0);
    sessions.get(order.id).amount_total=101; const verified=await api('teacher','POST','teacher/promotion-commerce/orders/'+order.id+'/reconcile'); assert.equal(verified.status,'paid'); assert.equal(verified.totalMinor,101); assert.equal(verified.invoiceReady,true); order=verified;
    await api('teacher','POST','teacher/promotion-commerce/orders/'+order.id+'/reconcile'); assert.equal(await db.collection('teacher_promotions').countDocuments({checkoutOrderId:order.id}),1); assert.equal(await db.collection('ledger_entries').countDocuments({promotionOrderId:order.id,type:'promotion_capture'}),1);
    await api('admin','POST','admin/teacher-promotions/'+order.campaignId+'/confirm-payment',{paymentReference:'manual',feeCents:101},409);
    assert.equal((await api('secondTeacher','GET','teacher/promotion-commerce/orders')).total,0); await api('secondTeacher','GET','teacher/promotion-commerce/orders/'+order.id+'/document',undefined,404);
    const ledger=await db.collection('ledger_entries').find({promotionOrderId:order.id}).toArray(); assert.ok(ledger.every(item=>!item.lines.some(line=>line.account.startsWith('teacher_')))); assert.ok(ledger.every(item=>item.lines.reduce((s,line)=>s+line.debitMinor-line.creditMinor,0)===0));
  });
  await t.test('analytics accepts short-lived campaign tokens, deduplicates events and checks owners',async()=>{
    await db.collection('teacher_promotions').updateOne({promotionId:order.campaignId},{$set:{startsAt:new Date(Date.now()-3600000),status:'active'}});
    const profiles=app.get(require('../../apps/backend/dist/profiles/profiles.service.js').ProfilesService), listing=await profiles.listPublicTeachers({});
    const teacher=listing.teachers.find(item=>item.teacherId===users.teacher.id); assert.ok(teacher.promotionTracking); const token=teacher.promotionTracking.token;
    await api('','POST','promotion-commerce/events',{token,kind:'profile_click'},200); await api('','POST','promotion-commerce/events',{token,kind:'profile_click'},200);
    const report=await api('teacher','GET','teacher/promotion-commerce/analytics/'+order.campaignId); assert.equal(report.impressions,1); assert.equal(report.profileClicks,1);
    await api('secondTeacher','GET','teacher/promotion-commerce/analytics/'+order.campaignId,undefined,404); await api('','POST','promotion-commerce/events',{token:token+'x',kind:'impression'},400);
    await api('teacher','GET','teacher/promotion-commerce/analytics/'+order.campaignId+'?from=2026-99-99',undefined,400);
  });
  await t.test('automatic tax is verified and approval remains explicit when the plan requires it',async()=>{
    const id=randomUUID(), plan=await api('admin','PUT','admin/promotion-commerce/plans/'+id,{revision:0,name:'Reviewed taxable promotion',placement:'search_boost',amountMinor:100,currency:'EUR',durationDays:7,enabled:true,autoApprove:false,automaticTax:true,taxCode:'txcd_10000000'});
    const order=await api('secondTeacher','POST','teacher/promotion-commerce/orders',{requestId:randomUUID(),planId:id,revision:plan.revision,expectedAmountMinor:100,startsAt:new Date(Date.now()+72*3600000).toISOString()});
    await api('secondTeacher','POST','teacher/promotion-commerce/orders/'+order.id+'/checkout'); const session=sessions.get(order.id);session.amount_total=120;session.total_details.amount_tax=20;session.automatic_tax={status:'complete'};pay(order);
    const verified=await api('secondTeacher','POST','teacher/promotion-commerce/orders/'+order.id+'/reconcile');assert.equal(verified.status,'paid');assert.equal(verified.totalMinor,120);assert.equal(verified.taxMinor,20);
    const campaign=await db.collection('teacher_promotions').findOne({promotionId:verified.campaignId});assert.equal(campaign.status,'requested');assert.equal(campaign.approvedByUserId,undefined);
    const journal=await db.collection('ledger_entries').findOne({promotionOrderId:order.id,type:'promotion_capture'});assert.equal(journal.lines.find(line=>line.account==='tax_payable').creditMinor,20);
    const payload=JSON.stringify({id:'evt_expansion',object:'event',type:'checkout.session.completed',livemode:false,data:{object:{...session,payment_intent:'pi_'+order.id}}}),Stripe=require('stripe');
    const signature=Stripe.webhooks.generateTestHeaderString({payload,secret:'whsec_expansion_test'});
    for(const sig of ['invalid',signature,signature]) {const response=await fetch(stack.origin+'/api/v1/promotion-commerce/stripe/webhook',{method:'POST',headers:{'content-type':'application/json','stripe-signature':sig},body:payload});assert.equal(response.status,sig==='invalid'?400:200);}
    await commerce.tick();assert.equal(await db.collection('ledger_entries').countDocuments({promotionOrderId:order.id,type:'promotion_capture'}),1);
  });
  await t.test('full refunds cancel campaigns and reverse platform revenue once with credit notes',async()=>{
    await api('admin','POST','admin/promotion-commerce/orders/'+order.id+'/refund',{requestId:randomUUID(),reason:'Synthetic complete promotion refund.'});
    assert.equal((await api('teacher','POST','teacher/promotion-commerce/orders/'+order.id+'/reconcile')).status,'refunded');
    await api('teacher','POST','teacher/promotion-commerce/orders/'+order.id+'/reconcile'); assert.equal(refundCalls,1); assert.equal(credits,1);
    assert.equal((await db.collection('teacher_promotions').findOne({checkoutOrderId:order.id})).billingStatus,'refunded'); assert.equal(await db.collection('ledger_entries').countDocuments({promotionOrderId:order.id,type:'promotion_refund'}),1);
    assert.equal((await api('teacher','GET','teacher/promotion-commerce/orders/'+order.id+'/credit')).url,'https://invoice.stripe.com/i/test'); assert.equal(await db.collection('promotion_slots').countDocuments({orderId:order.id}),0);
  });
});
