'use strict';
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FakeApi, GOOD_KEY } = require('./fake-api');
const {
  everythingLogged,
  helper,
  lastStatus,
  loadNode,
  run,
  startServer,
  stopServer,
} = require('./helpers');
const { version } = require('../package.json');

const CONVERT = 'converter-studio-convert';
const CLIENT = `node-red/${version}`;

describe('convert node', () => {
  let api;
  let tmp;

  before(async () => {
    api = await new FakeApi().start();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-node-red-'));
  });
  after(async () => {
    await api.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    api.reset();
    await startServer();
  });
  afterEach(async () => {
    await helper.unload();
    await stopServer();
  });

  it('converts a Buffer and sends the file on, with its name and type', async () => {
    api.steps = ['processing', 'done'];
    const nodes = await loadNode(api, CONVERT, { to: 'pdf', toType: 'str' });
    const { message } = await run(nodes, {
      payload: Buffer.from('a word document'),
      filename: '/data/in/report.docx',
      topic: 'kept',
    });
    assert.ok(message, 'the message came out');
    assert.ok(Buffer.isBuffer(message.payload));
    assert.equal(message.payload.toString(), 'converted docx to pdf');
    assert.equal(message.filename, 'report.pdf');
    assert.equal(message.contentType, 'application/pdf');
    assert.equal(message.topic, 'kept');
    assert.equal(message.conversion.status, 'done');
    assert.equal(message.conversion.from, 'docx');
    assert.match(message.conversion.downloadUrl, /\/download\?token=/);

    const [slot] = api.calls('POST /v1/uploads');
    assert.deepEqual(slot.body, { fileName: 'report.docx', size: 15 });
    const [put] = api.calls('PUT /v1/uploads/:id');
    assert.equal(put.raw.toString(), 'a word document');
    assert.equal(put.headers['upload-offset'], undefined, 'one request, no offset');
    const [create] = api.calls('POST /v1/conversions');
    assert.deepEqual(create.body, { to: 'pdf', maxCredits: 20, uploadId: create.body.uploadId });
    assert.match(create.body.uploadId, /^upl_/);
    assert.match(create.headers['idempotency-key'], /^node-red-[0-9a-f-]{36}$/);
    assert.ok(
      api.calls('GET /v1/conversions/:id').every((call) => Number(call.query.get('wait')) > 0),
    );

    for (const request of api.requests) {
      assert.equal(
        request.headers['x-converter-studio-client'],
        CLIENT,
        `${request.name} names the client`,
      );
      const withKey = ![
        'PUT /v1/uploads/:id',
        'GET /jobs/:id/download',
        'GET /v1/formats',
      ].includes(request.name);
      assert.equal(
        request.headers.authorization,
        withKey ? `Bearer ${GOOD_KEY}` : undefined,
        `${request.name}: key only to the API`,
      );
    }
    const texts = nodes.node.status
      .getCalls()
      .filter((call) => call.thisValue === nodes.node)
      .map((call) => call.args[0].text);
    assert.deepEqual(texts, [
      'uploading',
      'starting',
      'queued',
      'converting 40%',
      'downloading',
      'done: pdf',
    ]);
    assert.deepEqual(lastStatus(nodes.node), { fill: 'green', shape: 'dot', text: 'done: pdf' });
  });

  it('reads a file from a path, absolute or relative to the working directory', async () => {
    fs.writeFileSync(path.join(tmp, 'photo.jpg'), 'jpeg bytes');
    helper.settings({ fileWorkingDirectory: tmp });
    try {
      for (const payload of [path.join(tmp, 'photo.jpg'), 'photo.jpg']) {
        api.reset();
        const nodes = await loadNode(api, CONVERT, { to: 'webp', toType: 'str' });
        // A leftover msg.filename does not rename a file read from a path.
        const { message } = await run(nodes, { payload, filename: '/elsewhere/other.png' });
        assert.equal(message.filename, 'photo.webp');
        const [slot] = api.calls('POST /v1/uploads');
        assert.deepEqual(slot.body, { fileName: 'photo.jpg', size: 10 });
        assert.equal(api.calls('PUT /v1/uploads/:id')[0].raw.toString(), 'jpeg bytes');
        await helper.unload();
      }
    } finally {
      helper.settings({});
    }
  });

  it('reports a file it cannot read', async () => {
    const nodes = await loadNode(api, CONVERT, { to: 'pdf', toType: 'str' });
    const { caught } = await run(nodes, { payload: path.join(tmp, 'missing.docx') });
    assert.equal(caught.error.code, 'fileNotReadable');
    assert.match(caught.error.message, /ENOENT/);
    assert.equal(api.calls('POST /v1/uploads').length, 0);
  });

  it('lets Converter Studio download a link itself', async () => {
    const nodes = await loadNode(api, CONVERT, { to: 'webp', toType: 'str' });
    const { message } = await run(nodes, { payload: 'https://example.com/files/photo.jpg' });
    assert.equal(api.calls('POST /v1/uploads').length, 0);
    assert.deepEqual(api.calls('POST /v1/conversions')[0].body, {
      to: 'webp',
      maxCredits: 20,
      url: 'https://example.com/files/photo.jpg',
    });
    assert.equal(message.filename, 'photo.webp');
  });

  it('refuses a link that is not http or https', async () => {
    const nodes = await loadNode(api, CONVERT, { to: 'pdf', toType: 'str' });
    const { caught } = await run(nodes, { payload: 'ftp://example.com/report.docx' });
    assert.equal(caught.error.code, 'invalidUrl');
    assert.equal(api.requests.length, 0);
  });

  it('reads the target format and the options from the message', async () => {
    const nodes = await loadNode(api, CONVERT, {
      to: 'format',
      toType: 'msg',
      options: 'options',
      optionsType: 'msg',
      maxCredits: '5',
    });
    const { message } = await run(nodes, {
      payload: Buffer.from('jpeg'),
      filename: 'photo.jpg',
      format: '.PNG',
      options: { resizeWidth: 800 },
    });
    assert.equal(message.conversion.to, 'png');
    assert.deepEqual(api.calls('POST /v1/conversions')[0].body, {
      to: 'png',
      maxCredits: 5,
      options: { resizeWidth: 800 },
      uploadId: api.calls('POST /v1/conversions')[0].body.uploadId,
    });
  });

  it('takes the options typed into the node as JSON', async () => {
    const nodes = await loadNode(api, CONVERT, {
      to: 'jpg',
      toType: 'str',
      options: '{"quality":"high","maxKb":300}',
      optionsType: 'json',
    });
    await run(nodes, { payload: Buffer.from('png'), filename: 'logo.png' });
    assert.deepEqual(api.calls('POST /v1/conversions')[0].body.options, {
      quality: 'high',
      maxKb: 300,
    });
  });

  it('refuses options that are not an object, before anything is sent', async () => {
    const nodes = await loadNode(api, CONVERT, {
      to: 'pdf',
      toType: 'str',
      options: 'options',
      optionsType: 'msg',
    });
    const { caught } = await run(nodes, {
      payload: Buffer.from('doc'),
      filename: 'a.docx',
      options: 'quality=high',
    });
    assert.equal(caught.error.code, 'invalidOptions');
    assert.equal(api.requests.length, 0);
  });

  it('sends the download link instead of the file when asked', async () => {
    const nodes = await loadNode(api, CONVERT, { to: 'pdf', toType: 'str', output: 'url' });
    const { message } = await run(nodes, { payload: Buffer.from('doc'), filename: 'a.docx' });
    assert.match(message.payload, /^http:\/\/127\.0\.0\.1:\d+\/api\/jobs\/.+\/download\?token=/);
    assert.equal(message.filename, 'a.pdf');
    assert.equal(api.calls('GET /jobs/:id/download').length, 0);
  });

  it('sends the conversion on at once without waiting, with the callback URL', async () => {
    const nodes = await loadNode(api, CONVERT, {
      to: 'pdf',
      toType: 'str',
      wait: false,
      callbackUrl: 'https://flows.example.com/converter-studio',
      callbackUrlType: 'str',
    });
    const { message } = await run(nodes, { payload: Buffer.from('doc'), filename: 'a.docx' });
    assert.equal(message.payload.status, 'queued');
    assert.equal(message.conversion.id, message.payload.id);
    assert.equal(
      api.calls('POST /v1/conversions')[0].body.callbackUrl,
      'https://flows.example.com/converter-studio',
    );
    assert.equal(api.calls('GET /v1/conversions/:id').length, 0);
    assert.deepEqual(lastStatus(nodes.node), { fill: 'blue', shape: 'ring', text: 'started' });
  });

  it('gives the API message and code of a wrong key to a catch node, and never logs the key', async () => {
    const nodes = await loadNode(
      api,
      CONVERT,
      { to: 'pdf', toType: 'str' },
      { key: 'cvs_live_wrong_key' },
    );
    const { caught } = await run(nodes, { payload: Buffer.from('doc'), filename: 'a.docx' });
    assert.equal(caught.error.code, 'invalidApiKey');
    assert.match(caught.error.message, /^Converter Studio: The API key is not valid\./);
    assert.match(caught.error.message, /converter\.studio\/account#api-keys/);
    assert.equal(caught.error.source.id, 'n1');
    assert.equal(api.calls('POST /v1/conversions').length, 0);
    assert.deepEqual(lastStatus(nodes.node), {
      fill: 'red',
      shape: 'ring',
      text: 'error: invalidApiKey',
    });
    assert.ok(!JSON.stringify(caught).includes('cvs_live_wrong_key'));
    assert.ok(!everythingLogged(nodes.node).includes('cvs_live_wrong_key'));
  });

  it('says so when the config node has no key', async () => {
    const nodes = await loadNode(api, CONVERT, { to: 'pdf', toType: 'str' }, { key: null });
    const { caught } = await run(nodes, { payload: Buffer.from('doc'), filename: 'a.docx' });
    assert.equal(caught.error.code, 'invalidApiKey');
    assert.match(caught.error.message, /has no API key/);
    assert.equal(api.requests.length, 0);
  });

  it('fails the message with the reason of a failed conversion and its ID', async () => {
    api.route('POST /v1/conversions', (request, fake) => ({
      status: 201,
      body: fake.view(
        fake.newConversion(request.body, {
          steps: ['processing', 'failed'],
          failWith: { code: 'damagedFile', message: 'The file is damaged' },
        }),
      ),
    }));
    const nodes = await loadNode(api, CONVERT, { to: 'pdf', toType: 'str' });
    const { caught } = await run(nodes, { payload: Buffer.from('doc'), filename: 'a.docx' });
    assert.equal(caught.error.code, 'damagedFile');
    assert.equal(caught.error.message, 'Converter Studio: The file is damaged.');
    assert.equal(caught.conversion.status, 'failed');
    assert.ok(caught.conversion.id);
  });

  it('stops a quoted conversion with an error, or sends the quote on', async () => {
    const quoted = (request, fake) => ({
      status: 201,
      body: fake.view(
        fake.newConversion(request.body, { status: 'quoted', credits: 7, steps: [] }),
      ),
    });
    api.route('POST /v1/conversions', quoted);
    let nodes = await loadNode(api, CONVERT, { to: 'webm', toType: 'str', maxCredits: 5 });
    const { caught } = await run(nodes, { payload: Buffer.from('video'), filename: 'clip.mp4' });
    assert.equal(caught.error.code, 'quoted');
    assert.match(caught.error.message, /costs 7 credits, more than the node's max credits \(5\)/);
    assert.equal(caught.conversion.status, 'quoted');
    await helper.unload();

    api.reset();
    api.route('POST /v1/conversions', quoted);
    nodes = await loadNode(api, CONVERT, {
      to: 'webm',
      toType: 'str',
      maxCredits: 5,
      aboveMax: 'quote',
    });
    const { message } = await run(nodes, { payload: Buffer.from('video'), filename: 'clip.mp4' });
    assert.equal(message.payload.status, 'quoted');
    assert.equal(message.conversion.credits, 7);
    assert.deepEqual(lastStatus(nodes.node), {
      fill: 'yellow',
      shape: 'ring',
      text: 'quoted: 7 credits',
    });
  });

  it('says what a format converts to before anything is charged', async () => {
    const nodes = await loadNode(api, CONVERT, { to: 'mp4', toType: 'str' });
    const { caught } = await run(nodes, { payload: Buffer.from('doc'), filename: 'a.docx' });
    assert.equal(caught.error.code, 'unsupportedConversion');
    assert.match(
      caught.error.message,
      /: Can't convert DOCX to MP4\. DOCX converts to: pdf, txt, odt\./,
    );
    assert.equal(api.calls('POST /v1/conversions').length, 0);
  });

  it('says so when Converter Studio does not recognize the file', async () => {
    const nodes = await loadNode(api, CONVERT, { to: 'pdf', toType: 'str' });
    const { caught } = await run(nodes, { payload: Buffer.from('???'), filename: 'blob.xyz' });
    assert.equal(caught.error.code, 'unknownFormat');
    assert.equal(api.calls('POST /v1/conversions').length, 0);
  });

  it('asks for a file and a target format before it sends anything', async () => {
    let nodes = await loadNode(api, CONVERT, { to: 'pdf', toType: 'str' });
    let { caught } = await run(nodes, { payload: { not: 'a file' } });
    assert.equal(caught.error.code, 'noInput');
    await helper.unload();
    nodes = await loadNode(api, CONVERT, { to: 'format', toType: 'msg' });
    ({ caught } = await run(nodes, { payload: Buffer.from('doc') }));
    assert.equal(caught.error.code, 'noFormat');
    assert.equal(api.requests.length, 0);
  });

  it('waits out a rate limit (Retry-After) and goes on', async () => {
    let first = true;
    api.route('POST /v1/uploads', () => {
      if (!first) return undefined;
      first = false;
      return {
        status: 429,
        headers: { 'Retry-After': '1' },
        body: { error: { code: 'tooManyRequests', message: 'Too many requests' } },
      };
    });
    const nodes = await loadNode(api, CONVERT, { to: 'pdf', toType: 'str' });
    const { message } = await run(nodes, { payload: Buffer.from('doc'), filename: 'a.docx' }, 8000);
    assert.equal(message.conversion.status, 'done');
    assert.equal(api.calls('POST /v1/uploads').length, 2);
  });

  it('sends the conversion request again after a lost connection, with the same Idempotency-Key', async () => {
    let first = true;
    api.route('POST /v1/conversions', () => {
      if (!first) return undefined;
      first = false;
      return 'destroy';
    });
    const nodes = await loadNode(api, CONVERT, { to: 'pdf', toType: 'str' });
    const { message } = await run(
      nodes,
      { payload: Buffer.from('doc'), filename: 'a.docx' },
      10000,
    );
    assert.equal(message.conversion.status, 'done');
    const creates = api.calls('POST /v1/conversions');
    assert.equal(creates.length, 2);
    assert.equal(creates[0].headers['idempotency-key'], creates[1].headers['idempotency-key']);
    assert.equal(api.calls('POST /v1/uploads').length, 1, 'the file went up once');
  });

  it('gives each message a key of its own', async () => {
    const nodes = await loadNode(api, CONVERT, { to: 'pdf', toType: 'str', output: 'url' });
    await run(nodes, { payload: 'https://example.com/a.docx' });
    await run(nodes, { payload: 'https://example.com/a.docx' });
    const [one, two] = api.calls('POST /v1/conversions');
    assert.notEqual(one.headers['idempotency-key'], two.headers['idempotency-key']);
  });

  it('stops waiting after the timeout and names the conversion', async () => {
    api.steps = Array(50).fill('processing');
    const nodes = await loadNode(api, CONVERT, { to: 'pdf', toType: 'str', timeout: 1 });
    const { caught } = await run(nodes, { payload: Buffer.from('doc'), filename: 'a.docx' }, 8000);
    assert.equal(caught.error.code, 'timeout');
    assert.match(
      caught.error.message,
      /wasn't finished after 1 seconds\. It goes on at Converter Studio \(status processing, ID upl_/,
    );
    assert.equal(caught.conversion.status, 'processing');
    assert.match(caught.conversion.id, /^upl_/);
  });

  it('stops waiting when the node is closed, with a warning that names the conversion', async () => {
    api.steps = Array(50).fill('processing');
    const nodes = await loadNode(api, CONVERT, { to: 'pdf', toType: 'str' });
    let caught = false;
    nodes.caught.on('input', () => (caught = true));
    nodes.node.receive({ payload: Buffer.from('doc'), filename: 'a.docx' });
    for (let i = 0; i < 100 && api.calls('GET /v1/conversions/:id').length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await nodes.node.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const warnings = nodes.node.warn.getCalls().filter((call) => call.thisValue === nodes.node);
    assert.equal(warnings.length, 1);
    assert.match(
      String(warnings[0].args[0]),
      /stopped while it waited\. The conversion goes on at Converter Studio \(ID upl_/,
    );
    assert.equal(caught, false);
  });

  it('uploads a large file in parts with Upload-Offset', async () => {
    const parts = await new FakeApi({ partBytes: 1000 }).start();
    try {
      const bytes = Buffer.alloc(2500, 7);
      const file = path.join(tmp, 'big.jpg');
      fs.writeFileSync(file, bytes);
      for (const payload of [bytes, file]) {
        parts.reset();
        const nodes = await loadNode(parts, CONVERT, {
          to: 'png',
          toType: 'str',
          output: 'conversion',
        });
        const { message } = await run(nodes, { payload, filename: 'big.jpg' });
        assert.equal(message.conversion.status, 'done');
        const puts = parts.calls('PUT /v1/uploads/:id');
        assert.deepEqual(
          puts.map((put) => put.headers['upload-offset']),
          ['0', '1000', '2000'],
        );
        assert.deepEqual(
          puts.map((put) => put.raw.length),
          [1000, 1000, 500],
        );
        assert.ok(Buffer.concat(puts.map((put) => put.raw)).equals(bytes));
        await helper.unload();
      }
    } finally {
      await parts.stop();
    }
  });

  it('resumes a parts upload from where Converter Studio says it stopped', async () => {
    const parts = await new FakeApi({ partBytes: 1000 }).start();
    try {
      let dropped = false;
      parts.route('PUT /v1/uploads/:id', (request) => {
        // The second part is lost on the way once: the API then answers the third with a gap
        // (409 with what it has received).
        if (request.headers['upload-offset'] === '1000' && !dropped) {
          dropped = true;
          return { status: 200, body: { id: 'x', status: 'partial', received: 2000 } };
        }
        return undefined;
      });
      const bytes = Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 251));
      const nodes = await loadNode(parts, CONVERT, {
        to: 'png',
        toType: 'str',
        output: 'conversion',
      });
      const { message } = await run(nodes, { payload: bytes, filename: 'big.jpg' });
      assert.equal(message.conversion.status, 'done');
      const offsets = parts.calls('PUT /v1/uploads/:id').map((put) => put.headers['upload-offset']);
      assert.deepEqual(offsets, ['0', '1000', '2000', '1000', '2000']);
      assert.ok(parts.uploads.values().next().value.bytes.equals(bytes));
    } finally {
      await parts.stop();
    }
  });

  it('works on several messages at once', async () => {
    const nodes = await loadNode(api, CONVERT, { to: 'pdf', toType: 'str', output: 'url' });
    const results = [];
    nodes.out.on('input', (msg) => results.push(msg));
    for (const name of ['a.docx', 'b.docx', 'c.docx'])
      nodes.node.receive({ payload: Buffer.from(name), filename: name });
    for (let i = 0; i < 200 && results.length < 3; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(results.map((msg) => msg.filename).sort(), ['a.pdf', 'b.pdf', 'c.pdf']);
    assert.equal(
      new Set(api.calls('POST /v1/conversions').map((call) => call.headers['idempotency-key']))
        .size,
      3,
    );
  });
});
