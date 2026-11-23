'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  CLIENT_NAME,
  Client,
  apiError,
  conversionFailed,
  conversionIdOf,
  dispositionName,
  normalizeBaseUrl,
  retryDelay,
  uploadName,
} = require('../nodes/lib/client');
const { version } = require('../package.json');

describe('client', () => {
  it('names the package and its version', () => {
    assert.equal(CLIENT_NAME, `node-red/${version}`);
  });

  it('normalizes the base URL', () => {
    assert.equal(normalizeBaseUrl(''), 'https://converter.studio/api');
    assert.equal(normalizeBaseUrl(undefined), 'https://converter.studio/api');
    assert.equal(
      normalizeBaseUrl(' https://converter.studio/api/ '),
      'https://converter.studio/api',
    );
    assert.equal(
      normalizeBaseUrl('https://converter.studio/api/v1'),
      'https://converter.studio/api',
    );
    assert.equal(normalizeBaseUrl('http://localhost:8080/api'), 'http://localhost:8080/api');
    assert.equal(normalizeBaseUrl('converter.studio'), undefined);
    assert.throws(() => new Client({ baseUrl: 'ftp://x' }), { code: 'invalidBaseUrl' });
  });

  it("turns the API's error body into a message with what to do next", () => {
    const error = apiError(402, {
      error: {
        code: 'notEnoughCredits',
        message: 'This needs 3 credits and you have 1',
        params: { needed: 3 },
      },
    });
    assert.equal(error.code, 'notEnoughCredits');
    assert.equal(error.status, 402);
    assert.deepEqual(error.params, { needed: 3 });
    assert.equal(
      error.message,
      'This needs 3 credits and you have 1. Plans and credit packs: https://converter.studio/pricing.',
    );
    assert.equal(String(error), `Converter Studio: ${error.message}`);
    assert.equal(
      apiError(410, { error: 'fileExpired' }).message.startsWith(
        'The converted file has already been deleted.',
      ),
      true,
    );
    assert.equal(apiError(502, 'Bad gateway').message, 'The API answered with HTTP status 502.');
    assert.equal(apiError(502, 'Bad gateway').code, 'http502');
  });

  it('describes a failed conversion with its own reason', () => {
    const error = conversionFailed({ id: 'upl_12345678', status: 'canceled', error: null });
    assert.equal(error.code, 'canceled');
    assert.equal(error.message, 'The conversion was canceled.');
    assert.equal(error.conversion.id, 'upl_12345678');
    const unexplained = conversionFailed({ id: 'upl_12345678', status: 'failed', error: null });
    assert.equal(
      unexplained.message,
      'The conversion did not succeed. No credits were charged for it.',
    );
    const explained = conversionFailed({
      id: 'upl_12345678',
      status: 'failed',
      error: { code: 'noText', message: 'We couldn’t find any text in this file' },
    });
    assert.equal(explained.code, 'noText');
    assert.equal(
      explained.message,
      'We couldn’t find any text in this file. In Node-RED, that is "ocr": true in the conversion options.',
    );
  });

  it('waits as long as Retry-After or the rate limit reset says, within limits', () => {
    const headers = (entries) => new Headers(entries);
    assert.equal(retryDelay(headers({ 'retry-after': '5' }), 0), 5000);
    assert.equal(retryDelay(headers({ 'retry-after': '0' }), 0), 1000);
    assert.equal(retryDelay(headers({ 'retry-after': '3600' }), 0), 60_000);
    assert.equal(retryDelay(headers({ 'x-ratelimit-reset': '7' }), 0), 7000);
    const date = new Date(Date.now() + 10_000).toUTCString();
    const fromDate = retryDelay(headers({ 'retry-after': date }), 0);
    assert.ok(fromDate > 8000 && fromDate <= 10_000, String(fromDate));
    assert.equal(retryDelay(undefined, 0), 2000);
    assert.equal(retryDelay(undefined, 2), 8000);
    assert.equal(retryDelay(headers({}), 10), 60_000);
  });

  it('keeps file names within the API limit, with their extension', () => {
    assert.equal(uploadName('  report.docx '), 'report.docx');
    assert.equal(uploadName(''), 'file');
    const long = `${'a'.repeat(300)}.docx`;
    assert.equal(uploadName(long).length, 255);
    assert.ok(uploadName(long).endsWith('.docx'));
  });

  it('reads the file name of a Content-Disposition header', () => {
    assert.equal(dispositionName('attachment; filename="report.pdf"'), 'report.pdf');
    assert.equal(
      dispositionName("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"),
      'résumé.pdf',
    );
    assert.equal(dispositionName(undefined), undefined);
  });

  it('takes a conversion ID from a string or an object, and nothing else', () => {
    assert.equal(conversionIdOf('upl_12345678'), 'upl_12345678');
    assert.equal(conversionIdOf({ id: ' upl_12345678 ' }), 'upl_12345678');
    assert.equal(conversionIdOf('short'), undefined);
    assert.equal(conversionIdOf('../../etc/passwd'), undefined);
    assert.equal(conversionIdOf(42), undefined);
  });
});
