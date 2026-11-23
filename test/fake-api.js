'use strict';
/**
 * A stand-in for the Converter Studio API on a local port: the routes the nodes use, with the
 * answers the real API gives (https://converter.studio/developers). Every request is kept in
 * `requests`; a test changes a route's answer with `api.route(name, handler)`.
 */
const http = require('node:http');

const GOOD_KEY = 'cvs_live_test_key';

const FORMATS = [
  {
    id: 'docx',
    name: 'DOCX',
    category: 'document',
    extensions: ['docx'],
    to: ['pdf', 'txt', 'odt'],
  },
  {
    id: 'jpg',
    name: 'JPG',
    category: 'image',
    extensions: ['jpg', 'jpeg'],
    to: ['png', 'webp', 'pdf'],
  },
  { id: 'png', name: 'PNG', category: 'image', extensions: ['png'], to: ['jpg', 'webp', 'pdf'] },
  { id: 'mp4', name: 'MP4', category: 'video', extensions: ['mp4'], to: ['webm', 'mp3', 'gif'] },
];

const ACCOUNT = {
  email: 'someone@example.com',
  plan: 'free',
  allApps: false,
  credits: 13,
  allowance: { used: 0, limit: 13, per: 'day' },
  packs: 0,
  renewsAt: null,
  maxFileBytes: 104857600,
  maxMediaSeconds: 1800,
  wallet: null,
};

function errorBody(code, message, params) {
  return { error: { code, message, ...(params ? { params } : {}) } };
}

class FakeApi {
  constructor({ partBytes = 95 * 1024 * 1024 } = {}) {
    this.partBytes = partBytes;
    this.requests = [];
    this.uploads = new Map();
    this.conversions = new Map();
    this.handlers = new Map();
    this.count = 0;
    /** The statuses a new conversion goes through, one per waiting status request. */
    this.steps = ['done'];
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
    this.baseUrl = `${this.origin}/api`;
    return this;
  }

  async stop() {
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }

  reset() {
    this.requests = [];
    this.uploads.clear();
    this.conversions.clear();
    this.handlers.clear();
    this.steps = ['done'];
  }

  /** Answers a route (`'POST /v1/conversions'`…) with `handler(request)` instead. */
  route(name, handler) {
    this.handlers.set(name, handler);
  }

  calls(name) {
    return this.requests.filter((request) => request.name === name);
  }

  view(conversion) {
    const done = conversion.status === 'done';
    return {
      id: conversion.id,
      status: conversion.status,
      from: conversion.from,
      to: conversion.to,
      inputName: conversion.inputName,
      inputSize: conversion.inputSize,
      credits: conversion.credits,
      maxCredits: conversion.maxCredits,
      progress: conversion.status === 'processing' ? 40 : null,
      outputName: done ? conversion.outputName : null,
      outputSize: done ? conversion.output.length : null,
      downloadUrl: done
        ? `${this.origin}/api/jobs/${conversion.id}/download?token=dl_${conversion.id}`
        : null,
      expiresAt: done ? '2026-11-23T12:00:00.000Z' : null,
      error: conversion.status === 'failed' ? (conversion.failWith ?? null) : null,
      next: done ? 'Download the result from downloadUrl.' : 'Wait for it.',
    };
  }

  newConversion(body, extra = {}) {
    const id = body.uploadId ?? `conv_${String(++this.count).padStart(8, '0')}`;
    const upload = body.uploadId ? this.uploads.get(body.uploadId) : undefined;
    const from = upload?.format ?? (body.url ? body.url.split('.').pop().toLowerCase() : null);
    const base = (upload?.name ?? body.url?.split('/').pop() ?? 'file').replace(/\.[^.]+$/, '');
    const conversion = {
      id,
      status: 'queued',
      from,
      to: body.to,
      inputName: upload?.name ?? null,
      inputSize: upload?.bytes.length ?? null,
      credits: 1,
      maxCredits: body.maxCredits ?? 20,
      outputName: `${base}.${body.to}`,
      output: Buffer.from(`converted ${from} to ${body.to}`),
      steps: [...this.steps],
      ...extra,
    };
    this.conversions.set(id, conversion);
    return conversion;
  }

  send(res, status, body, headers = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(text);
  }

  async handle(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/^\/api/, '');
    let name = `${req.method} ${path}`;
    if (/^\/v1\/uploads\/[^/]+$/.test(path)) name = `${req.method} /v1/uploads/:id`;
    else if (/^\/v1\/conversions\/[^/]+\/confirm$/.test(path))
      name = `${req.method} /v1/conversions/:id/confirm`;
    else if (/^\/v1\/conversions\/[^/]+$/.test(path)) name = `${req.method} /v1/conversions/:id`;
    else if (/^\/jobs\/[^/]+\/download$/.test(path)) name = `${req.method} /jobs/:id/download`;
    let body;
    if ((req.headers['content-type'] ?? '').includes('json') && raw.length)
      body = JSON.parse(raw.toString('utf8'));
    const request = {
      name,
      method: req.method,
      path,
      query: url.searchParams,
      headers: req.headers,
      body,
      raw,
    };
    this.requests.push(request);

    const handler = this.handlers.get(name);
    if (handler) {
      const answer = await handler(request, this);
      if (answer === 'destroy') {
        req.socket.destroy();
        return;
      }
      if (answer) {
        this.send(res, answer.status, answer.body, answer.headers);
        return;
      }
    }
    this.defaultRoute(request, res);
  }

  authorised(request) {
    return request.headers.authorization === `Bearer ${GOOD_KEY}`;
  }

  defaultRoute(request, res) {
    const { name, path } = request;
    const needsKey = !['GET /v1/formats', 'PUT /v1/uploads/:id', 'GET /jobs/:id/download'].includes(
      name,
    );
    if (needsKey && !this.authorised(request)) {
      this.send(
        res,
        401,
        errorBody(
          'invalidApiKey',
          'The API key is not valid. Make a new one on your account page.',
        ),
      );
      return;
    }
    if (name === 'GET /v1/account') return this.send(res, 200, ACCOUNT);
    if (name === 'GET /v1/formats') {
      const from = request.query.get('from');
      return this.send(res, 200, {
        formats: from ? FORMATS.filter((format) => format.id === from) : FORMATS,
      });
    }
    if (name === 'POST /v1/uploads') {
      const id = `upl_${String(++this.count).padStart(8, '0')}`;
      const fileName = request.body.fileName;
      const extension = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : null;
      const format = FORMATS.find((entry) => entry.extensions.includes(extension))?.id ?? null;
      this.uploads.set(id, {
        id,
        name: fileName,
        size: request.body.size,
        bytes: Buffer.alloc(0),
        format,
        token: `tok_${id}`,
      });
      return this.send(res, 201, {
        id,
        uploadUrl: `${this.origin}/api/v1/uploads/${id}?token=tok_${id}`,
        method: 'PUT',
        maxBytes: 104857600,
        partBytes: this.partBytes,
        expiresAt: '2026-11-23T12:00:00.000Z',
      });
    }
    if (name === 'PUT /v1/uploads/:id') {
      const id = path.split('/').pop();
      const upload = this.uploads.get(id);
      if (!upload || request.query.get('token') !== upload.token) {
        return this.send(res, 404, errorBody('notFound', 'There is no such upload.'));
      }
      const header = request.headers['upload-offset'];
      const offset = header === undefined ? 0 : Number(header);
      if (offset > upload.bytes.length) {
        return this.send(
          res,
          409,
          errorBody('invalidRequest', 'A part is missing.', { received: upload.bytes.length }),
        );
      }
      upload.bytes = Buffer.concat([upload.bytes.subarray(0, offset), request.raw]);
      if (upload.bytes.length < upload.size) {
        return this.send(res, 200, { id, status: 'partial', received: upload.bytes.length });
      }
      return this.send(res, 200, {
        id,
        status: 'ready',
        file: { name: upload.name, size: upload.bytes.length, format: upload.format },
      });
    }
    if (name === 'POST /v1/conversions') {
      const conversion = this.newConversion(request.body);
      return this.send(res, 201, this.view(conversion));
    }
    const id = path.split('/')[3] ?? path.split('/')[2];
    if (name === 'GET /v1/conversions/:id') {
      const conversion = this.conversions.get(id);
      if (!conversion)
        return this.send(res, 404, errorBody('notFound', "There's no conversion with that ID."));
      if (Number(request.query.get('wait') ?? 0) > 0 && conversion.steps.length) {
        conversion.status = conversion.steps.shift();
      }
      return this.send(res, 200, this.view(conversion));
    }
    if (name === 'POST /v1/conversions/:id/confirm') {
      const conversion = this.conversions.get(id);
      if (!conversion)
        return this.send(res, 404, errorBody('notFound', "There's no conversion with that ID."));
      conversion.status = 'queued';
      return this.send(res, 200, this.view(conversion));
    }
    if (name === 'GET /jobs/:id/download') {
      const jobId = path.split('/')[2];
      const conversion = this.conversions.get(jobId);
      if (!conversion || request.query.get('token') !== `dl_${jobId}`) {
        return this.send(res, 404, { error: 'notFound' });
      }
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${conversion.outputName}"`,
        'Content-Length': conversion.output.length,
      });
      res.end(conversion.output);
      return;
    }
    this.send(res, 404, errorBody('notFound', 'No such route.'));
  }
}

module.exports = { ACCOUNT, FORMATS, FakeApi, GOOD_KEY, errorBody };
