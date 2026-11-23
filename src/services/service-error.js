// Expected service failure carrying an HTTP status. Anything else is unexpected.
class ServiceError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.details = details;
  }
}

module.exports = { ServiceError };
