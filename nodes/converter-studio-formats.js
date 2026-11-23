'use strict';
const { Client } = require('./lib/client');
const { Tracker, evaluate, fail } = require('./lib/runtime');

module.exports = function (RED) {
  /** Lists the formats Converter Studio converts and what each converts to. Needs no API key. */
  function ConverterStudioFormatsNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.server = RED.nodes.getNode(config.server);
    const tracker = new Tracker(node);

    node.on('input', async (msg, send, done) => {
      const controller = tracker.start();
      let formats;
      try {
        const from = String(
          (await evaluate(RED, node, config.from ?? '', config.fromType || 'str', msg)) ?? '',
        )
          .trim()
          .toLowerCase()
          .replace(/^\./, '');
        const client = new Client({ baseUrl: node.server?.baseUrl, signal: controller.signal });
        formats = await client.formats(from || undefined);
      } catch (error) {
        tracker.finish(controller);
        fail(node, tracker, msg, done, error);
        return;
      }
      tracker.finish(controller);
      msg.payload = formats;
      tracker.status(
        'green',
        'dot',
        `${formats.length} ${formats.length === 1 ? 'format' : 'formats'}`,
      );
      send(msg);
      done();
    });

    node.on('close', (done) => {
      tracker.close();
      done();
    });
  }

  RED.nodes.registerType('converter-studio-formats', ConverterStudioFormatsNode);
};
