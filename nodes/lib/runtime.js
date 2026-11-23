'use strict';
/**
 * What the runtime nodes of this package share: reading a node property from the message or a
 * context, the API client of a config node, the node's status, the result in the message, and
 * reporting errors to Node-RED (and so to catch nodes).
 */
const {
  Client,
  ConverterStudioError,
  ENDED_WITHOUT_RESULT,
  conversionFailed,
  summary,
} = require('./client');

/** A node property (a typed input), read from the message, a context, the environment or as is. */
function evaluate(RED, node, value, type, msg) {
  return new Promise((resolve, reject) => {
    RED.util.evaluateNodeProperty(value, type, node, msg, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/** The API client of the node's config node; `signal` stops it when the node closes. */
function clientOf(node, signal) {
  const server = node.server;
  if (!server) {
    throw new ConverterStudioError('The node has no config node.', {
      code: 'noConfig',
      hint: 'Open the node and add a Converter Studio config node with your API key.',
    });
  }
  return new Client({
    apiKey: server.credentials?.apiKey,
    baseUrl: server.baseUrl,
    signal,
  });
}

/** Status text is meant to stay short (under about 20 characters). */
const short = (text) => (text.length > 24 ? `${text.slice(0, 23)}…` : text);

/**
 * Keeps track of the messages a node works on, so that closing the node stops them and its
 * status shows how many are still going.
 */
class Tracker {
  constructor(node) {
    this.node = node;
    this.controllers = new Set();
  }

  start() {
    const controller = new AbortController();
    this.controllers.add(controller);
    return controller;
  }

  finish(controller) {
    this.controllers.delete(controller);
  }

  /** The node's status; while other messages are still going, says how many. */
  status(fill, shape, text) {
    const others = this.controllers.size;
    if (fill !== 'blue' && others > 0) {
      this.node.status({ fill: 'blue', shape: 'dot', text: `${others} running` });
      return;
    }
    this.node.status({ fill, shape, text: short(text) });
  }

  progress(view) {
    if (this.controllers.size > 1) {
      this.node.status({ fill: 'blue', shape: 'dot', text: `${this.controllers.size} running` });
      return;
    }
    const label = {
      fetching: 'fetching the file',
      waiting_for_upload: 'uploading',
      measuring: 'measuring',
      queued: 'queued',
      processing:
        typeof view.progress === 'number'
          ? `converting ${Math.round(view.progress)}%`
          : 'converting',
    }[view.status];
    this.node.status({ fill: 'blue', shape: 'dot', text: short(label ?? view.status) });
  }

  close() {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.node.status({});
  }
}

/**
 * Puts a conversion's result into the message, as `output` says: the file as a Buffer
 * (`buffer`), its download link (`url`) or only the conversion (`conversion`).
 */
async function putResult(client, view, output, msg) {
  msg.conversion = summary(view);
  if (view.status !== 'done' || output === 'conversion') {
    msg.payload = msg.conversion;
    return;
  }
  if (output === 'url') {
    msg.payload = view.downloadUrl;
    if (view.outputName) msg.filename = view.outputName;
    return;
  }
  const file = await client.download(view);
  msg.payload = file.buffer;
  msg.filename = file.fileName;
  if (file.contentType) msg.contentType = file.contentType;
  else delete msg.contentType;
}

/** The node's status for a quoted conversion: its price. */
function quotedStatus(view) {
  const price = view.credits === 1 ? '1 credit' : `${view.credits ?? '?'} credits`;
  return ['yellow', 'ring', `quoted: ${price}`];
}

/** Fails the message if a conversion that was started or confirmed ended without a result. */
function checkEnded(view) {
  if (ENDED_WITHOUT_RESULT.has(view.status)) throw conversionFailed(view);
}

/**
 * Reports an error of a message to Node-RED: `done(error)` reaches catch nodes, with
 * `msg.error.code` and `msg.conversion` when the error belongs to a conversion. A node that was
 * closed (a new deploy) only warns, naming the conversion that goes on.
 */
function fail(node, tracker, msg, done, error) {
  if (error?.conversion) msg.conversion = summary(error.conversion);
  if (error?.code === 'stopped') {
    node.warn(error.message);
    done();
    return;
  }
  const failure =
    error instanceof Error ? error : new ConverterStudioError(String(error), { code: 'unknown' });
  tracker.status('red', 'ring', failure.code ? `error: ${failure.code}` : 'error');
  done(failure);
}

module.exports = { Tracker, checkEnded, clientOf, evaluate, fail, putResult, quotedStatus };
