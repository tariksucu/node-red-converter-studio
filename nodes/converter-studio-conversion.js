'use strict';
const { ConverterStudioError, conversionIdOf } = require('./lib/client');
const {
  Tracker,
  checkEnded,
  clientOf,
  evaluate,
  fail,
  putResult,
  quotedStatus,
} = require('./lib/runtime');

module.exports = function (RED) {
  /**
   * Gets a conversion by its ID (its status, and the result once it is done), or confirms one
   * that was quoted because it costs more than its max credits.
   */
  function ConverterStudioConversionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.server = RED.nodes.getNode(config.server);
    const tracker = new Tracker(node);
    const action = config.action === 'confirm' ? 'confirm' : 'get';
    const wait = config.wait !== false && config.wait !== 'false';
    const output = ['buffer', 'url', 'conversion'].includes(config.output)
      ? config.output
      : 'buffer';
    const timeoutMs = Math.max(1, Number(config.timeout) || 600) * 1000;

    async function run(msg, signal) {
      const value = await evaluate(
        RED,
        node,
        config.conversionId || 'conversion.id',
        config.conversionIdType || 'msg',
        msg,
      );
      const id = conversionIdOf(value);
      if (!id) {
        throw new ConverterStudioError("The node didn't get a Converter Studio conversion ID.", {
          code: 'noConversionId',
          hint: 'Send it in msg.conversion.id (what a convert node outputs), or set where the node reads it from.',
        });
      }
      const client = clientOf(node, signal);
      let view = action === 'confirm' ? await client.confirm(id) : await client.conversion(id);
      if (wait) {
        tracker.progress(view);
        view = await client.waitFor(view, {
          timeoutMs,
          onUpdate: (update) => tracker.progress(update),
        });
      }
      // Confirming a conversion that ends without a result fails the message; getting one
      // only reports it.
      if (action === 'confirm') checkEnded(view);
      if (view.status === 'done' && output === 'buffer')
        tracker.status('blue', 'dot', 'downloading');
      await putResult(client, view, output, msg);
      if (view.status === 'done') return ['green', 'dot', `done: ${view.to ?? ''}`];
      if (view.status === 'quoted') return quotedStatus(view);
      if (view.status === 'failed' || view.status === 'canceled')
        return ['red', 'ring', view.status];
      return ['blue', 'ring', view.status];
    }

    node.on('input', async (msg, send, done) => {
      const controller = tracker.start();
      let status;
      try {
        status = await run(msg, controller.signal);
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

  RED.nodes.registerType('converter-studio-conversion', ConverterStudioConversionNode);
};
