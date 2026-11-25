const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createApiNotFoundHandler,
  createHttpErrorHandler
} = require('../http-error-handlers');

function responseMock() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('API not-found handler returns a safe JSON 404', () => {
  const req = {};
  const res = responseMock();

  createApiNotFoundHandler()(req, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, {
    success: false,
    message: 'API endpoint not found.'
  });
});

test('malformed JSON returns a safe 400 response', () => {
  const res = responseMock();
  const logs = [];
  const handler = createHttpErrorHandler({
    logger: { error: (...args) => logs.push(args) }
  });

  handler({ type: 'entity.parse.failed', message: 'private parser detail' },
    { method: 'POST' }, res, assert.fail);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'Invalid JSON request body.');
  assert.equal(JSON.stringify(res.body).includes('private'), false);
  assert.equal(logs.length, 1);
});

test('oversized JSON returns a safe 413 response', () => {
  const res = responseMock();
  const handler = createHttpErrorHandler({
    logger: { error() {} }
  });

  handler({ type: 'entity.too.large' }, { method: 'POST' }, res, assert.fail);

  assert.equal(res.statusCode, 413);
  assert.equal(res.body.message, 'Request body is too large.');
});

test('unexpected errors return a generic 500 without leaking details', () => {
  const res = responseMock();
  const logs = [];
  const handler = createHttpErrorHandler({
    logger: { error: (...args) => logs.push(args) }
  });

  handler(new Error('database password or provider response'),
    { method: 'GET' }, res, assert.fail);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.message, 'An unexpected server error occurred.');
  assert.equal(JSON.stringify(res.body).includes('database'), false);
  assert.equal(JSON.stringify(logs).includes('password'), false);
});

test('errors after headers are sent are passed to the next handler', () => {
  const res = { headersSent: true };
  const error = new Error('late failure');
  let forwarded;

  createHttpErrorHandler({ logger: { error() {} } })(
    error,
    { method: 'GET' },
    res,
    nextError => { forwarded = nextError; }
  );

  assert.equal(forwarded, error);
});
