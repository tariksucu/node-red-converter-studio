'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { ConverterStudioError, apiOptions, conversionQuoted } = require('./lib/client');
const {
  Tracker,
  checkEnded,
  clientOf,
  evaluate,
  fail,
  putResult,
  quotedStatus,
} = require('./lib/runtime');

/** What each source format converts to, kept for ten minutes per API address. */
const TARGETS_TTL_MS = 10 * 60 * 1000;
const targets = new Map();

async function targetsOf(client, from) {
  const key = `${client.baseUrl} ${from}`;
  const entry = targets.get(key);
  if (entry && entry.until > Date.now()) return entry.formats;
  const formats = await client.formats(from);
  targets.set(key, { until: Date.now() + TARGETS_TTL_MS, formats });
  return formats;
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

module.exports = function (RED) {
  /** Converts a file (a Buffer, a file path or a link) to another format with Converter Studio. */
  function ConverterStudioConvertNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.server = RED.nodes.getNode(config.server);
    const tracker = new Tracker(node);
    const maxCredits = Number.parseInt(config.maxCredits, 10);
    const settings = {
      maxCredits: Number.isSafeInteger(maxCredits) && maxCredits >= 0 ? maxCredits : 20,
      aboveMax: config.aboveMax === 'quote' ? 'quote' : 'error',
      wait: config.wait !== false && config.wait !== 'false',
      output: ['buffer', 'url', 'conversion'].includes(config.output) ? config.output : 'buffer',
      timeoutMs: Math.max(1, Number(config.timeout) || 600) * 1000,
    };
    const workingDirectory = RED.settings.fileWorkingDirectory || process.cwd();

    /** The file to convert: a Buffer, a link Converter Studio downloads, or a path on this machine. */
    async function sourceOf(msg) {
      const value = await evaluate(
        RED,
        node,
        config.source || 'payload',
        config.sourceType || 'msg',
        msg,
      );
      let named;
      try {
        named = await evaluate(
          RED,
          node,
          config.fileName ?? 'filename',
          config.fileNameType || 'msg',
          msg,
        );
      } catch {
        named = undefined;
      }
      const nameOf = (fallback) =>
        typeof named === 'string' && named.trim() ? path.basename(named.trim()) : fallback;
      if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return {
          buffer: Buffer.isBuffer(value) ? value : Buffer.from(value),
          fileName: nameOf('file'),
        };
      }
      if (typeof value === 'string' && value.trim()) {
        const text = value.trim();
        if (/^https?:\/\//i.test(text)) return { url: text };
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
          throw new ConverterStudioError(`Can't download from ${text.split(':')[0]}: links.`, {
            code: 'invalidUrl',
            hint: 'Send an https:// link, a file path or the file itself as a Buffer.',
          });
        }
        const file = path.resolve(workingDirectory, text);
        return { path: file, fileName: path.basename(file) };
      }
      throw new ConverterStudioError('There is no file to convert.', {
        code: 'noInput',
        hint: 'Send the file as a Buffer in msg.payload (for example from a read file node set to "a single Buffer object"), or its path, or an https:// link.',
      });
    }

    async function conversionBody(msg) {
      const to = String((await evaluate(RED, node, config.to, config.toType || 'str', msg)) ?? '')
        .trim()
        .toLowerCase()
        .replace(/^\./, '');
      if (!to) {
        throw new ConverterStudioError('The node has no target format.', {
          code: 'noFormat',
          hint: 'Set "Convert to" (for example pdf, jpg or mp4), or send it in the message property the node reads it from.',
        });
      }
      let options = await evaluate(
        RED,
        node,
        config.options ?? '{}',
        config.optionsType || 'json',
        msg,
      );
      if (typeof options === 'string' && options.trim()) {
        try {
          options = JSON.parse(options);
        } catch {
          options = null;
        }
      }
      if (options !== undefined && options !== '' && !isObject(options)) {
        throw new ConverterStudioError('The conversion options must be an object.', {
          code: 'invalidOptions',
          hint: 'For example {"quality": "high"}. The README lists the options.',
        });
      }
      const body = { to, maxCredits: settings.maxCredits };
      if (isObject(options) && Object.keys(options).length) body.options = apiOptions(options);
      if (!settings.wait) {
        const raw = await evaluate(
          RED,
          node,
          config.callbackUrl ?? '',
          config.callbackUrlType || 'str',
          msg,
        );
        const callbackUrl = typeof raw === 'string' ? raw.trim() : '';
        if (callbackUrl) {
          if (!/^https?:\/\/[^/\s?#]+/i.test(callbackUrl)) {
            throw new ConverterStudioError("The callback URL isn't a web address.", {
              code: 'invalidCallbackUrl',
              hint: 'Use an https:// address that can be reached from the internet.',
            });
          }
          body.callbackUrl = callbackUrl;
        }
      }
      return body;
    }

    async function convert(msg, signal) {
      const source = await sourceOf(msg);
      const body = await conversionBody(msg);
      const client = clientOf(node, signal);
      if (source.url) {
        body.url = source.url;
      } else {
        tracker.status('blue', 'dot', 'uploading');
        const upload = await client.uploadFile(source);
        if (!upload.format) {
          throw new ConverterStudioError(`The format of ${upload.name} isn't one it knows.`, {
            code: 'unknownFormat',
            hint: 'Check the file, or give it a file name with its extension (msg.filename).',
          });
        }
        const format = (await targetsOf(client, upload.format)).find(
          (entry) => entry.id === upload.format,
        );
        if (format && !format.to.includes(body.to)) {
          throw new ConverterStudioError(
            `Can't convert ${format.name} to ${body.to.toUpperCase()}.`,
            {
              code: 'unsupportedConversion',
              hint: `${format.name} converts to: ${format.to.join(', ')}.`,
            },
          );
        }
        body.uploadId = upload.id;
      }
      tracker.status('blue', 'dot', 'starting');
      // A key of its own for every message: a request sent again after a lost answer gets the
      // same conversion, charged once.
      let view = await client.createConversion(body, `node-red-${crypto.randomUUID()}`);
      if (!settings.wait) {
        await putResult(client, view, 'conversion', msg);
        return ['blue', 'ring', 'started'];
      }
      tracker.progress(view);
      view = await client.waitFor(view, {
        timeoutMs: settings.timeoutMs,
        onUpdate: (update) => tracker.progress(update),
      });
      checkEnded(view);
      if (view.status === 'quoted') {
        if (settings.aboveMax !== 'quote') throw conversionQuoted(view);
        await putResult(client, view, 'conversion', msg);
        return quotedStatus(view);
      }
      if (settings.output === 'buffer') tracker.status('blue', 'dot', 'downloading');
      await putResult(client, view, settings.output, msg);
      return ['green', 'dot', `done: ${view.to ?? body.to}`];
    }

    node.on('input', async (msg, send, done) => {
      const controller = tracker.start();
      let status;
      try {
        status = await convert(msg, controller.signal);
      } catch (error) {
        tracker.finish(controller);
        fail(node, tracker, msg, done, error);
        return;
      }
      tracker.finish(controller);
      tracker.status(...status);
      send(msg);
      done();
    });

    node.on('close', (done) => {
      tracker.close();
      done();
    });
  }

  RED.nodes.registerType('converter-studio-convert', ConverterStudioConvertNode);
};
