'use strict';
const { Tracker, clientOf, fail } = require('./lib/runtime');

module.exports = function (RED) {
  /** Reads the account of the API key: its plan, the credits left and its limits. */
  function ConverterStudioAccountNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.server = RED.nodes.getNode(config.server);
    const tracker = new Tracker(node);

    node.on('input', async (msg, send, done) => {
      const controller = tracker.start();
      let account;
      try {
        account = await clientOf(node, controller.signal).account();
      } catch (error) {
        tracker.finish(controller);
        fail(node, tracker, msg, done, error);
        return;
      }
      tracker.finish(controller);
      msg.payload = account;
      const credits = Number(account?.credits);
      tracker.status(
        'green',
        'dot',
        Number.isFinite(credits) ? `${credits} ${credits === 1 ? 'credit' : 'credits'}` : 'ok',
      );
      send(msg);
      done();
    });

    node.on('close', (done) => {
      tracker.close();
      done();
    });
  }

  RED.nodes.registerType('converter-studio-account', ConverterStudioAccountNode);
};
