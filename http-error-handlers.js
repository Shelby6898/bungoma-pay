function createApiNotFoundHandler() {
  return (req, res) => {
    res.status(404).json({
      success: false,
      message: 'API endpoint not found.'
    });
  };
}

function createHttpErrorHandler({ logger = console } = {}) {
  return (error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    let status = 500;
    let message = 'An unexpected server error occurred.';

    if (error && error.type === 'entity.parse.failed') {
      status = 400;
      message = 'Invalid JSON request body.';
    } else if (error && error.type === 'entity.too.large') {
      status = 413;
      message = 'Request body is too large.';
    }

    logger.error('HTTP request failed.', {
      method: req.method,
      status
    });

    return res.status(status).json({
      success: false,
      message
    });
  };
}

module.exports = {
  createApiNotFoundHandler,
  createHttpErrorHandler
};
