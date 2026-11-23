'use strict';
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ACCOUNT, FakeApi, FORMATS, GOOD_KEY } = require('./fake-api');
const { helper, lastStatus, loadNode, run, startServer, stopServer } = require('./helpers');

describe('config, conversion, account and formats nodes', () => {
  let api;

  before(async () => {
    api = await new FakeApi().start();
  });
  after(async () => {
    await api.stop();
  });
  beforeEach(async () => {
    api.reset();
    await startServer();
  });
  afterEach(async () => {
    await helper.unload();
    await stopServer();
  });

  /** A conversion the fake API already has, as a convert node would have started it. */
  const existing = (extra) => api.newConversion({ uploadId: 'upl_existing1', to: 'pdf' }, extra);

  it('keeps the API key as a credential, apart from the flow', async () => {
    await loadNode(api, 'converter-studio-account');
    const config = helper.getNode('cfg');
    assert.equal(config.credentials.apiKey, GOOD_KEY);
    assert.equal(config.baseUrl, api.baseUrl);
    const flow = helper._redNodes.getFlows().flows.find((node) => node.id === 'cfg');
    assert.equal(JSON.stringify(flow).includes(GOOD_KEY), false);
  });

  it('serves the formats to the editor, from the config node API address', async () => {
    await loadNode(api, 'converter-studio-account');
    const response = await helper
      .request()
      .get('/converter-studio/formats')
      .query({ server: 'cfg' });
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.formats.map((format) => format.id),
      FORMATS.map((format) => format.id),
    );
    assert.deepEqual(Object.keys(response.body.formats[0]).sort(), [
      'category',
      'id',
      'name',
      'to',
    ]);
    assert.equal(
      api.calls('GET /v1/formats')[0].headers.authorization,
      undefined,
      'no key for the formats',
    );
  });

  it('gets a finished conversion with its file', async () => {
    const conversion = existing({ status: 'done', steps: [] });
    const nodes = await loadNode(api, 'converter-studio-conversion', { action: 'get' });
    const { message } = await run(nodes, { conversion: { id: conversion.id } });
    assert.equal(message.payload.toString(), 'converted null to pdf');
    assert.equal(message.filename, conversion.outputName);
    assert.equal(message.conversion.status, 'done');
    assert.equal(
      api.calls('GET /v1/conversions/:id').length,
      1,
      'a finished conversion needs no wait',
    );
  });

  it('reads the ID where it is told to, such as the body of a callback', async () => {
    const conversion = existing({ status: 'done', steps: [] });
    const nodes = await loadNode(api, 'converter-studio-conversion', {
      conversionId: 'payload.conversion.id',
      conversionIdType: 'msg',
      output: 'url',
    });
    const { message } = await run(nodes, {
      payload: {
        event: 'conversion.done',
        id: 'evt_1',
        conversion: { id: conversion.id, status: 'done' },
      },
    });
    assert.match(message.payload, /\/download\?token=/);
  });

  it('without waiting, sends the conversion as it is', async () => {
    const conversion = existing({ status: 'processing', steps: ['done'] });
    const nodes = await loadNode(api, 'converter-studio-conversion', { wait: false });
    const { message } = await run(nodes, { conversion: { id: conversion.id } });
    assert.equal(message.payload.status, 'processing');
    assert.equal(message.conversion.id, conversion.id);
    assert.deepEqual(lastStatus(nodes.node), { fill: 'blue', shape: 'ring', text: 'processing' });
  });

  it('reports a failed conversion it gets, without an error', async () => {
    const conversion = existing({
      status: 'failed',
      steps: [],
      failWith: { code: 'damagedFile', message: 'The file is damaged' },
    });
    const nodes = await loadNode(api, 'converter-studio-conversion');
    const { message } = await run(nodes, { conversion: { id: conversion.id } });
    assert.equal(message.payload.status, 'failed');
    assert.equal(message.conversion.error.code, 'damagedFile');
  });

  it('confirms a quoted conversion, waits and sends the file', async () => {
    const conversion = existing({ status: 'quoted', credits: 7, steps: ['done'] });
    const nodes = await loadNode(api, 'converter-studio-conversion', { action: 'confirm' });
    const { message } = await run(nodes, { conversion: { id: conversion.id } });
    assert.equal(api.calls('POST /v1/conversions/:id/confirm').length, 1);
    assert.equal(message.conversion.status, 'done');
    assert.ok(Buffer.isBuffer(message.payload));
  });

  it('fails a confirmed conversion that fails', async () => {
    const conversion = existing({
      status: 'quoted',
      steps: ['failed'],
      failWith: { code: 'notEnoughCredits', message: 'This needs 7 credits and you have 1' },
    });
    const nodes = await loadNode(api, 'converter-studio-conversion', { action: 'confirm' });
    const { caught } = await run(nodes, { conversion: { id: conversion.id } });
    assert.equal(caught.error.code, 'notEnoughCredits');
    assert.match(
      caught.error.message,
      /This needs 7 credits and you have 1\. Plans and credit packs: https:\/\/converter\.studio\/pricing\./,
    );
  });

  it('asks for a conversion ID, and passes on the API answer for an unknown one', async () => {
    let nodes = await loadNode(api, 'converter-studio-conversion');
    let { caught } = await run(nodes, { conversion: { id: '../../etc' } });
    assert.equal(caught.error.code, 'noConversionId');
    assert.equal(api.requests.length, 0);
    await helper.unload();
    nodes = await loadNode(api, 'converter-studio-conversion');
    ({ caught } = await run(nodes, { conversion: { id: 'upl_unknown1' } }));
    assert.equal(caught.error.code, 'notFound');
    assert.match(caught.error.message, /Conversions are kept for 6 hours/);
  });

  it('reads the account', async () => {
    const nodes = await loadNode(api, 'converter-studio-account');
    const { message } = await run(nodes, { payload: 'go' });
    assert.deepEqual(message.payload, ACCOUNT);
    assert.deepEqual(lastStatus(nodes.node), { fill: 'green', shape: 'dot', text: '13 credits' });
  });

  it('reports a wrong key on the account', async () => {
    const nodes = await loadNode(api, 'converter-studio-account', {}, { key: 'cvs_live_nope' });
    const { caught } = await run(nodes, { payload: 'go' });
    assert.equal(caught.error.code, 'invalidApiKey');
  });

  it('lists every format, or what one converts to', async () => {
    let nodes = await loadNode(api, 'converter-studio-formats');
    let { message } = await run(nodes, {});
    assert.equal(message.payload.length, FORMATS.length);
    assert.deepEqual(lastStatus(nodes.node), { fill: 'green', shape: 'dot', text: '4 formats' });
    await helper.unload();
    nodes = await loadNode(api, 'converter-studio-formats', { from: 'format', fromType: 'msg' });
    ({ message } = await run(nodes, { format: 'JPG' }));
    assert.deepEqual(message.payload, [FORMATS[1]]);
    assert.equal(api.calls('GET /v1/formats').at(-1).query.get('from'), 'jpg');
  });
});
